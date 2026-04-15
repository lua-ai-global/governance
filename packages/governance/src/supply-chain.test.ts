import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { declareAgentDependencies, validateSupplyChain, createSupplyChainPolicy } from "./supply-chain";
import { createGovernance } from "./index";

describe("Supply Chain Security", () => {
  describe("declareAgentDependencies", () => {
    it("normalizes and deduplicates dependencies", () => {
      const deps = declareAgentDependencies({
        tools: ["search", "email", "search"],
        mcpServers: ["mcp://files"],
      });
      assert.deepEqual(deps.tools, ["email", "search"]); // sorted, deduped
      assert.deepEqual(deps.mcpServers, ["mcp://files"]);
      assert.deepEqual(deps.apiEndpoints, []);
      assert.deepEqual(deps.agents, []);
    });
  });

  describe("validateSupplyChain", () => {
    it("validates all dependencies against approved registry", () => {
      const deps = declareAgentDependencies({ tools: ["search", "email"] });
      const result = validateSupplyChain(deps, { approvedTools: ["search", "email", "calendar"] });
      assert.equal(result.valid, true);
      assert.equal(result.violations.length, 0);
    });

    it("detects unapproved tools", () => {
      const deps = declareAgentDependencies({ tools: ["search", "shell_exec"] });
      const result = validateSupplyChain(deps, { approvedTools: ["search"] });
      assert.equal(result.valid, false);
      assert.equal(result.violations.length, 1);
      assert.equal(result.violations[0].type, "tool");
      assert.equal(result.violations[0].name, "shell_exec");
    });

    it("detects unapproved MCP servers", () => {
      const deps = declareAgentDependencies({ mcpServers: ["mcp://evil.com"] });
      const result = validateSupplyChain(deps, { approvedMcpServers: ["mcp://safe.com"] });
      assert.equal(result.valid, false);
      assert.equal(result.violations[0].type, "mcp_server");
    });

    it("skips validation for categories without approved list", () => {
      const deps = declareAgentDependencies({ tools: ["anything"], apiEndpoints: ["https://any.com"] });
      const result = validateSupplyChain(deps, { approvedTools: ["anything"] });
      assert.equal(result.valid, true); // apiEndpoints not checked
    });
  });

  describe("createSupplyChainPolicy", () => {
    it("creates a policy rule that blocks unapproved tools", async () => {
      const gov = createGovernance({
        rules: [createSupplyChainPolicy({ approvedTools: ["search", "email"] })],
      });

      const blocked = await gov.enforce({
        agentId: "bot-1", action: "tool_call", tool: "shell_exec",
      });
      assert.equal(blocked.blocked, true);

      const allowed = await gov.enforce({
        agentId: "bot-1", action: "tool_call", tool: "search",
      });
      assert.equal(allowed.blocked, false);
    });
  });
});

