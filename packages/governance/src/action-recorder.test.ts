import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createGovernance, runWithOutcome } from "./index";
import { verifyAuditIntegrity } from "./audit-integrity-verify";

describe("runWithOutcome", () => {
  it("records a success outcome and returns the action's result", async () => {
    const gov = createGovernance({});
    const agent = await gov.register({ name: "x", framework: "mastra", owner: "t" });
    const result = await runWithOutcome(
      gov,
      { agentId: agent.id, tool: "search" },
      async () => ({ hits: 3 }),
    );
    assert.deepEqual(result, { hits: 3 });

    // Give the fire-and-forget outcome write a tick to land.
    await new Promise((r) => setImmediate(r));

    const events = await gov.audit.query({ eventType: "action_outcome" });
    assert.ok(events.length >= 1);
    const latest = events[events.length - 1];
    assert.equal(latest.outcome, "success");
    assert.equal((latest.detail as { tool?: string }).tool, "search");
  });

  it("records a failure outcome and re-throws the error", async () => {
    const gov = createGovernance({});
    const agent = await gov.register({ name: "y", framework: "mastra", owner: "t" });
    const err = new Error("timeout");
    await assert.rejects(
      runWithOutcome(
        gov,
        { agentId: agent.id, tool: "slow_api" },
        async () => {
          throw err;
        },
      ),
      /timeout/,
    );

    await new Promise((r) => setImmediate(r));

    const events = await gov.audit.query({ eventType: "action_outcome" });
    const failure = events.find((e) => e.outcome === "failure");
    assert.ok(failure, "failure outcome not recorded");
    assert.equal((failure!.detail as { error?: string }).error, "timeout");
  });

  it("applies summarize() to redact output before logging", async () => {
    const gov = createGovernance({});
    const agent = await gov.register({ name: "z", framework: "mastra", owner: "t" });

    await runWithOutcome(
      gov,
      {
        agentId: agent.id,
        tool: "sensitive_api",
        summarize: (r) => ({ redacted: true, size: JSON.stringify(r).length }),
      },
      async () => ({ ssn: "123-45-6789", name: "Alice" }),
    );
    await new Promise((r) => setImmediate(r));
    const events = await gov.audit.query({ eventType: "action_outcome" });
    const latest = events[events.length - 1];
    const output = (latest.detail as { output?: { redacted?: boolean; size?: number } }).output;
    assert.equal(output?.redacted, true);
    assert.ok(typeof output?.size === "number");
  });

  it("outcome event joins the integrity chain end-to-end", async () => {
    const KEY = "wrap-test-key";
    const gov = createGovernance({ integrityAudit: { signingKey: KEY } });
    const agent = await gov.register({ name: "w", framework: "mastra", owner: "t" });

    await runWithOutcome(
      gov,
      { agentId: agent.id, tool: "search" },
      async () => ({ hits: 5 }),
    );
    // Await chain serialisation
    await new Promise((r) => setTimeout(r, 10));

    const chain = await gov.integrityChain!.export();
    const hasOutcome = chain.some((e) => e.eventType === "action_outcome");
    assert.ok(hasOutcome, "outcome event should be in the integrity chain");
    const verified = await verifyAuditIntegrity(chain, KEY);
    assert.equal(verified.valid, true);
  });
});
