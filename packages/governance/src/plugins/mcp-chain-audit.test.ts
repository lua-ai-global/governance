import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createChainAuditor } from "./mcp-chain-audit";

describe("MCP Chain Audit", () => {
  it("records tool calls in sequence", () => {
    const auditor = createChainAuditor();
    auditor.recordCall({ server: "mcp://files", tool: "read_file", agentId: "bot-1" });
    auditor.recordCall({ server: "mcp://files", tool: "write_file", agentId: "bot-1" });

    const chain = auditor.getChain("bot-1");
    assert.equal(chain.length, 2);
    assert.equal(chain[0].sequence, 0);
    assert.equal(chain[1].sequence, 1);
  });

  it("tracks separate chains per agent", () => {
    const auditor = createChainAuditor();
    auditor.recordCall({ server: "mcp://a", tool: "t1", agentId: "bot-1" });
    auditor.recordCall({ server: "mcp://b", tool: "t2", agentId: "bot-2" });

    assert.equal(auditor.getChain("bot-1").length, 1);
    assert.equal(auditor.getChain("bot-2").length, 1);
  });

  it("respects max chain length", () => {
    const auditor = createChainAuditor({ maxChainLength: 3 });
    for (let i = 0; i < 5; i++) {
      auditor.recordCall({ server: "mcp://s", tool: `t${i}`, agentId: "bot" });
    }
    const chain = auditor.getChain("bot");
    assert.equal(chain.length, 3);
    assert.equal(chain[0].tool, "t2"); // oldest dropped
  });

  it("detects cross-server transitions", () => {
    const auditor = createChainAuditor();
    auditor.recordCall({ server: "mcp://files", tool: "read_file", agentId: "bot" });
    auditor.recordCall({ server: "mcp://web", tool: "upload", agentId: "bot" });
    auditor.recordCall({ server: "mcp://web", tool: "confirm", agentId: "bot" });

    const transitions = auditor.getCrossServerTransitions("bot");
    assert.equal(transitions.length, 1);
    assert.equal(transitions[0].from.server, "mcp://files");
    assert.equal(transitions[0].to.server, "mcp://web");
  });

  it("detects suspicious patterns", () => {
    const auditor = createChainAuditor();
    auditor.recordCall({ server: "mcp://files", tool: "read_file", agentId: "bot" });
    auditor.recordCall({ server: "mcp://web", tool: "upload", agentId: "bot" });

    const matches = auditor.detectPatterns("bot");
    assert.ok(matches.length > 0);
    assert.equal(matches[0].patternId, "read-then-exfiltrate");
    assert.equal(matches[0].severity, "high");
  });

  it("detects custom suspicious patterns", () => {
    const auditor = createChainAuditor({
      suspiciousPatterns: [
        { id: "custom-1", description: "Bad combo", sequence: ["list_users", "export_csv"], severity: "critical" },
      ],
    });
    auditor.recordCall({ server: "s", tool: "list_users", agentId: "bot" });
    auditor.recordCall({ server: "s", tool: "export_csv", agentId: "bot" });

    const matches = auditor.detectPatterns("bot");
    assert.equal(matches[0].patternId, "custom-1");
  });

  it("returns no patterns for short chains", () => {
    const auditor = createChainAuditor();
    auditor.recordCall({ server: "s", tool: "t", agentId: "bot" });
    assert.deepEqual(auditor.detectPatterns("bot"), []);
  });

  it("clears chain for an agent", () => {
    const auditor = createChainAuditor();
    auditor.recordCall({ server: "s", tool: "t", agentId: "bot" });
    auditor.clearChain("bot");
    assert.equal(auditor.getChain("bot").length, 0);
  });

  it("reports chain statistics", () => {
    const auditor = createChainAuditor();
    auditor.recordCall({ server: "mcp://a", tool: "t1", agentId: "bot" });
    auditor.recordCall({ server: "mcp://a", tool: "t2", agentId: "bot" });
    auditor.recordCall({ server: "mcp://b", tool: "t1", agentId: "bot" });

    const stats = auditor.stats("bot");
    assert.equal(stats.length, 3);
    assert.equal(stats.servers, 2);
    assert.equal(stats.tools, 2);
    assert.equal(stats.crossServerTransitions, 1);
  });
});
