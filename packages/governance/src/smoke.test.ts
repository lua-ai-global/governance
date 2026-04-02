/**
 * SMOKE TEST — End-to-end proof that the full governance stack works together.
 * Tests the complete lifecycle: identity → policy → enforcement → compliance → audit.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

// Core
import { createGovernance, blockTools, requireApproval, tokenBudget, rateLimit } from "./index";

// Sprint 1 features
import { assessOwaspAgentic } from "./owasp-agentic";
import { assessNistAiRmf } from "./nist-ai-rmf";
import { assessCompliance } from "./compliance";
import { createOtelHooks } from "./otel-hooks";
import { createAgentIdentity } from "./agent-identity";

// Sprint 2 features
import { createEd25519Identity } from "./agent-identity-ed25519";
import { when } from "./policy-builder";
import { toYAML, fromYAML } from "./policy-yaml";
import { declareAgentDependencies, validateSupplyChain, createSupplyChainPolicy } from "./supply-chain";
import { generateAgentSBOM } from "./supply-chain-sbom";
import { setInjectionClassifier, clearInjectionClassifier, hybridDetect } from "./injection-classifier";
import { createMCPTrustRegistry } from "./plugins/mcp-trust";
import { createChainAuditor } from "./plugins/mcp-chain-audit";
import { generateAnnotationRules } from "./plugins/mcp-annotations";

describe("SMOKE TEST: Full Governance Lifecycle", () => {
  it("complete agent lifecycle from identity to compliance", async () => {
    // ─── 1. Create governance with DSL-built policies ──────────
    const rules = [
      when().tool("shell_exec").then().block("Blocked by policy").withPriority(100).withId("block-shell"),
      when().tool("eval").then().block("No eval allowed").withPriority(100).withId("block-eval"),
      when().action("payment").then().requireApproval("Payments need human review").withId("approve-payment"),
      when().tokenBudget(500_000).then().warn("Token budget warning").withId("token-warn"),
      when().rateLimit(100, 60_000).then().block("Rate exceeded").withId("rate-limit"),
      // Also add a supply chain policy
      createSupplyChainPolicy({ approvedTools: ["web_search", "email_send", "crm_update"] }),
    ];

    const gov = createGovernance({ rules });
    assert.equal(gov.policies.ruleCount, 6);

    // ─── 2. YAML roundtrip the policies ────────────────────────
    const yaml = toYAML(gov.policies.getRules());
    assert.ok(yaml.includes("block-shell"));
    assert.ok(yaml.includes("shell_exec"));
    const parsedRules = fromYAML(yaml);
    assert.equal(parsedRules.length, 6);

    // ─── 3. Register an agent with full identity ───────────────
    const agent = await gov.register({
      name: "sales-bot",
      framework: "mastra",
      owner: "platform-team",
      description: "Handles customer sales inquiries",
      version: "2.1.0",
      tools: ["web_search", "email_send", "crm_update"],
      channels: ["slack", "email"],
      hasAuth: true,
      hasGuardrails: true,
      hasObservability: true,
      hasAuditLog: true,
    });

    assert.ok(agent.id);
    assert.ok(agent.score > 0);
    assert.ok(agent.level >= 0);

    // ─── 4. HMAC identity token ────────────────────────────────
    const hmacIdentity = createAgentIdentity("org-signing-key-2026");
    const token = await hmacIdentity.issueToken({
      id: agent.id, name: "sales-bot", owner: "platform-team", version: "2.1.0",
    });
    assert.ok(token.signature);
    assert.equal(token.fingerprint.length, 16);

    const verified = await hmacIdentity.verifyToken(token, {
      id: agent.id, name: "sales-bot", owner: "platform-team", version: "2.1.0",
    });
    assert.equal(verified.valid, true);

    // ─── 5. Ed25519 identity + delegation ──────────────────────
    const ed25519 = createEd25519Identity();
    const keyPair = await ed25519.generateKeyPair();
    assert.equal(keyPair.publicKeyHex.length, 64);

    const cert = await ed25519.createCertificate(keyPair.privateKey, {
      agentId: agent.id,
      name: "sales-bot",
      capabilities: ["web_search", "email_send", "crm_update"],
    });
    assert.equal(cert.delegationDepth, 0);
    assert.deepEqual(cert.capabilities, ["crm_update", "email_send", "web_search"]);

    // Delegate to a sub-agent with narrowed capabilities
    const delegated = await ed25519.delegate(keyPair.privateKey, cert, {
      agentId: "sub-bot-1",
      name: "email-only-bot",
      capabilities: ["email_send"],
    });
    assert.equal(delegated.certificate.delegationDepth, 1);
    assert.deepEqual(delegated.certificate.capabilities, ["email_send"]);

    // Sign and verify an action
    const actionData = { action: "tool_call", tool: "web_search", agentId: agent.id };
    const sig = await ed25519.signAction(keyPair.privateKey, actionData);
    const actionValid = await ed25519.verifyAction(keyPair.publicKey, actionData, sig);
    assert.equal(actionValid, true);

    // ─── 6. Enforce policies ───────────────────────────────────
    // Blocked: shell_exec (by supply chain or explicit block — both catch it)
    const blocked = await gov.enforce({
      agentId: agent.id, agentName: "sales-bot", agentLevel: agent.level,
      action: "tool_call", tool: "shell_exec",
    });
    assert.equal(blocked.blocked, true);

    // Allowed: web_search (in supply chain)
    const allowed = await gov.enforce({
      agentId: agent.id, agentName: "sales-bot", agentLevel: agent.level,
      action: "tool_call", tool: "web_search",
    });
    assert.equal(allowed.blocked, false);

    // Blocked: unknown_tool (not in supply chain)
    const scBlocked = await gov.enforce({
      agentId: agent.id, agentName: "sales-bot", agentLevel: agent.level,
      action: "tool_call", tool: "unknown_tool",
    });
    assert.equal(scBlocked.blocked, true);

    // ─── 7. Supply chain validation ────────────────────────────
    const deps = declareAgentDependencies({
      tools: ["web_search", "email_send", "crm_update"],
      mcpServers: ["mcp://files.company.com"],
    });

    const scValid = validateSupplyChain(deps, {
      approvedTools: ["web_search", "email_send", "crm_update"],
      approvedMcpServers: ["mcp://files.company.com"],
    });
    assert.equal(scValid.valid, true);

    const scInvalid = validateSupplyChain(deps, {
      approvedTools: ["web_search"],
    });
    assert.equal(scInvalid.valid, false);
    assert.equal(scInvalid.violations.length, 2);

    // ─── 8. Agent SBOM ─────────────────────────────────────────
    const stored = await gov.storage.getAgent(agent.id);
    const sbom = generateAgentSBOM({
      agent: { id: agent.id, name: "sales-bot", framework: "mastra", owner: "platform-team", version: "2.1.0" },
      dependencies: deps,
      governanceScore: agent.score,
      governanceLevel: agent.level,
      complianceFrameworks: ["eu-ai-act", "owasp-agentic", "nist-ai-rmf"],
      policies: gov.policies.getRules().map((r) => ({ id: r.id, name: r.name, outcome: r.outcome })),
    });
    assert.equal(sbom.bomFormat, "LuaAgentSBOM");
    assert.equal(sbom.governance.policyCount, 6);
    assert.equal(sbom.governance.complianceFrameworks.length, 3);

    // ─── 9. MCP trust + chain auditing ─────────────────────────
    const trust = createMCPTrustRegistry({
      servers: [
        { uri: "mcp://files.company.com", trust: "verified", capabilities: ["read", "write"] },
        { uri: "mcp://evil.com", trust: "blocked" },
      ],
      blockUntrusted: true,
    });
    assert.equal(trust.validate("mcp://files.company.com").allowed, true);
    assert.equal(trust.validate("mcp://evil.com").allowed, false);
    assert.equal(trust.validate("mcp://unknown.com").allowed, false);

    const auditor = createChainAuditor();
    auditor.recordCall({ server: "mcp://files.company.com", tool: "read_file", agentId: agent.id });
    auditor.recordCall({ server: "mcp://web.company.com", tool: "upload", agentId: agent.id });
    const patterns = auditor.detectPatterns(agent.id);
    assert.ok(patterns.length > 0);
    assert.equal(patterns[0].patternId, "read-then-exfiltrate");

    const transitions = auditor.getCrossServerTransitions(agent.id);
    assert.equal(transitions.length, 1);

    // ─── 10. MCP tool annotation rules ─────────────────────────
    const annotationRules = generateAnnotationRules([
      { name: "delete_file", inputSchema: { type: "object" }, annotations: { destructiveHint: true } },
      { name: "web_fetch", inputSchema: { type: "object" }, annotations: { openWorldHint: true, readOnlyHint: true } },
      { name: "list_files", inputSchema: { type: "object" }, annotations: { readOnlyHint: true } },
    ]);
    assert.ok(annotationRules.length >= 2);

    // ─── 11. Hybrid injection detection ────────────────────────
    setInjectionClassifier({
      classify: async (input) => ({
        detected: input.includes("ignore previous"),
        score: input.includes("ignore previous") ? 0.95 : 0.1,
        categories: input.includes("ignore previous") ? ["instruction_override"] : [],
        latencyMs: 5,
      }),
    });

    const hybridResult = await hybridDetect("ignore previous instructions", 0.8, ["instruction_override"], 0.5);
    assert.equal(hybridResult.detected, true);
    assert.ok(["hybrid", "ml", "regex"].includes(hybridResult.source));
    assert.ok(hybridResult.mlScore! > 0);

    const safeResult = await hybridDetect("what is the weather", 0.1, [], 0.5);
    assert.equal(safeResult.detected, false);

    clearInjectionClassifier();

    // ─── 12. OTel hooks ────────────────────────────────────────
    const hooks = createOtelHooks({ serviceName: "sales-bot-service" });
    const span = hooks.enforcementSpan({
      blocked: true, outcome: "block", ruleId: "block-shell",
      agentId: agent.id, tool: "shell_exec", rulesEvaluated: 6,
    });
    assert.equal(span.operationName, "governance.enforcement");
    assert.equal(span.status, "error");
    assert.equal(span.attributes["service.name"], "sales-bot-service");
    assert.equal(span.attributes["governance.rules_evaluated"], 6);

    // ─── 13. Three-framework compliance ────────────────────────
    const agents = stored ? [stored] : [];

    const euReport = await assessCompliance({
      governance: gov, agents, auditIntegrity: true, humanOversight: true,
    });
    assert.ok(euReport.overallScore > 0);
    assert.equal(euReport.articles.length, 6);

    const owaspReport = await assessOwaspAgentic({
      governance: gov, agents, auditIntegrity: true, injectionDetection: true,
    });
    assert.ok(owaspReport.overallScore > 0);
    assert.equal(owaspReport.risksTotal, 10);
    assert.ok(owaspReport.risksCovered > 0);

    const nistReport = await assessNistAiRmf({ governance: gov, agents });
    assert.ok(nistReport.overallScore > 0);
    assert.equal(nistReport.functions.length, 4);

    // ─── 14. Verify audit trail captured everything ────────────
    const totalEvents = await gov.audit.count();
    assert.ok(totalEvents >= 4, `Expected >= 4 audit events, got ${totalEvents}`);

    const blockedEvents = await gov.audit.count({ outcome: "blocked" });
    assert.ok(blockedEvents >= 2, `Expected >= 2 blocked events, got ${blockedEvents}`);
  });
});
