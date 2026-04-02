import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { generateAnnotationRules, classifyToolRisk, classifyToolsRisk } from "./mcp-annotations";
import type { MCPToolDefinition } from "./mcp-types";

const makeTool = (name: string, annotations?: MCPToolDefinition["annotations"]): MCPToolDefinition => ({
  name,
  inputSchema: { type: "object" },
  annotations,
});

describe("MCP Annotations Governance", () => {
  describe("generateAnnotationRules", () => {
    it("generates require_approval for destructive tools", () => {
      const tools = [makeTool("delete_file", { destructiveHint: true })];
      const rules = generateAnnotationRules(tools);

      assert.ok(rules.length >= 1);
      const rule = rules.find((r) => r.id.includes("destructive"));
      assert.ok(rule);
      assert.equal(rule.outcome, "require_approval");
    });

    it("generates injection guard for open-world tools", () => {
      const tools = [makeTool("web_fetch", { openWorldHint: true, readOnlyHint: true })];
      const rules = generateAnnotationRules(tools);

      const injRule = rules.find((r) => r.id.includes("openworld"));
      assert.ok(injRule);
      assert.equal(injRule.outcome, "block");
      assert.equal(injRule.stage, "preprocess");
    });

    it("skips rules for read-only tools", () => {
      const tools = [makeTool("list_files", { readOnlyHint: true })];
      const rules = generateAnnotationRules(tools);

      const destructiveRules = rules.filter((r) => r.id.includes("destructive"));
      assert.equal(destructiveRules.length, 0);
    });

    it("generates rules for tools with default annotations (no hints)", () => {
      const tools = [makeTool("unknown_tool")];
      const rules = generateAnnotationRules(tools);

      // Default: destructiveHint defaults to true when readOnlyHint is not set
      const destructiveRules = rules.filter((r) => r.id.includes("destructive"));
      assert.ok(destructiveRules.length >= 1);
    });

    it("respects config to disable destructive approval", () => {
      const tools = [makeTool("delete_file", { destructiveHint: true })];
      const rules = generateAnnotationRules(tools, { requireApprovalForDestructive: false });

      const destructiveRules = rules.filter((r) => r.id.includes("destructive"));
      assert.equal(destructiveRules.length, 0);
    });

    it("respects config to disable open-world injection guard", () => {
      const tools = [makeTool("web_fetch", { openWorldHint: true, readOnlyHint: true })];
      const rules = generateAnnotationRules(tools, { injectGuardForOpenWorld: false });

      const injRules = rules.filter((r) => r.id.includes("openworld"));
      assert.equal(injRules.length, 0);
    });

    it("uses custom rule ID prefix", () => {
      const tools = [makeTool("delete_file", { destructiveHint: true })];
      const rules = generateAnnotationRules(tools, { ruleIdPrefix: "custom" });

      assert.ok(rules[0].id.startsWith("custom-"));
    });

    it("handles multiple tools", () => {
      const tools = [
        makeTool("read_file", { readOnlyHint: true }),
        makeTool("delete_file", { destructiveHint: true }),
        makeTool("web_search", { openWorldHint: true, readOnlyHint: true }),
      ];
      const rules = generateAnnotationRules(tools);

      assert.ok(rules.length >= 2); // destructive + openworld rules
    });

    it("gives higher priority to non-idempotent destructive tools", () => {
      const tools = [
        makeTool("delete_once", { destructiveHint: true, idempotentHint: false }),
        makeTool("delete_safe", { destructiveHint: true, idempotentHint: true }),
      ];
      const rules = generateAnnotationRules(tools);

      const nonIdempotent = rules.find((r) => r.id.includes("delete_once"));
      const idempotent = rules.find((r) => r.id.includes("delete_safe"));
      assert.ok(nonIdempotent && idempotent);
      assert.ok(nonIdempotent.priority > idempotent.priority);
    });
  });

  describe("classifyToolRisk", () => {
    it("classifies destructive + open-world as critical", () => {
      const result = classifyToolRisk(makeTool("danger", { destructiveHint: true, openWorldHint: true }));
      assert.equal(result.risk, "critical");
    });

    it("classifies destructive-only as high", () => {
      const result = classifyToolRisk(makeTool("delete", { destructiveHint: true }));
      assert.equal(result.risk, "high");
    });

    it("classifies read-only open-world as medium", () => {
      const result = classifyToolRisk(makeTool("fetch", { openWorldHint: true, readOnlyHint: true }));
      assert.equal(result.risk, "medium");
    });

    it("classifies open-world without readOnly as critical (destructive default)", () => {
      const result = classifyToolRisk(makeTool("fetch", { openWorldHint: true }));
      assert.equal(result.risk, "critical");
    });

    it("classifies read-only as low", () => {
      const result = classifyToolRisk(makeTool("list", { readOnlyHint: true }));
      assert.equal(result.risk, "low");
    });

    it("classifies no annotations as high (destructive by default per MCP spec)", () => {
      const result = classifyToolRisk(makeTool("unknown"));
      assert.equal(result.risk, "high");
    });
  });

  describe("classifyToolsRisk", () => {
    it("classifies multiple tools", () => {
      const results = classifyToolsRisk([
        makeTool("read", { readOnlyHint: true }),
        makeTool("delete", { destructiveHint: true }),
      ]);
      assert.equal(results.length, 2);
      assert.equal(results[0].risk, "low");
      assert.equal(results[1].risk, "high");
    });
  });
});
