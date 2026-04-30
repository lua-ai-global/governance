# governance-sdk

**AI Agent Governance for TypeScript** — policy enforcement, behavioral scoring, injection detection, tamper-evident audit, and standards-mapped compliance for AI agents. **Zero runtime dependencies.**

[![npm version](https://img.shields.io/npm/v/governance-sdk)](https://www.npmjs.com/package/governance-sdk)
[![CI](https://github.com/lua-ai-global/governance/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/lua-ai-global/governance/actions/workflows/ci.yml)
[![install size](https://packagephobia.com/badge?p=governance-sdk)](https://packagephobia.com/result?p=governance-sdk)
[![dependencies](https://img.shields.io/badge/dependencies-0-brightgreen)](https://github.com/lua-ai-global/governance/blob/main/packages/governance/package.json)
[![types](https://img.shields.io/npm/types/governance-sdk)](https://www.npmjs.com/package/governance-sdk)
[![license](https://img.shields.io/badge/license-MIT-blue)](https://github.com/lua-ai-global/governance/blob/main/LICENSE)

---

## Why

Every AI agent framework lets you build agents. None of them **govern what those agents actually do at runtime**. `governance-sdk` adds policy enforcement, behavioral scoring, injection detection, and compliance auditing to any TypeScript agent — regardless of framework.

Three things make governance real, and this SDK does all three:

1. **Point of interception** — sits between the agent and the tool/LLM *before* it fires
2. **Deterministic agent identity** — knows who's calling (optional Ed25519 signed tokens)
3. **Ability to block or modify** — not just observe after the fact

Everything downstream (scoring, audit, compliance) follows from those three.

**Proof, not promises — tamper-evident audit by default.** Every `enforce()`
decision and `recordOutcome()` outcome can be HMAC hash-chained (opt in with
`integrityAudit: { signingKey }`). Any edit, deletion, or sequence-renumber
breaks chain verification — verifiable offline anywhere with just the
secret. No competitor in the comparison table below ships this.

## How it compares

| | governance-sdk | NVIDIA NeMo Guardrails | Guardrails AI | LangChain guardrails |
|---|:-:|:-:|:-:|:-:|
| Runtime dependencies | **0** | Python runtime + LLM | Python + validator stack | LangChain |
| TypeScript-first | **✅** | ❌ (Python) | ❌ (Python) | ✅ |
| Framework-agnostic | **✅ (12 framework integrations)** | Rails-only | Model-wrapping | LangChain-only |
| Policy *enforcement* (block/approval/mask) | **✅** | ✅ | ✅ | Partial |
| Behavioral scoring / trust levels | **✅** | ❌ | ❌ | ❌ |
| Tamper-evident audit (HMAC chain) | **✅** | ❌ | ❌ | ❌ |
| Standards mapping (EU AI Act / OWASP / NIST / ISO 42001) | **✅** | ❌ | Partial | ❌ |
| Ed25519 agent identity | **✅** | ❌ | ❌ | ❌ |
| Zero-dep embedded use in any TS runtime | **✅** | ❌ | ❌ | ❌ |

`governance-sdk` is the only option that's zero-dep TypeScript, framework-agnostic, and maps to all four major AI-governance standards out of the box.

## Limitations & Honest Scope

The SDK is a **thin client** for local policy evaluation, scoring, and
detection — nothing more. To pre-empt procurement and scope questions, here
is exactly what it does and does not do:

- **Kill switch is per-process**, not fleet-wide. Distributed halt lives in
  Lua Governance Cloud or your own pub/sub.
- **Process isolation is the security model.** The SDK runs as in-process
  TypeScript — `node:vm` is intentionally **not** used as a sandbox (per Node
  docs, it's not a security boundary). For untrusted code execution, isolate
  at the container/VM layer (containers, gVisor, Firecracker). This is a
  deliberate scope choice: the SDK governs *known-trusted* application code
  calling LLMs and tools, not arbitrary attacker-supplied JS.
- **No federation.** Cross-org policy replication and signed posture exchange
  are not currently shipped in either the SDK or Lua Governance Cloud.
- **Injection detection is high-precision / low-recall** — regex baseline F1
  ≈ 0.48 on the 6,931-sample LIB corpus. Layer in an ML classifier via the
  `InjectionClassifier` interface for production coverage.
- **Compliance mapping is self-assessment**, not legal advice or certification.
- **No built-in observability or eval pipeline.** The `metrics` and
  `otel-hooks` exports produce passive in-memory data structures you serialize
  to your own monitoring system; they are NOT OpenInference-compliant and NOT
  a replacement for Phoenix, Langfuse, Braintrust, or a real OpenTelemetry
  exporter. A first-class OTel/OpenInference exporter is on the roadmap.
- **No built-in eval store.** `gov.eval.*` was removed in 0.11. Use inspect-ai,
  PyRIT, Garak, Phoenix, Langfuse, or your harness of choice and route results
  into your audit stream via `gov.audit.log()`.
- **Simulator does not replay side effects** — it evaluates policy outcomes
  against synthetic scenarios, it does not execute tools.
- **`enforce()` does not hash-chain by default** — opt in with
  `integrityAudit: { signingKey }` for tamper-evident audit. Since 0.12
  the chain is persisted durably (survives process restart) when the
  storage adapter supports `createAuditEventWithIntegrity` (memory and
  Postgres adapters both do). HMAC chains are still only tamper-evident
  to holders of the signing secret — rotate and pair with an external
  anchor if you need adversary-grade non-repudiation.
- **Cloud `register()` is a synthetic confirmation** — the API auto-registers
  on first `enforce()`.
- **No built-in red team / jailbreak harness.** Use inspect-ai, PyRIT, or
  Garak — a policy-only harness would be easily mistaken for model coverage.
- **Bedrock is entry-gate only.** The Bedrock adapter scans the prompt
  going into `invokeAgent` and (with a helper) the final response text.
  Tool executions **inside** AWS action groups are opaque — the adapter
  cannot see them, let alone block them. Use `guardToolUse()` to enforce
  at the tool level manually, or push tool calls onto the host side.
- **Multi-modal content is not scanned by default.** Image, PDF, and audio
  blocks on Anthropic/Vercel AI/Genkit/LlamaIndex/Bedrock pass through
  without injection detection in the current release — a vision-enabled
  agent bypasses every input scan unless you wire your own scanner.
  Opt-in per-modality scanning (image OCR, PDF text extract, Whisper for
  audio) is on the near-term roadmap; cost, latency, and data-egress
  considerations mean it will ship as opt-in, not on-by-default.

## Packages

| Package | Description |
|---------|-------------|
| [`governance-sdk`](https://github.com/lua-ai-global/governance/tree/main/packages/governance) | Core SDK — policy engine, scoring, injection detection, audit, compliance, standards mapping, 12 framework integrations (10 featured + MCP toolkit + Bedrock). **0 runtime deps.** |
| [`governance-sdk-platform`](https://github.com/lua-ai-global/governance/tree/main/packages/governance-platform) | Optional PostgreSQL storage layer — auto-migrating schema, org settings, policy tiers. |

## Quick Start

### Install

```bash
# Core SDK (zero dependencies)
npm install governance-sdk

# PostgreSQL storage (optional)
npm install governance-sdk-platform
```

Or scaffold a project with the CLI:

```bash
npx governance-sdk init
```

### Basic Usage

```typescript
import { createGovernance, blockTools, rateLimit } from 'governance-sdk';

const governance = createGovernance({
  rules: [
    blockTools(['shell_exec', 'eval']),
    rateLimit(100, 60_000),  // 100 actions per 60s — host populates ctx.recentActionCount
  ],
});

const result = await governance.enforce({
  agentId: 'support-bot',
  action: 'tool_call',
  tool: 'send_email',
  input: { to: 'user@example.com', body: 'Your ticket has been resolved.' },
});

if (result.outcome === 'block') {
  console.error(`Blocked: ${result.reason}`);
} else {
  // proceed with agent action
}
```

### Cloud Mode (Lua Governance API)

Connect to [Lua Governance Cloud](https://heygovernance.ai) for ML-powered injection detection, approval workflows, fleet analytics, and a real-time dashboard.

```typescript
import { createGovernance } from 'governance-sdk';

const gov = createGovernance({
  serverUrl: 'https://api.heygovernance.ai',
  apiKey: process.env.GOVERNANCE_API_KEY,
  fallbackMode: 'allow', // fail-open if API unreachable (default)
});

// Verify connection at startup
const status = await gov.connect();
console.log(status);
// => { connected: true, mode: 'remote', latencyMs: 45, plan: 'pro', features: [...], agentQuota: { used: 3, limit: 25 } }
```

The SDK retries transient failures with exponential backoff (3 attempts) and falls back gracefully when the API is unreachable — your agent never crashes from a governance outage.

### Approval Flows

When a policy returns `require_approval`, the SDK provides the approval ID and a polling helper:

```typescript
const decision = await gov.enforce({ agentId: 'bot', action: 'deploy', tool: 'prod_deploy' });

if (decision.outcome === 'require_approval') {
  console.log(`Waiting for approval: ${decision.approval?.pollUrl}`);
  const result = await gov.waitForApproval(decision.approvalId!, { timeoutMs: 300_000 });
  if (result === 'approved') {
    // proceed with deployment
  }
}
```

### CLI

```bash
# Scaffold governance in your project
npx governance-sdk init

# Test API connectivity and show diagnostics
GOVERNANCE_API_URL=https://api.heygovernance.ai GOVERNANCE_API_KEY=ak_... npx governance-sdk connect
```

## Features

### Policy Engine

Define rules that govern agent behavior at runtime. Policies return one of **five outcomes**: `allow`, `block`, `warn`, `require_approval`, or `mask` (non-blocking redaction).

**Preset policy builders:**

- `blockTools(toolNames)` — block specific tools from being called
- `allowOnlyTools(toolNames)` — whitelist-only tool access
- `requireApproval(condition)` — gate actions behind human approval
- `tokenBudget(limit)` — enforce token consumption limits
- `rateLimit(config)` — throttle agent requests. **Stateless** — the rule
  reads `ctx.recentActionCount`, which your host populates. Durable
  distributed rate limiting belongs in your API layer.

**Extended presets** (also exported from the main package): `inputBlocklist`,
`inputLength`, `inputPattern`, `networkAllowlist`, `scopeBoundary`,
`costBudget`, `concurrentLimit`, `outputLength`, `outputPattern`,
`sensitiveDataFilter`, `maskSensitiveOutput`, `maskOutputPattern`. Most
rely on the host supplying relevant `ctx.*` fields (token counts, domain,
cost, etc.) — like `rateLimit`, they are declarative gates, not accumulators.
- `requireLevel(level)` — require minimum trust level
- `requireSequence(steps)` — enforce ordered execution steps
- `timeWindow(config)` — restrict actions to time windows
- `requireSignedIdentity()` — require Ed25519 signed agent identity tokens

Policies compose with `policy-compose` for complex rule sets, serialize to YAML (`policy-yaml`), and ship with a fluent `policy-builder`.

### Governance Scoring

7-dimension scoring model quantifying agent trustworthiness: **identity, permissions, observability, guardrails, auditability, compliance, lifecycle.**

```typescript
import { assessAgent, getGovernanceLevel } from 'governance-sdk/scorer';

const assessment = assessAgent('my-agent', {
  name: 'my-agent', framework: 'mastra', owner: 'platform-team',
  hasAuth: true, hasGuardrails: true, hasObservability: true, hasAuditLog: true,
});
// => { compositeScore: 87, level: 4, dimensions: { identity, permissions, ... } }

getGovernanceLevel(assessment.compositeScore);
// => { level: 4, label: 'Certified', description: '...' }
```

Behavioral signals (block rate, injection hits, approval misses) are
available via the optional `behavioral-scorer` module — feed them in to
adjust the score against how the agent *has* behaved, not just its
configured posture. This is opt-in and not wired by default; we plan to
promote dynamic trust scoring as a first-class feature in a future
release.

**Weight rationale + inflation risk**: the default weights
(identity/permissions 1.5; guardrails 1.3; observability 1.2;
auditability/compliance 1.0; lifecycle 0.8) are opinionated, not
research-validated. Override with a custom weight map if your risk profile
differs. Also: the scorer trusts self-reported `hasAuth`/`hasGuardrails`/
`hasObservability`/`hasAuditLog` booleans at face value — to defend against
score inflation, cross-check callers' claims against
`scanRepoContents(fileContents)` from `governance-sdk/repo-patterns` and
flag mismatches. See `src/scorer-dimensions.ts` header comment and
`src/scorer-inflation.test.ts` for the full pattern.

### Injection Detection

54 regex patterns across 7 categories (instruction override, role manipulation,
context escape, data exfiltration, encoding attack, social engineering,
obfuscation). Input normalisation includes: zero-width character stripping,
NFKC Unicode folding (fullwidth/compatibility variants → ASCII), leetspeak
de-obfuscation (`1gn0r3 pr3v10us 1nstruct10ns` → `ignore previous
instructions`), and Base64 decode-and-rescan. Scoring is max-pattern-weight
+ multi-pattern and multi-category boosts, capped at 1.0.

```typescript
import { detectInjection } from 'governance-sdk/injection-detect';

const result = detectInjection(userInput);
if (result.detected) {
  // block or flag the input — score, matched patterns, and category available
}
```

**Lua Injection Benchmark (LIB)** — 6,931 labeled samples (2,096 attacks +
4,835 benign) across 12 sources: TrustAIRLab in-the-wild jailbreak prompts
(1,779), databricks-dolly-15k (1,490), neuralchemy prompt-injection-dataset
(990), jackhhao jailbreak-classification (538), reshabhs SPML (537),
OpenAssistant oasst2 (463), synthesized encoding attacks (458),
llm-semantic-router jailbreak-detection (371), deepset prompt-injections
(114), JailbreakBench JBB-Behaviors (106), synthesized hard negatives (75),
walledai JailbreakHub (10).

**Shipped regex detector baseline on the full 6,931 samples** (reproducible
via `benchmark/scripts/run-full-baseline.ts`; committed report at
[`benchmark/data/lua-injection-benchmark-v1-regex-baseline.json`](https://github.com/lua-ai-global/governance/blob/main/packages/governance/benchmark/data/lua-injection-benchmark-v1-regex-baseline.json)):

| Metric | Value |
|---|---|
| Precision | 68.51% |
| Recall | 37.26% |
| F1 | 48.27% |
| Accuracy | 75.85% |
| False-positive rate | 7.43% |

Reading this honestly: the zero-dep regex detector is a high-precision /
low-recall first layer — good for catching common attack phrasings with few
false positives on benign text, but not a replacement for an ML classifier
on adversarial corpora. Layer in an ML detector via the `InjectionClassifier`
interface (reference implementation in the `governance-ml` package) if you
need stronger recall against in-the-wild jailbreak prompts.

### Tamper-Evident Audit Trail

HMAC-SHA256 hash-chained audit. Each entry's hash covers the **previous hash +
sequence number + canonicalised event body**, so any edit, deletion, or
reorder-via-sequence-renumbering breaks verification. Constant-time hash
comparison throughout — no timing oracle.

**Opt-in via a single config flag.** Pass `integrityAudit: { signingKey }` to
`createGovernance()` and every audit write the SDK makes is chained
automatically — no separate wrapper, no ceremony:

```typescript
import { createGovernance, runWithOutcome } from 'governance-sdk';
import { verifyAuditIntegrity } from 'governance-sdk/audit-integrity-verify';

const gov = createGovernance({
  rules: [/* ... */],
  integrityAudit: {
    signingKey: process.env.AUDIT_SECRET!,
    onFailure: 'allow',   // or 'block' to fail-closed on chain errors
  },
});

// Every one of these is HMAC-chained:
await gov.register({ name: 'sales-bot', framework: 'mastra', owner: 'team' });
await gov.enforce({ agentId, action: 'tool_call', tool: 'search' });

// Close the decision → outcome loop with runWithOutcome():
const result = await runWithOutcome(gov, { agentId, tool: 'search' }, async () => {
  return await searchApi.query(q);
});
// ↑ success (or failure, with error + duration) auto-recorded in the chain

// Verify the chain offline, anywhere, with just the secret:
const chain = await gov.integrityChain!.export();
const { valid, brokenAt, breakDetail } = await verifyAuditIntegrity(chain, process.env.AUDIT_SECRET!);
```

**What gets chained (when `integrityAudit` is set):**

| Event type | Written by | What it captures |
|---|---|---|
| `agent_registered` | `gov.register()` | name, framework, owner, initial score |
| `policy_evaluation` | `gov.enforce()` | agent, action, tool, rule matched, outcome, reason |
| `policy_evaluation_preprocess` / `_postprocess` | `gov.enforcePreprocess()` / `Postprocess()` | stage-scoped enforcement result |
| `action_outcome` | `gov.recordOutcome()` or `runWithOutcome()` | success / failure, duration, tokens, output summary, error |
| `agent_killed` | `killSwitch.kill()` | agent, reason, killedBy |
| *(caller-supplied)* | `gov.audit.log()` | anything you pass — custom LLM calls, approvals, etc. |

**What is NOT automatically chained:** anything you log directly via
`storage.createAuditEvent()` (bypasses the chain), anything your host app
does outside governance (raw `fetch()`, filesystem I/O without going through
a governed tool), and anything the agent did between `enforce()` calls that
didn't invoke `enforce()` or `recordOutcome()` itself.

**Honest caveats:**

- Plain HMAC chains are only tamper-evident to holders of the signing secret.
  If the secret leaks, history is rewritable by the leaker. Rotate secrets
  regularly and pair with an external anchor (periodic checkpoint committed
  to git / a ledger / an external audit service) if you need defence in
  depth.
- Truncation from the tail alone is **NOT** detectable without an external
  anchor — a chain of N events truncated to N-1 events still verifies as a
  consistent chain of N-1 events. The adversarial test suite documents this
  limitation explicitly.
- `integrityAudit.onFailure: 'allow'` (default) means a storage failure
  creates a chain gap that `verifyAuditIntegrity` will detect; set
  `'block'` to reject the enforce() call instead when you can't tolerate
  gaps.

### Kill Switch

Emergency halt for any agent, enforced via a reserved-priority policy rule
(999). User-supplied rules are clamped to a max priority of 998 by the
engine, so the kill switch remains unconditionally top priority — no
"attacker rule at 1000 beats the kill switch" hole.

```typescript
import { createKillSwitch } from 'governance-sdk/kill-switch';

const killSwitch = createKillSwitch(gov);
await killSwitch.kill('rogue-agent', 'Unauthorized data access');
```

**Scope: per-process, not distributed.** The authoritative kill state lives
in-memory on the instance where `kill()` was called. Storage is best-effort
updated so other instances can discover the kill, but they do NOT re-query
storage on every `enforce()` — that would hurt the thin-client design. For
fleet-wide guaranteed halt, route through the governance-cloud remote
`enforce` API or publish kill events over pub/sub and call `kill()` on
every instance.

### Standards self-assessments (EU AI Act, OWASP Agentic, NIST AI RMF, ISO 42001)

Each module emits a **self-assessment report** mapping governance state to a
subset of the named framework. These are engineering tools for posture
tracking — **not** legal advice, not regulatory certifications, and not
substitutes for qualified counsel or a chartered auditor. Each report output
includes its own disclaimer field so downstream consumers see the caveat.

Scope disclosures:

- **EU AI Act** (Reg. (EU) 2024/1689) — covers Arts. 9, 11, 12, 14, 15, 50 only.
  Does NOT model prohibited practices (Art 5-7), data governance (Art 10), or
  GPAI obligations beyond transparency (Arts 51-56). Deadlines are computed
  per-article using the phased enforcement schedule (2025-02-02 prohibited
  practices, 2025-08-02 GPAI transparency, 2026-08-02 high-risk obligations,
  2027-08-02 post-market + downstream).
- **OWASP Agentic** — maps governance state to 10 agentic-threat categories
  (our "AA-01…AA-10" numbering is an internal convention; not the official
  OWASP Top 10 for LLMs 2025 numbering). Inspired by OWASP work, not endorsed
  by it.
- **NIST AI RMF** — 14 subcategories across Govern/Map/Measure/Manage. Does
  NOT yet cover the NIST AI 600-1 GenAI Profile controls (2024).
- **ISO/IEC 42001:2023** — clauses 4-6 and 8-10. Does NOT model the 39 Annex A
  informative controls.

```typescript
import { mapToEuAiAct }      from 'governance-sdk/compliance';     // EU AI Act (6 articles) — preferred
import { mapToOwaspAgentic } from 'governance-sdk/owasp-agentic';   // alias of assessOwaspAgentic
import { mapToNistAiRmf }    from 'governance-sdk/nist-ai-rmf';     // alias of assessNistAiRmf
import { mapToIso42001 }     from 'governance-sdk/iso-42001';       // alias of assessIso42001

const report = await mapToEuAiAct({
  governance: gov, agents: [agent],
  auditIntegrity: true, humanOversight: true,
});
// report.disclaimer — embedded "not legal advice" notice
// report.phasedDeadlines — { prohibitedPractices, gpaiTransparency, highRiskObligations, postMarketAndDownstream }
```

### Agent Identity (Ed25519)

Cryptographically-signed agent identity tokens using Ed25519 (RFC 8032) via
`crypto.subtle`. Zero runtime dependencies. Tokens include a nonce (`jti`),
expiry (`exp`), optional `kid` for key rotation, and the agent's public key
so any verifier can re-check the signature.

Pair with the `requireSignedIdentity()` policy to guarantee that enforce
calls come from an agent that actually holds the private key. Note that the
policy checks a boolean (`ctx.identityVerified`) that your host layer sets
after calling `verifyAgentIdentity()` — the SDK itself stays zero-state.

```typescript
import {
  createEd25519Identity,
  signAgentIdentity,
  verifyAgentIdentity,
} from 'governance-sdk/agent-identity-ed25519';

const identity = createEd25519Identity();
const keys = await identity.generateKeyPair();

const token = await signAgentIdentity({
  agentId: 'sales-bot',
  keys,
  ttlSeconds: 3600,
  kid: 'v2',                  // optional: pick-by-id on rotation
  capabilities: ['search'],   // optional: capability assertions
});

// On the receiving side:
const result = await verifyAgentIdentity(token, {
  pinnedPublicKeyHex: pinnedKey,  // optional but recommended — see below
});
// => { valid: true, agentId: 'sales-bot' }
```

**Pin your public keys.** A token self-describes the public key it was signed
with, so without pinning you're verifying "someone signed this" rather than
"the expected agent signed this." Use `pinnedPublicKeyHex` whenever you
already know which key the agent should be using.

### Dry-Run Simulation

Test policies against scenarios without affecting production.

```typescript
import { simulateFleetPolicy } from 'governance-sdk/dry-run';

const result = await simulateFleetPolicy(gov, scenarios);
// => { fleetSummary: { agentsAffected: 11, blockRate: 0.12 }, results: [...] }
```

## Framework Adapters

Governance needs three things to be real: a **point of interception** (we sit
between the agent and the tool/LLM before it fires), a **deterministic agent
identity** (we know who's calling), and the **ability to block or modify**
(not just observe after the fact). The matrix below is scoped to frameworks
where all three hold.

- **Input pre-scan** — preprocess-stage rules (injection detection, input
  blocklists, token caps) run on the user prompt **before** the LLM sees it.
- **Output post-scan** — postprocess-stage rules (PII masking, output pattern
  blocking, output length) run on the model response **after** generation.
- **Tool-call** — policy evaluation + audit logging around tool/function execution.

### Featured — full LLM + tool coverage (pre + post + streaming + tools)

| Framework | Import Path | Input pre-scan | Output post-scan | Output streaming | Tool-call |
|---|---|:-:|:-:|:-:|:-:|
| Mastra (processor) | `governance-sdk/plugins/mastra-processor` | ✅ | ✅ | ✅ | ✅ |
| Vercel AI SDK | `governance-sdk/plugins/vercel-ai` | ✅ | ✅ | ✅ | ✅ |
| OpenAI Agents SDK | `governance-sdk/plugins/openai-agents` | ✅ | ✅ | ✅¹ | ✅ |
| LangChain | `governance-sdk/plugins/langchain` | ✅ | ✅ | ✅ | ✅ |
| Anthropic SDK | `governance-sdk/plugins/anthropic` | ✅ | ✅ | ✅ | ✅ |
| Google Genkit | `governance-sdk/plugins/genkit` | ✅ | ✅ | ✅ | ✅ |
| LlamaIndex | `governance-sdk/plugins/llamaindex` | ✅ | ✅ | ✅ | ✅ |
| Mistral | `governance-sdk/plugins/mistral` | ✅ | ✅ | ✅ | ✅ |
| Ollama | `governance-sdk/plugins/ollama` | ✅ | ✅ | ✅ | ✅ |
| Mastra (middleware) | `governance-sdk/plugins/mastra` | ✅² | ✅² | ✅² | ✅ |

¹ OpenAI Agents output guardrails fire at stream final assembly (SDK-native behavior).
² Mastra middleware exposes `scanInput` / `scanOutput` / `scanOutputStream` helpers — explicit calls you make from your runtime loop, rather than automatic lifecycle hooks. Use the `mastra-processor` export if you want automatic hooks via `inputProcessors[]` / `outputProcessors[]`.

### Specialty

| Framework | Import Path | Scope |
|---|---|---|
| Model Context Protocol | `governance-sdk/plugins/mcp` | Build a **governed MCP server** — input injection pre-scan on tool arguments + output injection scan + tool-call audit for tools you publish. Not for governing MCP servers you consume (govern those at the agent framework layer). |
| MCP trust + chain audit | `governance-sdk/plugins/mcp-trust`, `governance-sdk/plugins/mcp-chain-audit` | Declarative trusted-MCP-server registry (allowlist + per-server capability tags — **not** cryptographic pin-trust; signature/TLS pinning is not implemented) + caller-driven chain-of-custody audit across nested MCP invocations (requires manual `recordCall()` per hop; not automatic propagation). |
| AWS Bedrock Agents | `governance-sdk/plugins/bedrock` | **Entry-gate only** — Bedrock Agents execute tools server-side inside AWS, so we can pre-scan the `InvokeAgent` input and post-scan the assembled output via `scanOutput`, but we can't see individual internal tool calls. |

### Python, edge runtimes, and other languages

If your agent is **not TypeScript**, use the Lua Governance REST API directly —
it exposes the same policy, scoring, audit, and injection-detection endpoints
the SDK uses locally. Native Python / Go SDKs are not shipped yet; a REST
client works everywhere.

The SDK itself is pure ESM with zero runtime dependencies, so it runs
unmodified under Node, Deno, Bun, Cloudflare Workers, and other Web-standard
runtimes — no separate adapter needed.

All framework dependencies are optional peer dependencies — install only what you use.

### Pre/post usage — four canonical patterns

**Vercel AI SDK** — `experimental_wrapLanguageModel` middleware:

```ts
import { experimental_wrapLanguageModel, generateText } from 'ai';
import { createGovernance } from 'governance-sdk';
import { createGovernanceMiddleware } from 'governance-sdk/plugins/vercel-ai';

const gov = createGovernance({ rules: [/* ... */] });
const { id: agentId } = await gov.register({
  name: 'sales', framework: 'vercel-ai', owner: 'team',
});

const model = experimental_wrapLanguageModel({
  model: openai('gpt-4o'),
  middleware: createGovernanceMiddleware(gov, { agentId }),
});
```

**OpenAI Agents SDK** — native input/output guardrails:

```ts
import { Agent } from '@openai/agents';
import {
  createInputGuardrail,
  createOutputGuardrail,
} from 'governance-sdk/plugins/openai-agents';

const agent = new Agent({
  name: 'research',
  instructions: '...',
  inputGuardrails: [createInputGuardrail(gov, { agentId })],
  outputGuardrails: [createOutputGuardrail(gov, { agentId })],
});
```

**LangChain** — chat model wrapper:

```ts
import { ChatOpenAI } from '@langchain/openai';
import { wrapChatModel } from 'governance-sdk/plugins/langchain';

const model = new ChatOpenAI({ model: 'gpt-4o' });
const guarded = wrapChatModel(model, gov, { agentId });
const res = await guarded.invoke([new HumanMessage('hello')]);
```

**Anthropic SDK** — `messages.create` wrapper:

```ts
import Anthropic from '@anthropic-ai/sdk';
import { createGovernedMessages } from 'governance-sdk/plugins/anthropic';

const client = new Anthropic();
const messages = createGovernedMessages(client.messages, gov, { agentId });
const res = await messages.create({
  model: 'claude-sonnet-4-5', max_tokens: 1024,
  messages: [{ role: 'user', content: 'hi' }],
});
```

Every pre/post adapter accepts `{ preprocess: false }` or `{ postprocess: false }`
to disable a stage. Both stages are on by default.

All adapters handle all 5 enforcement outcomes with configurable callbacks:

```typescript
const middleware = createGovernanceMiddleware(gov, {
  agentName: 'my-agent',
  owner: 'platform-team',
  framework: 'mastra',
  onBlocked: (decision, tool) => log.warn(`Blocked: ${tool}`),
  onWarn: (decision, tool) => log.info(`Warning: ${tool} — ${decision.reason}`),
  onMask: (decision, tool, masked) => log.info(`Masked output for ${tool}`),
  onApprovalRequired: (decision, tool) => log.info(`Approval needed: ${tool}`),
});
```

## Export Paths

The SDK ships **47 targeted exports** so you can import only what you need:

```
# Core
governance-sdk                             createGovernance, enforce, presets
governance-sdk/policy                      policy types and builders
governance-sdk/policy-builder              fluent policy builder
governance-sdk/policy-compose              compose + conflict resolution
governance-sdk/policy-yaml                 serialize/deserialize policies
governance-sdk/dry-run                     simulatePolicy / simulateFleetPolicy

# Scoring
governance-sdk/scorer                      7-dimension governance scoring
governance-sdk/behavioral-scorer           behavioral signal adjustments
governance-sdk/repo-patterns               repository capability detection

# Injection detection
governance-sdk/injection-detect            54-pattern regex detector
governance-sdk/injection-classifier        pluggable ML classifier interface
governance-sdk/injection-benchmark         LIB — 6.9K-sample benchmark runner

# Audit + identity
governance-sdk/audit-integrity             HMAC hash-chain primitives (createIntegrityAudit, verifyAuditIntegrity)
governance-sdk/audit-integrity-verify      standalone chain verifier (for offline audit)
governance-sdk/agent-identity              agent identity tokens
governance-sdk/agent-identity-ed25519      Ed25519 signing + verification
governance-sdk/kill-switch                 priority-999 emergency halt

# Standards / compliance
governance-sdk/compliance                  EU AI Act (6 articles + deadlines)
governance-sdk/owasp-agentic               OWASP Top 10 for LLMs / Agentic
governance-sdk/nist-ai-rmf                 NIST AI RMF (Govern/Map/Measure/Manage)
governance-sdk/iso-42001                   ISO/IEC 42001 controls

# Storage
governance-sdk/storage-postgres            PostgreSQL storage adapter
governance-sdk/storage-postgres-schema     schema DDL + migrations

# Optional observability primitives — passive in-memory, host wires to its own
# monitoring; NOT OpenInference-compliant. A real OTel exporter is on the roadmap.
governance-sdk/events                      typed event emitter
governance-sdk/metrics                     in-memory counter / timing snapshots
governance-sdk/otel-hooks                  governance-prefixed span shape (passive — user must wire)

# Scanner + type surface
governance-sdk/scanner-plugins             scanner plugin interface
governance-sdk/token-types                 token type guards

# Framework integrations (10 featured + MCP toolkit + Bedrock)
governance-sdk/plugins/mastra
governance-sdk/plugins/mastra-processor
governance-sdk/plugins/vercel-ai
governance-sdk/plugins/openai-agents
governance-sdk/plugins/langchain
governance-sdk/plugins/anthropic
governance-sdk/plugins/genkit
governance-sdk/plugins/llamaindex
governance-sdk/plugins/mistral
governance-sdk/plugins/ollama
governance-sdk/plugins/mcp                  # build a governed MCP server
governance-sdk/plugins/mcp-trust            # trusted-server allowlist + capability tags
governance-sdk/plugins/mcp-allowlist        # tool/resource allowlist enforcement
governance-sdk/plugins/mcp-chain-audit      # caller-driven chain-of-custody audit
governance-sdk/plugins/mcp-call-recorder    # nested-invocation call recorder
governance-sdk/plugins/bedrock              # entry-gate only (action groups opaque)
```

`runWithOutcome()` (a thin helper around `gov.recordOutcome`) is exposed at the
top-level package export — `import { runWithOutcome } from 'governance-sdk'`.

## Project Stats

- **0** runtime dependencies
- **1,340** tests, 0 failures (`npm test`)
- **47** export paths — tree-shakeable, import only what you use
- **TypeScript strict mode**, no `any` types in source
- **MIT licensed**

## Development

```bash
# Install dependencies
npm install

# Build all packages
npm run build

# Run tests
npm test

# Type-check without emitting
npm run lint
```

### Requirements

- Node.js **>= 20**
- TypeScript **>= 5.7**

## Contributing

See [CONTRIBUTING.md](https://github.com/lua-ai-global/governance/blob/main/CONTRIBUTING.md). Security issues: see [SECURITY.md](https://github.com/lua-ai-global/governance/blob/main/SECURITY.md).

## License

[MIT](https://github.com/lua-ai-global/governance/blob/main/LICENSE)

## Links

- Homepage: [heygovernance.ai](https://heygovernance.ai)
- Organization: [Lua](https://heylua.ai)
- Repository: [github.com/lua-ai-global/governance](https://github.com/lua-ai-global/governance)
