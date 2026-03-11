import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createGovernance, blockTools } from "./index";
import { createKillSwitch } from "./kill-switch";

describe("Kill Switch", () => {
  test("kill blocks all actions from a specific agent", async () => {
    const gov = createGovernance();
    const ks = createKillSwitch(gov);

    const agent = await gov.register({
      name: "rogue-agent",
      framework: "mastra",
      owner: "team",
    });

    // Before kill — should be allowed
    const before = await gov.enforce({
      agentId: agent.id,
      action: "tool_call",
      tool: "web_search",
    });
    assert.equal(before.blocked, false, "should be allowed before kill");

    // Kill the agent
    const record = await ks.kill(agent.id, "Detected unauthorized access");
    assert.equal(record.agentId, agent.id);
    assert.ok(record.killedAt);

    // After kill — should be blocked
    const after = await gov.enforce({
      agentId: agent.id,
      action: "tool_call",
      tool: "web_search",
    });
    assert.equal(after.blocked, true, "should be blocked after kill");
    assert.ok(after.reason.includes("KILL SWITCH"));
  });

  test("kill does not affect other agents", async () => {
    const gov = createGovernance();
    const ks = createKillSwitch(gov);

    const rogue = await gov.register({
      name: "rogue",
      framework: "mastra",
      owner: "team",
    });
    const innocent = await gov.register({
      name: "innocent",
      framework: "mastra",
      owner: "team",
    });

    await ks.kill(rogue.id, "Gone rogue");

    const decision = await gov.enforce({
      agentId: innocent.id,
      action: "tool_call",
      tool: "web_search",
    });
    assert.equal(decision.blocked, false, "innocent agent should not be blocked");
  });

  test("killAll blocks every agent", async () => {
    const gov = createGovernance();
    const ks = createKillSwitch(gov);

    const a1 = await gov.register({ name: "a1", framework: "mastra", owner: "t" });
    const a2 = await gov.register({ name: "a2", framework: "mastra", owner: "t" });

    const records = await ks.killAll("Security incident");
    assert.equal(records.length, 2);

    for (const agent of [a1, a2]) {
      const decision = await gov.enforce({
        agentId: agent.id,
        action: "tool_call",
        tool: "anything",
      });
      assert.equal(decision.blocked, true, `${agent.id} should be blocked`);
      assert.ok(decision.reason.includes("FLEET KILL SWITCH"));
    }

    assert.equal(ks.isFleetKilled(), true);
  });

  test("revive re-enables a killed agent", async () => {
    const gov = createGovernance();
    const ks = createKillSwitch(gov);

    const agent = await gov.register({
      name: "revivable",
      framework: "mastra",
      owner: "team",
    });

    await ks.kill(agent.id, "Temporary disable");
    assert.equal(ks.isKilled(agent.id), true);

    await ks.revive(agent.id, "Issue resolved");
    assert.equal(ks.isKilled(agent.id), false);

    const decision = await gov.enforce({
      agentId: agent.id,
      action: "tool_call",
      tool: "web_search",
    });
    assert.equal(decision.blocked, false, "should be allowed after revive");
  });

  test("reviveAll re-enables all agents after fleet kill", async () => {
    const gov = createGovernance();
    const ks = createKillSwitch(gov);

    const a1 = await gov.register({ name: "a1", framework: "mastra", owner: "t" });
    await ks.killAll("Emergency");
    assert.equal(ks.isFleetKilled(), true);

    await ks.reviveAll("All clear");
    assert.equal(ks.isFleetKilled(), false);
    assert.equal(ks.isKilled(a1.id), false);

    const decision = await gov.enforce({
      agentId: a1.id,
      action: "tool_call",
      tool: "anything",
    });
    assert.equal(decision.blocked, false);
  });

  test("kill switch overrides lower-priority allow rules", async () => {
    const gov = createGovernance({
      rules: [blockTools(["dangerous"])], // priority 100
    });
    const ks = createKillSwitch(gov);

    const agent = await gov.register({
      name: "agent",
      framework: "mastra",
      owner: "team",
    });

    // Kill switch has priority 999 — overrides everything
    await ks.kill(agent.id, "Override test");

    const decision = await gov.enforce({
      agentId: agent.id,
      action: "tool_call",
      tool: "safe_tool", // not in blocked list
    });
    assert.equal(decision.blocked, true, "kill switch should override");
    assert.ok(decision.reason.includes("KILL SWITCH"));
  });

  test("getKillRecords returns active kills", async () => {
    const gov = createGovernance();
    const ks = createKillSwitch(gov);

    const a1 = await gov.register({ name: "a1", framework: "mastra", owner: "t" });
    const a2 = await gov.register({ name: "a2", framework: "mastra", owner: "t" });

    await ks.kill(a1.id, "Reason 1", "admin");
    await ks.kill(a2.id, "Reason 2");

    const records = ks.getKillRecords();
    assert.equal(records.length, 2);
    assert.equal(records[0].killedBy, "admin");
  });

  test("kill logs audit events", async () => {
    const gov = createGovernance();
    const ks = createKillSwitch(gov);

    const agent = await gov.register({
      name: "audited",
      framework: "mastra",
      owner: "team",
    });

    await ks.kill(agent.id, "Audit test");

    const events = await gov.audit.query({
      agentId: agent.id,
      eventType: "agent_killed",
    });
    assert.equal(events.length, 1);
    assert.equal(events[0].severity, "critical");
  });

  test("isKilled returns true during fleet kill even for unregistered agents", async () => {
    const gov = createGovernance();
    const ks = createKillSwitch(gov);

    await ks.killAll("Fleet emergency");
    assert.equal(ks.isKilled("nonexistent-agent"), true);
  });
});
