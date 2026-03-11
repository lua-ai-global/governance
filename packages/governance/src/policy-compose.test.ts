import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  composePolicies,
  securityBaseline,
  complianceOverlay,
  platformDefaults,
} from "./policy-compose";
import type { PolicySet } from "./policy-compose";
import { blockTools, tokenBudget, requireLevel } from "./policy";

// ─── Preset Policy Sets ────────────────────────────────────────

describe("preset policy sets", () => {
  test("securityBaseline returns valid policy set", () => {
    const set = securityBaseline();
    assert.equal(set.name, "security-baseline");
    assert.equal(set.source, "security-team");
    assert.ok(set.rules.length >= 2);
    assert.ok(set.priorityBoost! > 0);
  });

  test("complianceOverlay returns valid policy set", () => {
    const set = complianceOverlay();
    assert.equal(set.name, "compliance-overlay");
    assert.equal(set.source, "compliance-team");
    assert.ok(set.rules.length >= 2);
  });

  test("platformDefaults returns valid policy set", () => {
    const set = platformDefaults();
    assert.equal(set.name, "platform-defaults");
    assert.equal(set.source, "platform-team");
    assert.ok(set.rules.length >= 2);
  });
});

// ─── Basic Composition ──────────────────────────────────────────

describe("composePolicies basic", () => {
  test("composes single policy set", () => {
    const result = composePolicies([securityBaseline()]);
    assert.ok(result.rules.length > 0);
    assert.deepEqual(result.sources, ["security-team"]);
    assert.equal(result.conflicts.length, 0);
  });

  test("composes multiple policy sets", () => {
    const result = composePolicies([
      securityBaseline(),
      complianceOverlay(),
      platformDefaults(),
    ]);

    assert.ok(result.rules.length > 0);
    assert.equal(result.sources.length, 3);
    assert.ok(result.totalRulesInput >= 6);
  });

  test("empty sets returns empty result", () => {
    const result = composePolicies([]);
    assert.equal(result.rules.length, 0);
    assert.equal(result.sources.length, 0);
    assert.equal(result.totalRulesInput, 0);
  });

  test("applies priority boost to all rules", () => {
    const set: PolicySet = {
      name: "boosted",
      source: "test",
      priorityBoost: 100,
      rules: [blockTools(["dangerous"])],
    };

    const result = composePolicies([set]);
    assert.ok(result.rules[0].priority >= 200); // 100 original + 100 boost
  });

  test("prefixes rule IDs with set name", () => {
    const set: PolicySet = {
      name: "my-set",
      source: "test",
      rules: [blockTools(["a"])],
    };

    const result = composePolicies([set]);
    assert.ok(result.rules[0].id.startsWith("my-set/"));
  });
});

// ─── Deduplication ──────────────────────────────────────────────

describe("policy deduplication", () => {
  test("deduplicates same-condition same-outcome rules", () => {
    const set1: PolicySet = {
      name: "set1",
      source: "team-a",
      rules: [tokenBudget(100_000)],
    };
    const set2: PolicySet = {
      name: "set2",
      source: "team-b",
      rules: [tokenBudget(200_000)],
    };

    const result = composePolicies([set1, set2], { deduplicate: true });

    // Both are token_limit type — should deduplicate to one
    const tokenRules = result.rules.filter((r) =>
      r.id.includes("token-budget"),
    );
    assert.equal(tokenRules.length, 1);
    assert.ok(result.deduplicatedCount > 0);
  });

  test("keeps all rules when deduplicate is false", () => {
    const set1: PolicySet = {
      name: "set1",
      source: "team-a",
      rules: [tokenBudget(100_000)],
    };
    const set2: PolicySet = {
      name: "set2",
      source: "team-b",
      rules: [tokenBudget(200_000)],
    };

    const result = composePolicies([set1, set2], { deduplicate: false });

    const tokenRules = result.rules.filter((r) =>
      r.id.includes("token-budget"),
    );
    assert.equal(tokenRules.length, 2);
  });

  test("deduplication keeps highest priority rule", () => {
    const set1: PolicySet = {
      name: "set1",
      source: "team-a",
      priorityBoost: 10,
      rules: [tokenBudget(100_000)],
    };
    const set2: PolicySet = {
      name: "set2",
      source: "team-b",
      priorityBoost: 50,
      rules: [tokenBudget(200_000)],
    };

    const result = composePolicies([set1, set2]);
    const tokenRule = result.rules.find((r) =>
      r.id.includes("token-budget"),
    );
    assert.ok(tokenRule);
    assert.ok(tokenRule.id.startsWith("set2/")); // Higher priority boost
  });
});

// ─── Conflict Resolution ────────────────────────────────────────

describe("conflict resolution", () => {
  test("detects conflicts between different outcomes", () => {
    const set1: PolicySet = {
      name: "restrictive",
      source: "security",
      rules: [{
        id: "level-check",
        name: "Require L2",
        condition: { type: "agent_level", minLevel: 2 },
        outcome: "block",
        reason: "Too low",
        priority: 100,
        enabled: true,
      }],
    };

    const set2: PolicySet = {
      name: "permissive",
      source: "dev-team",
      rules: [{
        id: "level-override",
        name: "Allow L1",
        condition: { type: "agent_level", minLevel: 1 },
        outcome: "allow",
        reason: "OK for dev",
        priority: 50,
        enabled: true,
      }],
    };

    const result = composePolicies([set1, set2], {
      conflictStrategy: "strict",
    });
    assert.ok(result.conflicts.length > 0);
  });

  test("strict strategy: block wins over allow", () => {
    const set1: PolicySet = {
      name: "blocker",
      source: "security",
      rules: [{
        id: "level",
        name: "Block",
        condition: { type: "agent_level", minLevel: 3 },
        outcome: "block",
        reason: "Blocked",
        priority: 50,
        enabled: true,
      }],
    };

    const set2: PolicySet = {
      name: "allower",
      source: "dev",
      rules: [{
        id: "level",
        name: "Allow",
        condition: { type: "agent_level", minLevel: 1 },
        outcome: "allow",
        reason: "Allowed",
        priority: 200,
        enabled: true,
      }],
    };

    const result = composePolicies([set1, set2], {
      conflictStrategy: "strict",
    });
    const levelRule = result.rules.find((r) => r.id.includes("level"));
    assert.ok(levelRule);
    assert.equal(levelRule.outcome, "block");
  });

  test("permissive strategy: allow wins over block", () => {
    const set1: PolicySet = {
      name: "blocker",
      source: "security",
      rules: [{
        id: "level",
        name: "Block",
        condition: { type: "agent_level", minLevel: 3 },
        outcome: "block",
        reason: "Blocked",
        priority: 200,
        enabled: true,
      }],
    };

    const set2: PolicySet = {
      name: "allower",
      source: "dev",
      rules: [{
        id: "level",
        name: "Allow",
        condition: { type: "agent_level", minLevel: 1 },
        outcome: "allow",
        reason: "Allowed",
        priority: 50,
        enabled: true,
      }],
    };

    const result = composePolicies([set1, set2], {
      conflictStrategy: "permissive",
    });
    const levelRule = result.rules.find((r) => r.id.includes("level"));
    assert.ok(levelRule);
    assert.equal(levelRule.outcome, "allow");
  });

  test("priority strategy: highest priority wins", () => {
    const set1: PolicySet = {
      name: "low-pri",
      source: "team-a",
      priorityBoost: 0,
      rules: [{
        id: "level",
        name: "Block L0",
        condition: { type: "agent_level", minLevel: 1 },
        outcome: "block",
        reason: "Blocked",
        priority: 50,
        enabled: true,
      }],
    };

    const set2: PolicySet = {
      name: "high-pri",
      source: "team-b",
      priorityBoost: 100,
      rules: [{
        id: "level",
        name: "Allow all",
        condition: { type: "agent_level", minLevel: 1 },
        outcome: "allow",
        reason: "Allowed",
        priority: 50,
        enabled: true,
      }],
    };

    const result = composePolicies([set1, set2], {
      conflictStrategy: "priority",
    });
    const levelRule = result.rules.find((r) => r.id.includes("level"));
    assert.ok(levelRule);
    assert.equal(levelRule.outcome, "allow"); // higher effective priority
  });

  test("latest strategy: last set wins", () => {
    const set1: PolicySet = {
      name: "first",
      source: "team-a",
      priorityBoost: 100,
      rules: [{
        id: "level",
        name: "Block",
        condition: { type: "agent_level", minLevel: 3 },
        outcome: "block",
        reason: "Blocked",
        priority: 200,
        enabled: true,
      }],
    };

    const set2: PolicySet = {
      name: "last",
      source: "team-b",
      priorityBoost: 0,
      rules: [{
        id: "level",
        name: "Allow",
        condition: { type: "agent_level", minLevel: 1 },
        outcome: "allow",
        reason: "Allowed",
        priority: 50,
        enabled: true,
      }],
    };

    const result = composePolicies([set1, set2], {
      conflictStrategy: "latest",
    });
    const levelRule = result.rules.find((r) => r.id.includes("level"));
    assert.ok(levelRule);
    assert.equal(levelRule.outcome, "allow"); // last set wins
  });

  test("conflict records include sources and resolution", () => {
    const set1: PolicySet = {
      name: "s1",
      source: "team-a",
      rules: [{
        id: "level",
        name: "Block",
        condition: { type: "agent_level", minLevel: 3 },
        outcome: "block",
        reason: "Blocked",
        priority: 100,
        enabled: true,
      }],
    };

    const set2: PolicySet = {
      name: "s2",
      source: "team-b",
      rules: [{
        id: "level",
        name: "Allow",
        condition: { type: "agent_level", minLevel: 1 },
        outcome: "allow",
        reason: "Allowed",
        priority: 50,
        enabled: true,
      }],
    };

    const result = composePolicies([set1, set2], {
      conflictStrategy: "strict",
    });

    assert.ok(result.conflicts.length > 0);
    const conflict = result.conflicts[0];
    assert.ok(conflict.ruleIds.length >= 2);
    assert.ok(conflict.sources.includes("team-a"));
    assert.ok(conflict.sources.includes("team-b"));
    assert.equal(conflict.resolution, "strict");
    assert.ok(conflict.winner);
  });
});

// ─── Max Rules Limit ────────────────────────────────────────────

describe("max rules limit", () => {
  test("enforces maxRules limit", () => {
    const set: PolicySet = {
      name: "many",
      source: "test",
      rules: Array.from({ length: 20 }, (_, i) =>
        blockTools([`tool_${i}`]),
      ),
    };

    const result = composePolicies([set], { maxRules: 5 });
    assert.equal(result.totalRulesOutput, 5);
    assert.equal(result.totalRulesInput, 20);
  });

  test("keeps highest priority rules when limiting", () => {
    const rules = Array.from({ length: 10 }, (_, i) => ({
      ...blockTools([`tool_${i}`]),
      id: `rule-${i}`,
      priority: i * 10,
    }));

    const set: PolicySet = { name: "test", source: "test", rules };
    const result = composePolicies([set], { maxRules: 3 });

    // Should keep the 3 highest priority rules
    assert.equal(result.rules.length, 3);
    for (const rule of result.rules) {
      assert.ok(rule.priority >= 70); // top 3: 70, 80, 90
    }
  });
});

// ─── Integration ────────────────────────────────────────────────

describe("policy composition integration", () => {
  test("full enterprise stack composition", () => {
    const result = composePolicies([
      securityBaseline(),
      complianceOverlay(),
      platformDefaults(),
    ]);

    assert.ok(result.rules.length >= 3);
    assert.equal(result.sources.length, 3);
    assert.ok(result.totalRulesInput >= 6);

    // Security rules should have highest effective priority (boost = 50)
    const sorted = [...result.rules].sort(
      (a, b) => b.priority - a.priority,
    );
    assert.ok(sorted[0].id.startsWith("security-baseline/"));
  });

  test("composePolicies result can be used with createGovernance", () => {
    const result = composePolicies([
      securityBaseline(),
      complianceOverlay(),
    ]);

    // Rules are valid PolicyRule objects
    for (const rule of result.rules) {
      assert.ok(rule.id);
      assert.ok(rule.name);
      assert.ok(rule.condition);
      assert.ok(rule.outcome);
      assert.ok(rule.reason);
      assert.ok(typeof rule.priority === "number");
      assert.ok(typeof rule.enabled === "boolean");
    }
  });

  test("no conflicts when sets cover different domains", () => {
    const set1: PolicySet = {
      name: "tools",
      source: "security",
      rules: [blockTools(["shell_exec"])],
    };

    const set2: PolicySet = {
      name: "budget",
      source: "finance",
      rules: [tokenBudget(100_000)],
    };

    const result = composePolicies([set1, set2]);
    assert.equal(result.conflicts.length, 0);
    assert.equal(result.rules.length, 2);
  });
});
