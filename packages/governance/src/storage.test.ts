import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createMemoryStorage } from "./storage";
import type { StoredAgent, AuditEvent } from "./storage";

function makeAgent(overrides: Partial<StoredAgent> = {}): StoredAgent {
  return {
    id: crypto.randomUUID(),
    name: "test-agent",
    framework: "mastra",
    owner: "team-a",
    version: "1.0.0",
    channels: [],
    tools: ["search"],
    compositeScore: 50,
    governanceLevel: 2,
    status: "approved",
    registeredAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function makeEvent(overrides: Partial<AuditEvent> = {}): AuditEvent {
  return {
    id: crypto.randomUUID(),
    agentId: "agent-1",
    eventType: "tool_call",
    outcome: "success",
    severity: "info",
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

describe("createMemoryStorage", () => {
  test("creates and retrieves an agent", async () => {
    const storage = createMemoryStorage();
    const agent = makeAgent({ id: "a1" });
    await storage.createAgent(agent);
    const found = await storage.getAgent("a1");
    assert.equal(found?.name, "test-agent");
  });

  test("returns null for nonexistent agent", async () => {
    const storage = createMemoryStorage();
    assert.equal(await storage.getAgent("nope"), null);
  });

  test("gets agent by name and owner", async () => {
    const storage = createMemoryStorage();
    await storage.createAgent(makeAgent({ name: "x", owner: "team-1" }));
    await storage.createAgent(makeAgent({ name: "x", owner: "team-2" }));

    const found = await storage.getAgentByName("x", "team-2");
    assert.equal(found?.owner, "team-2");
  });

  test("returns null for nonexistent name/owner combo", async () => {
    const storage = createMemoryStorage();
    await storage.createAgent(makeAgent({ name: "x", owner: "team-1" }));
    assert.equal(await storage.getAgentByName("x", "team-99"), null);
  });

  test("lists all agents", async () => {
    const storage = createMemoryStorage();
    await storage.createAgent(makeAgent({ id: "a1" }));
    await storage.createAgent(makeAgent({ id: "a2" }));
    const list = await storage.listAgents();
    assert.equal(list.length, 2);
  });

  test("lists empty when no agents", async () => {
    const storage = createMemoryStorage();
    assert.deepEqual(await storage.listAgents(), []);
  });

  test("updates an agent", async () => {
    const storage = createMemoryStorage();
    await storage.createAgent(makeAgent({ id: "a1", compositeScore: 50 }));
    const updated = await storage.updateAgent("a1", { compositeScore: 90 });
    assert.equal(updated.compositeScore, 90);
    assert.ok(updated.updatedAt);
  });

  test("throws when updating nonexistent agent", async () => {
    const storage = createMemoryStorage();
    await assert.rejects(
      () => storage.updateAgent("nope", { compositeScore: 90 }),
      { message: "Agent nope not found" },
    );
  });

  test("deletes an agent", async () => {
    const storage = createMemoryStorage();
    await storage.createAgent(makeAgent({ id: "del-1" }));
    await storage.deleteAgent("del-1");
    assert.equal(await storage.getAgent("del-1"), null);
  });

  test("delete preserves other agents", async () => {
    const storage = createMemoryStorage();
    await storage.createAgent(makeAgent({ id: "keep" }));
    await storage.createAgent(makeAgent({ id: "drop" }));
    await storage.deleteAgent("drop");
    const remaining = await storage.listAgents();
    assert.equal(remaining.length, 1);
    assert.equal(remaining[0].id, "keep");
  });

  test("delete preserves audit events", async () => {
    const storage = createMemoryStorage();
    await storage.createAgent(makeAgent({ id: "a-with-events" }));
    await storage.createAuditEvent(makeEvent({ agentId: "a-with-events" }));
    await storage.deleteAgent("a-with-events");
    const events = await storage.queryAuditEvents({ agentId: "a-with-events" });
    assert.equal(events.length, 1);
  });

  test("throws when deleting nonexistent agent", async () => {
    const storage = createMemoryStorage();
    await assert.rejects(
      () => storage.deleteAgent("nope"),
      { message: "Agent nope not found" },
    );
  });

  test("creates and counts audit events", async () => {
    const storage = createMemoryStorage();
    await storage.createAuditEvent(makeEvent());
    await storage.createAuditEvent(makeEvent());
    assert.equal(await storage.countAuditEvents(), 2);
  });

  test("counts with no filters returns all", async () => {
    const storage = createMemoryStorage();
    await storage.createAuditEvent(makeEvent());
    assert.equal(await storage.countAuditEvents(), 1);
  });

  test("queries by agentId", async () => {
    const storage = createMemoryStorage();
    await storage.createAuditEvent(makeEvent({ agentId: "a1" }));
    await storage.createAuditEvent(makeEvent({ agentId: "a2" }));
    const results = await storage.queryAuditEvents({ agentId: "a1" });
    assert.equal(results.length, 1);
    assert.equal(results[0].agentId, "a1");
  });

  test("queries by eventType", async () => {
    const storage = createMemoryStorage();
    await storage.createAuditEvent(makeEvent({ eventType: "tool_call" }));
    await storage.createAuditEvent(makeEvent({ eventType: "registration" }));
    const results = await storage.queryAuditEvents({ eventType: "registration" });
    assert.equal(results.length, 1);
  });

  test("queries by outcome", async () => {
    const storage = createMemoryStorage();
    await storage.createAuditEvent(makeEvent({ outcome: "block" }));
    await storage.createAuditEvent(makeEvent({ outcome: "success" }));
    const results = await storage.queryAuditEvents({ outcome: "block" });
    assert.equal(results.length, 1);
  });

  test("queries by severity", async () => {
    const storage = createMemoryStorage();
    await storage.createAuditEvent(makeEvent({ severity: "warning" }));
    await storage.createAuditEvent(makeEvent({ severity: "info" }));
    const results = await storage.queryAuditEvents({ severity: "warning" });
    assert.equal(results.length, 1);
  });

  test("queries with since filter", async () => {
    const storage = createMemoryStorage();
    await storage.createAuditEvent(makeEvent({ createdAt: "2025-01-01T00:00:00Z" }));
    await storage.createAuditEvent(makeEvent({ createdAt: "2026-01-01T00:00:00Z" }));
    const results = await storage.queryAuditEvents({ since: "2025-06-01T00:00:00Z" });
    assert.equal(results.length, 1);
  });

  test("queries with until filter", async () => {
    const storage = createMemoryStorage();
    await storage.createAuditEvent(makeEvent({ createdAt: "2025-01-01T00:00:00Z" }));
    await storage.createAuditEvent(makeEvent({ createdAt: "2026-01-01T00:00:00Z" }));
    const results = await storage.queryAuditEvents({ until: "2025-06-01T00:00:00Z" });
    assert.equal(results.length, 1);
  });

  test("queries with limit", async () => {
    const storage = createMemoryStorage();
    for (let i = 0; i < 10; i++) {
      await storage.createAuditEvent(makeEvent({ createdAt: `2026-01-${String(i + 1).padStart(2, "0")}T00:00:00Z` }));
    }
    const results = await storage.queryAuditEvents({ limit: 3 });
    assert.equal(results.length, 3);
  });

  test("queries with offset", async () => {
    const storage = createMemoryStorage();
    for (let i = 0; i < 5; i++) {
      await storage.createAuditEvent(makeEvent({ createdAt: `2026-01-${String(i + 1).padStart(2, "0")}T00:00:00Z` }));
    }
    const results = await storage.queryAuditEvents({ offset: 3 });
    assert.equal(results.length, 2);
  });

  test("queries with offset + limit", async () => {
    const storage = createMemoryStorage();
    for (let i = 0; i < 10; i++) {
      await storage.createAuditEvent(makeEvent({ createdAt: `2026-01-${String(i + 1).padStart(2, "0")}T00:00:00Z` }));
    }
    const results = await storage.queryAuditEvents({ offset: 2, limit: 3 });
    assert.equal(results.length, 3);
  });

  test("sorts events by createdAt descending", async () => {
    const storage = createMemoryStorage();
    await storage.createAuditEvent(makeEvent({ createdAt: "2026-01-01T00:00:00Z" }));
    await storage.createAuditEvent(makeEvent({ createdAt: "2026-03-01T00:00:00Z" }));
    await storage.createAuditEvent(makeEvent({ createdAt: "2026-02-01T00:00:00Z" }));
    const results = await storage.queryAuditEvents({});
    assert.equal(results[0].createdAt, "2026-03-01T00:00:00Z");
    assert.equal(results[2].createdAt, "2026-01-01T00:00:00Z");
  });

  test("combines multiple filters", async () => {
    const storage = createMemoryStorage();
    await storage.createAuditEvent(makeEvent({ agentId: "a1", outcome: "block", severity: "warning" }));
    await storage.createAuditEvent(makeEvent({ agentId: "a1", outcome: "success", severity: "info" }));
    await storage.createAuditEvent(makeEvent({ agentId: "a2", outcome: "block", severity: "warning" }));

    const results = await storage.queryAuditEvents({ agentId: "a1", outcome: "block" });
    assert.equal(results.length, 1);
  });

  test("countAuditEvents with filters", async () => {
    const storage = createMemoryStorage();
    await storage.createAuditEvent(makeEvent({ outcome: "block" }));
    await storage.createAuditEvent(makeEvent({ outcome: "block" }));
    await storage.createAuditEvent(makeEvent({ outcome: "success" }));

    assert.equal(await storage.countAuditEvents({ outcome: "block" }), 2);
    assert.equal(await storage.countAuditEvents({ outcome: "success" }), 1);
  });

  test("update preserves other fields", async () => {
    const storage = createMemoryStorage();
    await storage.createAgent(makeAgent({ id: "a1", name: "original", compositeScore: 50 }));
    const updated = await storage.updateAgent("a1", { compositeScore: 90 });
    assert.equal(updated.name, "original");
    assert.equal(updated.compositeScore, 90);
  });
});
