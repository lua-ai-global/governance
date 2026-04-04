import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createPostgresStorage } from "./storage-postgres";
import type { PgPoolLike } from "./storage-postgres";

/**
 * Mock PgPool that stores data in-memory.
 * Tests the adapter logic without requiring a real database.
 */
function createMockPool(): PgPoolLike & { queries: string[] } {
  const tables: Map<string, Record<string, unknown>[]> = new Map();
  const queries: string[] = [];

  return {
    queries,
    async query(text: string, values?: unknown[]) {
      queries.push(text.trim().substring(0, 80));

      // CREATE TABLE / CREATE INDEX — no-op
      if (text.includes("CREATE TABLE") || text.includes("CREATE INDEX")) {
        return { rows: [], rowCount: 0 };
      }

      // Parse table name from INSERT/SELECT/UPDATE
      const insertMatch = text.match(/INSERT INTO (\S+)/);
      const selectMatch = text.match(/SELECT .* FROM (\S+)/);
      const updateMatch = text.match(/UPDATE (\S+)/);

      if (insertMatch) {
        const table = insertMatch[1];
        if (!tables.has(table)) tables.set(table, []);
        const rows = tables.get(table)!;

        // Extract column names and map to values
        const colMatch = text.match(/\(([\s\S]*?)\)\s*VALUES/);
        if (colMatch && values) {
          const cols = colMatch[1].split(",").map((c) => c.trim());
          const row: Record<string, unknown> = {};
          for (let i = 0; i < cols.length; i++) {
            const val = values[i];
            // Parse JSON strings back for JSONB columns
            if (typeof val === "string" && (val.startsWith("[") || val.startsWith("{"))) {
              try { row[cols[i]] = JSON.parse(val); } catch { row[cols[i]] = val; }
            } else {
              row[cols[i]] = val;
            }
          }
          rows.push(row);
        }
        return { rows: [], rowCount: 1 };
      }

      if (selectMatch) {
        const table = selectMatch[1];
        const rows = tables.get(table) ?? [];

        // COUNT query
        if (text.includes("COUNT(*)")) {
          const filtered = applyWhere(rows, text, values ?? []);
          return { rows: [{ count: String(filtered.length) }], rowCount: 1 };
        }

        // WHERE filtering
        let result = applyWhere(rows, text, values ?? []);

        // ORDER BY
        if (text.includes("ORDER BY")) {
          result = [...result]; // already filtered
        }

        // LIMIT
        const limitMatch = text.match(/LIMIT \$(\d+)/);
        if (limitMatch && values) {
          const idx = parseInt(limitMatch[1], 10) - 1;
          const limit = values[idx] as number;
          result = result.slice(0, limit);
        }

        return { rows: result, rowCount: result.length };
      }

      if (updateMatch) {
        const table = updateMatch[1];
        const rows = tables.get(table) ?? [];

        // Find the row by id (last parameter)
        const id = values?.[values.length - 1];
        const row = rows.find((r) => r.id === id);
        if (!row) return { rows: [], rowCount: 0 };

        // Apply updates from SET clauses
        const setMatch = text.match(/SET ([\s\S]*?) WHERE/);
        if (setMatch && values) {
          const assignments = setMatch[1].split(",").map((a) => a.trim());
          for (const assignment of assignments) {
            const [col, paramRef] = assignment.split("=").map((s) => s.trim());
            const paramMatch = paramRef.match(/\$(\d+)/);
            if (paramMatch) {
              const idx = parseInt(paramMatch[1], 10) - 1;
              row[col] = values[idx];
            }
          }
        }

        return { rows: [row], rowCount: 1 };
      }

      return { rows: [], rowCount: 0 };
    },
    async end() {
      // no-op
    },
  };
}

function applyWhere(
  rows: Record<string, unknown>[],
  sql: string,
  values: unknown[],
): Record<string, unknown>[] {
  const whereMatch = sql.match(/WHERE ([\s\S]*?)(?:ORDER|LIMIT|OFFSET|RETURNING|$)/);
  if (!whereMatch) return [...rows];

  const conditions = whereMatch[1].split(" AND ").map((c) => c.trim());
  return rows.filter((row) => {
    return conditions.every((cond) => {
      const eqMatch = cond.match(/(\S+)\s*=\s*\$(\d+)/);
      if (eqMatch) {
        const col = eqMatch[1];
        const idx = parseInt(eqMatch[2], 10) - 1;
        return row[col] === values[idx];
      }
      return true;
    });
  });
}

describe("PostgreSQL Storage Adapter", () => {
  test("auto-migrates on creation", async () => {
    const pool = createMockPool();
    await createPostgresStorage({ pool });
    assert.ok(
      pool.queries.some((q) => q.includes("CREATE TABLE")),
      "should run CREATE TABLE",
    );
  });

  test("skips migration when autoMigrate is false", async () => {
    const pool = createMockPool();
    await createPostgresStorage({ pool, autoMigrate: false });
    assert.ok(
      !pool.queries.some((q) => q.includes("CREATE TABLE")),
      "should not run CREATE TABLE",
    );
  });

  test("createAgent and getAgent roundtrip", async () => {
    const pool = createMockPool();
    const storage = await createPostgresStorage({ pool });

    const agent = {
      id: "test-1",
      name: "test-agent",
      framework: "mastra",
      owner: "team",
      version: "1.0.0",
      channels: ["slack"],
      tools: ["search"],
      compositeScore: 75,
      governanceLevel: 3,
      status: "approved",
      registeredAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    await storage.createAgent(agent);
    const retrieved = await storage.getAgent("test-1");
    assert.ok(retrieved);
    assert.equal(retrieved.name, "test-agent");
    assert.equal(retrieved.framework, "mastra");
  });

  test("getAgentByName finds by name and owner", async () => {
    const pool = createMockPool();
    const storage = await createPostgresStorage({ pool });

    await storage.createAgent({
      id: "a1",
      name: "finder",
      framework: "mastra",
      owner: "team-x",
      version: "1.0.0",
      channels: [],
      tools: [],
      compositeScore: 50,
      governanceLevel: 2,
      status: "registered",
      registeredAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    const found = await storage.getAgentByName("finder", "team-x");
    assert.ok(found);
    assert.equal(found.id, "a1");

    const notFound = await storage.getAgentByName("finder", "wrong-team");
    assert.equal(notFound, null);
  });

  test("listAgents returns all agents", async () => {
    const pool = createMockPool();
    const storage = await createPostgresStorage({ pool });

    for (const id of ["a1", "a2", "a3"]) {
      await storage.createAgent({
        id,
        name: `agent-${id}`,
        framework: "mastra",
        owner: "team",
        version: "1.0.0",
        channels: [],
        tools: [],
        compositeScore: 50,
        governanceLevel: 2,
        status: "registered",
        registeredAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
    }

    const agents = await storage.listAgents();
    assert.equal(agents.length, 3);
  });

  test("updateAgent modifies and returns agent", async () => {
    const pool = createMockPool();
    const storage = await createPostgresStorage({ pool });

    await storage.createAgent({
      id: "u1",
      name: "updatable",
      framework: "mastra",
      owner: "team",
      version: "1.0.0",
      channels: [],
      tools: [],
      compositeScore: 50,
      governanceLevel: 2,
      status: "registered",
      registeredAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    const updated = await storage.updateAgent("u1", {
      status: "quarantined",
      compositeScore: 10,
    });
    assert.ok(updated);
  });

  test("createAuditEvent and queryAuditEvents work", async () => {
    const pool = createMockPool();
    const storage = await createPostgresStorage({ pool });

    await storage.createAuditEvent({
      id: "evt-1",
      agentId: "a1",
      eventType: "policy_evaluation",
      outcome: "allow",
      severity: "info",
      createdAt: new Date().toISOString(),
    });

    await storage.createAuditEvent({
      id: "evt-2",
      agentId: "a1",
      eventType: "agent_killed",
      outcome: "kill_switch",
      severity: "critical",
      createdAt: new Date().toISOString(),
    });

    const all = await storage.queryAuditEvents({ agentId: "a1" });
    assert.equal(all.length, 2);

    const critical = await storage.queryAuditEvents({
      agentId: "a1",
      eventType: "agent_killed",
    });
    assert.equal(critical.length, 1);
    assert.equal(critical[0].severity, "critical");
  });

  test("countAuditEvents returns correct count", async () => {
    const pool = createMockPool();
    const storage = await createPostgresStorage({ pool });

    for (let i = 0; i < 5; i++) {
      await storage.createAuditEvent({
        id: `evt-${i}`,
        agentId: "a1",
        eventType: "test",
        outcome: "ok",
        severity: "info",
        createdAt: new Date().toISOString(),
      });
    }

    const count = await storage.countAuditEvents();
    assert.equal(count, 5);
  });

  test("custom table prefix works", async () => {
    const pool = createMockPool();
    await createPostgresStorage({ pool, tablePrefix: "myapp" });
    assert.ok(
      pool.queries.some((q) => q.includes("myapp_agents")),
      "should use custom prefix",
    );
  });

  test("close calls pool.end()", async () => {
    let endCalled = false;
    const pool: PgPoolLike = {
      async query() { return { rows: [], rowCount: 0 }; },
      async end() { endCalled = true; },
    };

    const storage = await createPostgresStorage({ pool });
    await storage.close();
    assert.equal(endCalled, true);
  });

  test("integrates with createGovernance", async () => {
    // Import here to avoid circular issues at top level
    const { createGovernance, blockTools } = await import("./index");
    const pool = createMockPool();
    const storage = await createPostgresStorage({ pool });

    const gov = createGovernance({
      storage,
      rules: [blockTools(["rm_rf"])],
    });

    const agent = await gov.register({
      name: "pg-agent",
      framework: "mastra",
      owner: "team",
      tools: ["search"],
      hasAuth: true,
    });

    assert.ok(agent.id);
    assert.ok(agent.score > 0);

    const decision = await gov.enforce({
      agentId: agent.id,
      action: "tool_call",
      tool: "rm_rf",
    });
    assert.equal(decision.blocked, true);

    // Verify audit events were persisted
    const count = await storage.countAuditEvents();
    assert.ok(count >= 2, "should have registration + enforcement events");
  });
});
