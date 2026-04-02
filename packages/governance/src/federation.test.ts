import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createGovernance, blockTools, requireApproval } from "./index";
import { createFederation } from "./federation";

describe("Multi-Agent Federation", () => {
  it("creates a governance posture for a local agent", async () => {
    const gov = createGovernance({ rules: [blockTools(["shell_exec"])] });
    const agent = await gov.register({ name: "bot-a", framework: "mastra", owner: "team-1", tools: ["search"] });
    const federation = createFederation(gov);

    const posture = await federation.createPosture(agent.id);
    assert.equal(posture.agentId, agent.id);
    assert.equal(posture.agentName, "bot-a");
    assert.ok(posture.compositeScore >= 0);
    assert.ok(posture.issuedAt);
  });

  it("accepts a remote posture meeting minimum score", () => {
    const gov = createGovernance();
    const federation = createFederation(gov, { minimumRemoteScore: 30 });

    const result = federation.evaluatePosture({
      agentId: "remote-1", agentName: "remote-bot", compositeScore: 50,
      level: 2, capabilities: [], complianceFrameworks: [], policyCount: 3,
      auditIntegrity: true, issuedAt: new Date().toISOString(),
    });
    assert.equal(result.accepted, true);
  });

  it("rejects a remote posture below minimum score", () => {
    const gov = createGovernance();
    const federation = createFederation(gov, { minimumRemoteScore: 60 });

    const result = federation.evaluatePosture({
      agentId: "remote-1", agentName: "weak-bot", compositeScore: 30,
      level: 1, capabilities: [], complianceFrameworks: [], policyCount: 0,
      auditIntegrity: false, issuedAt: new Date().toISOString(),
    });
    assert.equal(result.accepted, false);
    assert.ok(result.reason.includes("below minimum"));
  });

  it("rejects expired posture", () => {
    const gov = createGovernance();
    const federation = createFederation(gov);

    const result = federation.evaluatePosture({
      agentId: "remote-1", agentName: "expired-bot", compositeScore: 80,
      level: 3, capabilities: [], complianceFrameworks: [], policyCount: 5,
      auditIntegrity: true, issuedAt: "2020-01-01T00:00:00Z", expiresAt: "2020-01-02T00:00:00Z",
    });
    assert.equal(result.accepted, false);
    assert.ok(result.reason.includes("expired"));
  });

  it("rejects when required compliance is missing", () => {
    const gov = createGovernance();
    const federation = createFederation(gov, { requiredCompliance: ["eu-ai-act"] });

    const result = federation.evaluatePosture({
      agentId: "remote-1", agentName: "no-compliance", compositeScore: 80,
      level: 3, capabilities: [], complianceFrameworks: [], policyCount: 5,
      auditIntegrity: true, issuedAt: new Date().toISOString(),
    });
    assert.equal(result.accepted, false);
    assert.ok(result.reason.includes("compliance"));
  });

  it("negotiates shared policies between local and remote", () => {
    const gov = createGovernance({ rules: [blockTools(["shell_exec"]), requireApproval(["payment"])] });
    const federation = createFederation(gov);

    const remoteRules = [
      { id: "r-1", name: "Remote block", condition: { type: "tool_blocked", params: { tools: ["rm"] } }, outcome: "block" as const, reason: "Remote", priority: 50, enabled: true },
      { id: "r-2", name: "Remote approval", condition: { type: "action_type", params: { actions: ["payment"] } }, outcome: "require_approval" as const, reason: "Remote", priority: 50, enabled: true },
    ];

    const result = federation.negotiatePolicies(remoteRules);
    assert.ok(result.sharedRules.length > 0);
    assert.ok(result.sharedRules.every((r) => r.id.startsWith("federated-")));
  });

  it("links audit events across boundaries", () => {
    const gov = createGovernance();
    const federation = createFederation(gov);

    const link = federation.linkAudit("local-1", "remote-1", "remote-agent", "send");
    assert.equal(link.localEventId, "local-1");
    assert.equal(link.remoteEventId, "remote-1");
    assert.equal(link.linkType, "send");

    federation.linkAudit("local-2", "remote-2", "remote-agent", "receive");
    const links = federation.getAuditLinks("remote-agent");
    assert.equal(links.length, 2);
  });

  it("filters audit links by remote agent", () => {
    const gov = createGovernance();
    const federation = createFederation(gov);

    federation.linkAudit("l1", "r1", "agent-a", "send");
    federation.linkAudit("l2", "r2", "agent-b", "receive");

    assert.equal(federation.getAuditLinks("agent-a").length, 1);
    assert.equal(federation.getAuditLinks("agent-b").length, 1);
    assert.equal(federation.getAuditLinks().length, 2);
  });
});
