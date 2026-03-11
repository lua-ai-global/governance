import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createGovernance } from "./index";
import { createKillSwitch } from "./kill-switch";

describe("kill switch edge cases", () => {
  test("killing same agent twice is idempotent", async () => {
    const gov = createGovernance();
    const ks = createKillSwitch(gov);
    const agent = await gov.register({ name: "a", framework: "mastra", owner: "t" });

    await ks.kill(agent.id, "first");
    await ks.kill(agent.id, "second");
    assert.equal(ks.isKilled(agent.id), true);

    const records = ks.getKillRecords();
    // Second kill overwrites the first
    assert.equal(records.filter((r) => r.agentId === agent.id).length, 1);
    assert.equal(records[0].reason, "second");
  });

  test("reviving non-killed agent is safe", async () => {
    const gov = createGovernance();
    const ks = createKillSwitch(gov);
    const agent = await gov.register({ name: "a", framework: "mastra", owner: "t" });

    // Should not throw
    await ks.revive(agent.id, "nothing to revive");
    assert.equal(ks.isKilled(agent.id), false);
  });

  test("reviving after fleet kill only removes individual kill", async () => {
    const gov = createGovernance();
    const ks = createKillSwitch(gov);
    const a1 = await gov.register({ name: "a1", framework: "mastra", owner: "t" });

    await ks.killAll("emergency");
    // Revive individual agent
    await ks.revive(a1.id);

    // Still fleet killed — individual revive doesn't clear fleet kill
    assert.equal(ks.isFleetKilled(), true);
    assert.equal(ks.isKilled(a1.id), true); // fleet kill still active
  });

  test("reviveAll clears fleet and individual kills", async () => {
    const gov = createGovernance();
    const ks = createKillSwitch(gov);
    const a1 = await gov.register({ name: "a1", framework: "mastra", owner: "t" });
    const a2 = await gov.register({ name: "a2", framework: "mastra", owner: "t" });

    await ks.kill(a1.id, "individual");
    await ks.killAll("fleet");

    await ks.reviveAll("all clear");
    assert.equal(ks.isFleetKilled(), false);
    assert.equal(ks.isKilled(a1.id), false);
    assert.equal(ks.isKilled(a2.id), false);
    assert.equal(ks.getKillRecords().length, 0);
  });

  test("getKillRecords is empty initially", () => {
    const gov = createGovernance();
    const ks = createKillSwitch(gov);
    assert.deepEqual(ks.getKillRecords(), []);
  });

  test("isFleetKilled is false initially", () => {
    const gov = createGovernance();
    const ks = createKillSwitch(gov);
    assert.equal(ks.isFleetKilled(), false);
  });

  test("kill with killedBy tracks who killed", async () => {
    const gov = createGovernance();
    const ks = createKillSwitch(gov);
    const agent = await gov.register({ name: "a", framework: "mastra", owner: "t" });

    await ks.kill(agent.id, "security incident", "security-team");
    const records = ks.getKillRecords();
    assert.equal(records[0].killedBy, "security-team");
  });

  test("killAll with killedBy tracks who killed", async () => {
    const gov = createGovernance();
    const ks = createKillSwitch(gov);
    await gov.register({ name: "a", framework: "mastra", owner: "t" });

    const records = await ks.killAll("incident", "ops-team");
    assert.equal(records[0].killedBy, "ops-team");
  });

  test("killAll on empty fleet returns empty array", async () => {
    const gov = createGovernance();
    const ks = createKillSwitch(gov);
    const records = await ks.killAll("emergency");
    assert.deepEqual(records, []);
    assert.equal(ks.isFleetKilled(), true);
  });

  test("fleet kill blocks new agent registered after kill", async () => {
    const gov = createGovernance();
    const ks = createKillSwitch(gov);

    await ks.killAll("lockdown");

    // Register a new agent after fleet kill
    const agent = await gov.register({ name: "new", framework: "mastra", owner: "t" });

    // Fleet kill rule (custom evaluate: () => true) should block everything
    const decision = await gov.enforce({
      agentId: agent.id, agentName: "new", agentLevel: 0,
      action: "tool_call", tool: "anything",
    });
    assert.equal(decision.blocked, true);
  });

  test("kill sets agent status to quarantined", async () => {
    const gov = createGovernance();
    const ks = createKillSwitch(gov);
    const agent = await gov.register({ name: "a", framework: "mastra", owner: "t" });

    await ks.kill(agent.id, "quarantine");
    const stored = await gov.storage.getAgent(agent.id);
    assert.equal(stored?.status, "quarantined");
  });

  test("revive sets agent status back to approved", async () => {
    const gov = createGovernance();
    const ks = createKillSwitch(gov);
    const agent = await gov.register({ name: "a", framework: "mastra", owner: "t" });

    await ks.kill(agent.id, "temp");
    await ks.revive(agent.id);
    const stored = await gov.storage.getAgent(agent.id);
    assert.equal(stored?.status, "approved");
  });

  test("kill logs audit with critical severity", async () => {
    const gov = createGovernance();
    const ks = createKillSwitch(gov);
    const agent = await gov.register({ name: "a", framework: "mastra", owner: "t" });

    await ks.kill(agent.id, "security");
    const events = await gov.audit.query({ eventType: "agent_killed" });
    assert.equal(events.length, 1);
    assert.equal(events[0].severity, "critical");
    assert.equal(events[0].outcome, "kill_switch");
  });

  test("revive logs audit event", async () => {
    const gov = createGovernance();
    const ks = createKillSwitch(gov);
    const agent = await gov.register({ name: "a", framework: "mastra", owner: "t" });

    await ks.kill(agent.id, "temp");
    await ks.revive(agent.id, "resolved");

    const events = await gov.audit.query({ eventType: "agent_revived" });
    assert.equal(events.length, 1);
  });

  test("killAll logs fleet_killed audit event", async () => {
    const gov = createGovernance();
    const ks = createKillSwitch(gov);

    await ks.killAll("emergency");
    const events = await gov.audit.query({ eventType: "fleet_killed" });
    assert.equal(events.length, 1);
    assert.equal(events[0].agentId, "__fleet__");
  });

  test("reviveAll logs fleet_revived audit event", async () => {
    const gov = createGovernance();
    const ks = createKillSwitch(gov);

    await ks.killAll("emergency");
    await ks.reviveAll("all clear");

    const events = await gov.audit.query({ eventType: "fleet_revived" });
    assert.equal(events.length, 1);
  });
});
