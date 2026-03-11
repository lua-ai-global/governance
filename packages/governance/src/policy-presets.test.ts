import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  blockTools,
  allowOnlyTools,
  requireApproval,
  tokenBudget,
  rateLimit,
  requireLevel,
  requireSequence,
  timeWindow,
} from "./policy-presets";

describe("policy preset builders", () => {
  describe("blockTools", () => {
    test("creates rule with correct id", () => {
      const rule = blockTools(["rm", "exec"]);
      assert.equal(rule.id, "block-tools-rm-exec");
    });

    test("creates rule with block outcome", () => {
      assert.equal(blockTools(["x"]).outcome, "block");
    });

    test("default reason lists tools", () => {
      const rule = blockTools(["a", "b"]);
      assert.ok(rule.reason.includes("a"));
      assert.ok(rule.reason.includes("b"));
    });

    test("custom reason overrides default", () => {
      const rule = blockTools(["x"], "custom reason");
      assert.equal(rule.reason, "custom reason");
    });

    test("has priority 100", () => {
      assert.equal(blockTools(["x"]).priority, 100);
    });

    test("is enabled by default", () => {
      assert.equal(blockTools(["x"]).enabled, true);
    });

    test("condition type is tool_blocked", () => {
      assert.equal(blockTools(["x"]).condition.type, "tool_blocked");
    });

    test("single tool works", () => {
      const rule = blockTools(["single"]);
      assert.equal(rule.id, "block-tools-single");
    });
  });

  describe("allowOnlyTools", () => {
    test("creates rule with fixed id", () => {
      assert.equal(allowOnlyTools(["a"]).id, "allow-only-tools");
    });

    test("blocks with priority 90", () => {
      const rule = allowOnlyTools(["search"]);
      assert.equal(rule.outcome, "block");
      assert.equal(rule.priority, 90);
    });

    test("condition type is tool_allowed", () => {
      assert.equal(allowOnlyTools(["x"]).condition.type, "tool_allowed");
    });

    test("custom reason works", () => {
      const rule = allowOnlyTools(["x"], "only x allowed");
      assert.equal(rule.reason, "only x allowed");
    });
  });

  describe("requireApproval", () => {
    test("creates rule with require_approval outcome", () => {
      assert.equal(requireApproval(["payment"]).outcome, "require_approval");
    });

    test("uses action_type condition", () => {
      const rule = requireApproval(["payment"]);
      assert.equal(rule.condition.type, "action_type");
    });

    test("id includes action names", () => {
      const rule = requireApproval(["payment", "data_access"]);
      assert.equal(rule.id, "require-approval-payment-data_access");
    });

    test("priority is 80", () => {
      assert.equal(requireApproval(["payment"]).priority, 80);
    });

    test("custom reason works", () => {
      const rule = requireApproval(["payment"], "needs CFO sign-off");
      assert.equal(rule.reason, "needs CFO sign-off");
    });
  });

  describe("tokenBudget", () => {
    test("id includes token count", () => {
      assert.equal(tokenBudget(50000).id, "token-budget-50000");
    });

    test("blocks when exceeded", () => {
      assert.equal(tokenBudget(1000).outcome, "block");
    });

    test("priority is 70", () => {
      assert.equal(tokenBudget(1000).priority, 70);
    });

    test("reason includes formatted count", () => {
      const rule = tokenBudget(100000);
      assert.ok(rule.reason.includes("100,000") || rule.reason.includes("100000"));
    });
  });

  describe("rateLimit", () => {
    test("id includes max and window", () => {
      const rule = rateLimit(10, 60000);
      assert.equal(rule.id, "rate-limit-10-60000");
    });

    test("blocks when exceeded", () => {
      assert.equal(rateLimit(5, 1000).outcome, "block");
    });

    test("priority is 60", () => {
      assert.equal(rateLimit(5, 1000).priority, 60);
    });

    test("reason shows window in seconds", () => {
      const rule = rateLimit(10, 60000);
      assert.ok(rule.reason.includes("60"));
    });
  });

  describe("requireLevel", () => {
    test("id includes level number", () => {
      assert.equal(requireLevel(3).id, "require-level-3");
    });

    test("blocks below minimum", () => {
      assert.equal(requireLevel(2).outcome, "block");
    });

    test("priority is 95", () => {
      assert.equal(requireLevel(2).priority, 95);
    });

    test("reason mentions level", () => {
      assert.ok(requireLevel(3).reason.includes("L3"));
    });
  });

  describe("requireSequence", () => {
    test("id includes tool and prerequisites", () => {
      const rule = requireSequence("delete", ["backup"]);
      assert.equal(rule.id, "sequence-delete-requires-backup");
    });

    test("blocks when prerequisite missing", () => {
      assert.equal(requireSequence("delete", ["backup"]).outcome, "block");
    });

    test("priority is 85", () => {
      assert.equal(requireSequence("delete", ["backup"]).priority, 85);
    });

    test("custom reason works", () => {
      const rule = requireSequence("delete", ["backup"], "safety first");
      assert.equal(rule.reason, "safety first");
    });

    test("multiple prerequisites in id", () => {
      const rule = requireSequence("deploy", ["test", "review"]);
      assert.equal(rule.id, "sequence-deploy-requires-test-review");
    });
  });

  describe("timeWindow", () => {
    test("id includes hours", () => {
      const rule = timeWindow(9, 17);
      assert.equal(rule.id, "time-window-9-17");
    });

    test("blocks outside window", () => {
      assert.equal(timeWindow(9, 17).outcome, "block");
    });

    test("priority is 50", () => {
      assert.equal(timeWindow(9, 17).priority, 50);
    });

    test("custom reason works", () => {
      const rule = timeWindow(9, 17, "business hours only");
      assert.equal(rule.reason, "business hours only");
    });

    test("name shows hour range", () => {
      const rule = timeWindow(9, 17);
      assert.ok(rule.name.includes("9:00"));
      assert.ok(rule.name.includes("17:00"));
    });
  });
});
