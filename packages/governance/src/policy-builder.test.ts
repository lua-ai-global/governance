import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { when } from "./policy-builder";
import { toYAML, fromYAML } from "./policy-yaml";
import { createGovernance } from "./index";

describe("Policy Builder DSL", () => {
  it("builds a tool block rule", () => {
    const rule = when().tool("shell_exec").then().block("Dangerous tool");
    assert.equal(rule.outcome, "block");
    assert.equal(rule.reason, "Dangerous tool");
    assert.equal(rule.condition.type, "tool_blocked");
    assert.deepEqual(rule.condition.params.tools, ["shell_exec"]);
    assert.equal(rule.enabled, true);
  });

  it("builds a multi-tool block rule", () => {
    const rule = when().tools(["rm", "eval"]).then().block("Blocked tools");
    assert.deepEqual(rule.condition.params.tools, ["rm", "eval"]);
  });

  it("builds an action require_approval rule", () => {
    const rule = when().action("payment").then().requireApproval("Payments need review");
    assert.equal(rule.outcome, "require_approval");
    assert.equal(rule.condition.type, "action_type");
  });

  it("builds a level-below rule", () => {
    const rule = when().level().below(2).then().block("Low trust");
    assert.equal(rule.condition.type, "agent_level");
    assert.equal(rule.condition.params.minLevel, 2);
  });

  it("builds a token budget rule", () => {
    const rule = when().tokenBudget(100_000).then().warn("Approaching budget");
    assert.equal(rule.outcome, "warn");
    assert.equal(rule.condition.type, "token_limit");
  });

  it("builds a rate limit rule", () => {
    const rule = when().rateLimit(50, 60_000).then().block("Rate exceeded");
    assert.equal(rule.condition.type, "rate_limit");
    assert.equal(rule.condition.params.maxActions, 50);
  });

  it("builds an injection guard rule", () => {
    const rule = when().injection(0.4).then().block("Injection detected");
    assert.equal(rule.condition.type, "injection_guard");
    assert.equal(rule.condition.params.threshold, 0.4);
  });

  it("builds a custom condition rule", () => {
    const rule = when().custom("my_check", { threshold: 0.9 }).then().allow("Custom passed");
    assert.equal(rule.condition.type, "my_check");
    assert.equal(rule.outcome, "allow");
  });

  it("supports method chaining for modifiers", () => {
    const rule = when().tool("x").then().block("test")
      .withPriority(100)
      .withStage("preprocess")
      .withId("my-rule")
      .withName("My Rule");

    assert.equal(rule.priority, 100);
    assert.equal(rule.stage, "preprocess");
    assert.equal(rule.id, "my-rule");
    assert.equal(rule.name, "My Rule");
  });

  it("supports disabled()", () => {
    const rule = when().tool("x").then().block("test").disabled();
    assert.equal(rule.enabled, false);
  });

  it("produces rules compatible with createGovernance", async () => {
    const rule = when().tool("danger").then().block("Blocked by DSL");
    const gov = createGovernance({ rules: [rule] });
    const result = await gov.enforce({ agentId: "bot", action: "tool_call", tool: "danger" });
    assert.equal(result.blocked, true);
    assert.equal(result.reason, "Blocked by DSL");
  });
});

describe("Policy YAML", () => {
  it("serializes and deserializes rules roundtrip", () => {
    const rules = [
      when().tool("shell_exec").then().block("Dangerous").withPriority(100).withId("rule-1").withName("Block shell"),
      when().action("payment").then().requireApproval("Review needed").withId("rule-2"),
    ];

    const yaml = toYAML(rules);
    assert.ok(yaml.includes("rule-1"));
    assert.ok(yaml.includes("shell_exec"));
    assert.ok(yaml.includes("block"));

    const parsed = fromYAML(yaml);
    assert.equal(parsed.length, 2);
    assert.equal(parsed[0].id, "rule-1");
    assert.equal(parsed[0].outcome, "block");
    assert.equal(parsed[1].id, "rule-2");
    assert.equal(parsed[1].outcome, "require_approval");
  });

  it("preserves rule properties through roundtrip", () => {
    const original = when().tool("eval").then().block("No eval")
      .withPriority(90).withStage("process").withId("test-rule").withName("No eval rule");

    const yaml = toYAML([original]);
    const [parsed] = fromYAML(yaml);

    assert.equal(parsed.id, "test-rule");
    assert.equal(parsed.name, "No eval rule");
    assert.equal(parsed.outcome, "block");
    assert.equal(parsed.reason, "No eval");
    assert.equal(parsed.priority, 90);
    assert.equal(parsed.stage, "process");
    assert.equal(parsed.enabled, true);
  });

  it("throws on invalid YAML", () => {
    assert.throws(() => fromYAML("not yaml at all"), /Invalid YAML/);
  });

  it("handles rules with quoted strings", () => {
    const rule = when().tool("danger").then().block('Contains "quotes" and: colons').withId("q-rule");
    const yaml = toYAML([rule]);
    const [parsed] = fromYAML(yaml);
    assert.equal(parsed.id, "q-rule");
    assert.ok(parsed.reason.includes("quotes"));
  });
});
