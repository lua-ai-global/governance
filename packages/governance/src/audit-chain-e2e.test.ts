/**
 * End-to-end integrity audit chain tests.
 *
 * When `createGovernance({ integrityAudit: { signingKey } })` is set, EVERY
 * audit write that goes through the SDK should be HMAC-chained:
 *   - register() → "agent_registered"
 *   - enforce() → "policy_evaluation"
 *   - enforcePreprocess/Postprocess → "policy_evaluation_preprocess/postprocess"
 *   - audit.log() → caller-supplied eventType
 *   - recordOutcome() → "action_outcome"
 *   - kill-switch → kill events (routed through audit.log())
 *
 * The exported chain should verify cleanly via verifyAuditIntegrity(),
 * and any tampering should break verification at the right position.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createGovernance, blockTools } from "./index";
import { verifyAuditIntegrity } from "./audit-integrity-verify";
import { createKillSwitch } from "./kill-switch";

const KEY = "e2e-chain-test-secret";

describe("integrity chain end-to-end — every SDK audit write is HMAC-chained", () => {
  it("chains register + enforce + recordOutcome + audit.log + kill events", async () => {
    const gov = createGovernance({
      integrityAudit: { signingKey: KEY },
      rules: [blockTools(["shell_exec"])],
    });

    // register → "agent_registered"
    const agent = await gov.register({ name: "alpha", framework: "mastra", owner: "t" });

    // enforce (allow) → "policy_evaluation"
    await gov.enforce({ agentId: agent.id, action: "tool_call", tool: "safe_tool" });

    // enforce (block) → "policy_evaluation"
    await gov.enforce({ agentId: agent.id, action: "tool_call", tool: "shell_exec" });

    // recordOutcome (success) → "action_outcome"
    await gov.recordOutcome({
      agentId: agent.id,
      tool: "safe_tool",
      action: "tool_call",
      success: true,
      durationMs: 42,
      output: { ok: true },
    });

    // recordOutcome (failure) → "action_outcome"
    await gov.recordOutcome({
      agentId: agent.id,
      tool: "flaky_tool",
      action: "tool_call",
      success: false,
      error: "Connection refused",
      durationMs: 5000,
    });

    // audit.log → caller-supplied eventType
    await gov.audit.log({
      agentId: agent.id,
      eventType: "custom_llm_call",
      outcome: "success",
      severity: "info",
      detail: { model: "claude-opus-4-6", tokensIn: 120, tokensOut: 85 },
    });

    // kill-switch → "agent_killed"
    const ks = createKillSwitch(gov);
    await ks.kill(agent.id, "incident-42");

    assert.ok(gov.integrityChain, "integrityChain should be populated");
    const exported = await gov.integrityChain!.export();

    // We expect at least 7 distinct event types in the chain.
    const types = new Set(exported.map((e) => e.eventType));
    assert.ok(types.has("agent_registered"));
    assert.ok(types.has("policy_evaluation"));
    assert.ok(types.has("action_outcome"));
    assert.ok(types.has("custom_llm_call"));
    assert.ok(exported.length >= 7, `expected ≥7 chained events, got ${exported.length}`);

    // Every entry must have integrity metadata and a sequential sequence.
    for (let i = 0; i < exported.length; i++) {
      assert.equal(exported[i].integrity.sequence, i + 1);
      assert.match(exported[i].integrity.hash, /^[0-9a-f]{64}$/);
    }

    // Full-chain verification passes with the right key.
    const verified = await verifyAuditIntegrity(exported, KEY);
    assert.equal(verified.valid, true, `chain failed to verify: ${verified.breakDetail}`);
    assert.equal(verified.eventsVerified, exported.length);
  });

  it("detects tampering in a recordOutcome event after the fact", async () => {
    const gov = createGovernance({ integrityAudit: { signingKey: KEY } });
    const agent = await gov.register({ name: "bob", framework: "mastra", owner: "t" });

    await gov.enforce({ agentId: agent.id, action: "tool_call", tool: "search" });
    await gov.recordOutcome({
      agentId: agent.id,
      tool: "search",
      success: true,
      output: { hits: 3 },
    });
    await gov.recordOutcome({
      agentId: agent.id,
      tool: "search",
      success: true,
      output: { hits: 5 },
    });

    const chain = await gov.integrityChain!.export();
    // Mutate the output payload on the middle recordOutcome entry.
    const outcomeIdx = chain.findIndex((e) => e.eventType === "action_outcome");
    assert.ok(outcomeIdx >= 0);
    const tampered = chain.map((e, i) =>
      i === outcomeIdx
        ? {
            ...e,
            detail: { ...(e.detail ?? {}), output: { hits: 9999 } },
          }
        : e,
    );

    const verified = await verifyAuditIntegrity(tampered, KEY);
    assert.equal(verified.valid, false);
    assert.equal(verified.brokenAt, outcomeIdx);
    assert.match(verified.breakDetail ?? "", /modified/);
  });

  it("fail-open mode (default) records errors but does not block enforce()", async () => {
    const errors: unknown[] = [];
    const brokenStorage = {
      createAgent: async (a: { id: string }) => ({ id: a.id }) as never,
      getAgent: async () => null,
      getAgentByName: async () => null,
      listAgents: async () => [],
      updateAgent: async () => null,
      deleteAgent: async () => false,
      async createAuditEvent() {
        throw new Error("storage down");
      },
      queryAuditEvents: async () => [],
      countAuditEvents: async () => 0,
    };
    const gov = createGovernance({
      storage: brokenStorage as never,
      integrityAudit: { signingKey: KEY, onFailure: "allow" },
      onAuditError: (e) => errors.push(e),
    });

    // register() writes audit → fails → captured in errors; continues.
    await gov.register({ name: "x", framework: "mastra", owner: "t" });
    // enforce() in fail-open mode must still return a decision.
    const decision = await gov.enforce({ agentId: "x", action: "tool_call" });
    assert.ok(decision);
    // At least one error should have been captured.
    assert.ok(errors.length > 0, "onAuditError should have fired");
  });

  it("fail-closed mode rejects enforce() when the chain write fails", async () => {
    const brokenStorage = {
      createAgent: async (a: { id: string }) => ({ id: a.id }) as never,
      getAgent: async () => null,
      getAgentByName: async () => null,
      listAgents: async () => [],
      updateAgent: async () => null,
      deleteAgent: async () => false,
      async createAuditEvent() {
        throw new Error("storage down");
      },
      queryAuditEvents: async () => [],
      countAuditEvents: async () => 0,
    };
    const gov = createGovernance({
      storage: brokenStorage as never,
      integrityAudit: { signingKey: KEY, onFailure: "block" },
    });

    // register() itself does not await the audit write, so it may still
    // succeed — but enforce() under onFailure:"block" DOES await and
    // will throw.
    try {
      await gov.register({ name: "x", framework: "mastra", owner: "t" });
    } catch {
      /* ok if it also fails */
    }

    await assert.rejects(
      () => gov.enforce({ agentId: "x", action: "tool_call" }),
      /storage down/,
    );
  });

  it("without integrityAudit config, integrityChain is undefined (opt-in)", async () => {
    const gov = createGovernance({});
    assert.equal(gov.integrityChain, undefined);
  });

  it("stats report tracks sequence + latest hash", async () => {
    const gov = createGovernance({ integrityAudit: { signingKey: KEY } });
    await gov.register({ name: "a", framework: "mastra", owner: "t" });
    await gov.register({ name: "b", framework: "mastra", owner: "t" });

    const stats = gov.integrityChain!.stats();
    assert.equal(stats.latestSequence, 2);
    assert.equal(stats.algorithm, "hmac-sha256");
    assert.match(stats.latestHash, /^[0-9a-f]{64}$/);
  });
});
