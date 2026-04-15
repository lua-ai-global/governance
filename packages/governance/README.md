# governance-sdk

**AI Agent Governance for TypeScript** — policy enforcement, behavioral scoring, injection detection, tamper-evident audit, and standards-mapped compliance for AI agents. **Zero runtime dependencies.**

[![npm version](https://img.shields.io/npm/v/governance-sdk)](https://www.npmjs.com/package/governance-sdk)
[![CI](https://github.com/lua-ai-global/governance/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/lua-ai-global/governance/actions/workflows/ci.yml)
[![install size](https://packagephobia.com/badge?p=governance-sdk)](https://packagephobia.com/result?p=governance-sdk)
[![dependencies](https://img.shields.io/badge/dependencies-0-brightgreen)](./packages/governance/package.json)
[![types](https://img.shields.io/npm/types/governance-sdk)](https://www.npmjs.com/package/governance-sdk)
[![license](https://img.shields.io/badge/license-MIT-blue)](./LICENSE)

---

## Why

Every AI agent framework lets you build agents. None of them **govern what those agents actually do at runtime**. `governance-sdk` adds policy enforcement, behavioral scoring, injection detection, and compliance auditing to any TypeScript agent — regardless of framework.

Three things make governance real, and this SDK does all three:

1. **Point of interception** — sits between the agent and the tool/LLM *before* it fires
2. **Deterministic agent identity** — knows who's calling (optional Ed25519 signed tokens)
3. **Ability to block or modify** — not just observe after the fact

Everything downstream (scoring, audit, compliance) follows from those three.

## How it compares

| | governance-sdk | NVIDIA NeMo Guardrails | Guardrails AI | LangChain guardrails |
|---|:-:|:-:|:-:|:-:|
| Runtime dependencies | **0** | Python runtime + LLM | Python + validator stack | LangChain |
| TypeScript-first | **✅** | ❌ (Python) | ❌ (Python) | ✅ |
| Framework-agnostic | **✅ (10 adapters)** | Rails-only | Model-wrapping | LangChain-only |
| Policy *enforcement* (block/approval/mask) | **✅** | ✅ | ✅ | Partial |
| Behavioral scoring / trust levels | **✅** | ❌ | ❌ | ❌ |
| Tamper-evident audit (HMAC chain) | **✅** | ❌ | ❌ | ❌ |
| Standards mapping (EU AI Act / OWASP / NIST / ISO 42001) | **✅** | ❌ | Partial | ❌ |
| Supply-chain / SBOM / Ed25519 identity | **✅** | ❌ | ❌ | ❌ |
| Zero-dep embedded use in any TS runtime | **✅** | ❌ | ❌ | ❌ |

`governance-sdk` is the only option that's zero-dep TypeScript, framework-agnostic, and maps to all four major AI-governance standards out of the box.

## Packages

| Package | Description |
|---------|-------------|
| [`governance-sdk`](./packages/governance) | Core SDK — policy engine, scoring, injection detection, audit, compliance, standards mapping, 10 framework adapters. **0 runtime deps.** |
| [`governance-sdk-platform`](./packages/governance-platform) | Optional PostgreSQL storage layer — auto-migrating schema, org settings, policy tiers. |

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
    rateLimit({ maxRequests: 100, windowMs: 60_000 }),
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
- `rateLimit(config)` — throttle agent requests
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

Behavioral signals (block rate, injection hits, approval misses) feed back in via `behavioral-scorer`, so the score tracks how an agent *actually* behaves in production — not just its configured posture.

### Injection Detection

54 patterns across 7 categories (instruction override, role manipulation, context escape, data exfiltration, encoding, social engineering, obfuscation) with Base64/Unicode/leetspeak normalization and max-weight scoring.

```typescript
import { detectInjection } from 'governance-sdk/injection-detect';

const result = detectInjection(userInput);
if (result.detected) {
  // block or flag the input — score, matched patterns, and category available
}
```

**Lua Injection Benchmark (LIB)** — 6,931 labeled samples (2,096 attacks + 4,835 benign) from deepset, jackhhao, hackaprompt, Harelix, plus synthesized encoding attacks and hard negatives. Plug in any ML detector via `InjectionClassifier` interface and run: `npx tsx benchmark/scripts/run-benchmark.ts`.

### Tamper-Evident Audit Trail

HMAC-SHA256 hash-chained audit. Every entry binds to the cryptographic hash of the previous entry — any tampering (edit, delete, reorder) is mathematically detectable.

```typescript
import { verifyAuditIntegrity } from 'governance-sdk/audit-integrity';

// After an adversary modifies, reorders, or deletes any audit row:
const { valid, firstBrokenIndex, reason } = await verifyAuditIntegrity(entries, secret);
// => { valid: false, firstBrokenIndex: 42, reason: 'hash_mismatch' }
```

You get **byte-level proof** of what happened, not a log file that an attacker can silently edit.

### Kill Switch

Emergency halt for any agent, enforced at priority 999 (overrides all other policies).

```typescript
import { createKillSwitch } from 'governance-sdk/kill-switch';

const killSwitch = createKillSwitch(gov);
await killSwitch.kill('rogue-agent', 'Unauthorized data access');
```

### Standards Mapping (EU AI Act, OWASP Agentic, NIST AI RMF, ISO 42001)

Policy decisions, audit entries, and agent posture map to the four major AI-governance standards. Auditable out of the box — no secondary tooling required.

```typescript
import { assessCompliance, getDaysUntilDeadline } from 'governance-sdk/compliance'; // EU AI Act
import { mapToOwaspAgentic } from 'governance-sdk/owasp-agentic';                    // OWASP Top 10 for LLMs / Agentic
import { mapToNistAiRmf } from 'governance-sdk/nist-ai-rmf';                          // NIST AI RMF Govern/Map/Measure/Manage
import { mapToIso42001 } from 'governance-sdk/iso-42001';                             // ISO/IEC 42001 controls

const report = await assessCompliance({
  governance: gov, agents: [agent],
  auditIntegrity: true, humanOversight: true,
});
```

### Agent Identity (Ed25519)

Cryptographically-signed agent identity tokens. Pair with the `requireSignedIdentity()` policy to guarantee that enforce calls come from an agent that actually holds the private key, not a spoof.

```typescript
import { signAgentIdentity, verifyAgentIdentity } from 'governance-sdk/agent-identity-ed25519';

const token = await signAgentIdentity({ agentId, keys, ttlSeconds: 3600 });
// …send token alongside enforce calls; server verifies with public key
```

### Supply Chain Validation + SBOM

Validate agent dependencies (tools, MCP servers, API endpoints) against an
approved-registry allowlist, and emit CycloneDX 1.5 SBOMs from npm
lockfiles. Allowlist validation, not provenance / signatures / SLSA.
Yarn, pnpm, and cargo are not supported.

```typescript
import { validateSupplyChain } from 'governance-sdk/supply-chain';
import { generateCycloneDxSbom } from 'governance-sdk/supply-chain-cyclonedx';
```

### Policy Simulator

Evaluate policies against scenarios without enforcing. Scope: policy
*decisions* only — does not advance rate-limit counters, token budgets,
or approval queues.

```typescript
import { simulateFleetPolicy } from 'governance-sdk/dry-run';

const result = await simulateFleetPolicy(gov, scenarios);
// => { fleetSummary: { agentsAffected: 11, blockRate: 0.12 }, results: [...] }
```

### Eval Loop

Collect traces from your agent runs and submit eval results from your
preferred adversarial harness (inspect-ai, PyRIT, Garak, your own).
Results feed into the behavioral scorer.

```typescript
import { submitTrace } from 'governance-sdk/eval-trace';

// gov.eval.submit(...) — feed external eval results back into scoring.
// gov.eval.traces — wire into framework adapters to capture run traces.
```

The SDK does not ship its own jailbreak-testing red team. That belongs
in a dedicated tool — we provide the integration point.

## What this is NOT

`governance-sdk` is a thin, in-process TypeScript policy engine. It is
deliberately small and deliberately boring. Know these limits before
adopting:

- **Kill switch is per-process.** Each replica has its own. Distributed
  kill state needs Redis, a control plane, or our hosted service. The
  SDK does not ship one.

- **No sandbox.** We previously shipped a `node:vm` sandbox. We removed
  it: `node:vm` is not a security boundary. Use OS-level isolation
  (containers, gVisor, Firecracker) for untrusted code.

- **Injection detection is regex + an optional ML hook.** The built-in
  detector scores F1 ≈ 0.48 on our public benchmark
  (high-precision / low-recall). Useful as defense-in-depth, not as a
  sole control. Plug a real classifier in via the
  `injection-classifier` interface.

- **Compliance mapping is self-assessment.** EU AI Act, NIST AI RMF,
  ISO 42001, and OWASP Agentic modules cross-reference your policies
  against standards text. Not a certified audit. Not legal advice.

- **SBOM is npm-only.** CycloneDX 1.5 from `package-lock.json` v2/v3.
  Yarn, pnpm, and cargo are not supported in this release.

- **Eval loop is in-memory.** Capped per agent. Durable eval storage
  lives in Lua Governance Cloud.

- **Policy simulator does not replay side effects.** It evaluates rule
  decisions against scenarios — it does not advance rate-limit
  counters, token budgets, or approval queues.

- **`enforce()` does not hash-chain by default.** The integrity chain
  is an opt-in helper. Wrap your audit sink with `createIntegrityAudit()`
  if you want every event chained. Otherwise events are written
  unsigned to local storage.

- **In cloud mode, `register()` returns a synthetic confirmation.**
  Authoritative agent registration happens server-side on the first
  `enforce()` call.

- **Federation is not in this SDK.** Cross-cluster policy replication
  and signed posture exchange live in Lua Governance Cloud.

If you need distributed state, durable audit, fleet-wide enforcement,
or an ML injection classifier, that is in Lua Governance Cloud. The
SDK is MIT and stays useful standalone.

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
| MCP trust + chain audit | `governance-sdk/plugins/mcp-trust`, `governance-sdk/plugins/mcp-chain-audit` | Pin-trusted MCP server registry + end-to-end chain-of-custody audit across nested MCP invocations. |
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

The SDK ships **44 targeted exports** so you can import only what you need:

```
# Core
governance-sdk                             createGovernance, enforce, presets
governance-sdk/policy                      policy types and builders
governance-sdk/policy-builder              fluent policy builder
governance-sdk/policy-compose              compose + conflict resolution
governance-sdk/policy-yaml                 serialize/deserialize policies
governance-sdk/dry-run                     fleet dry-run simulation

# Scoring
governance-sdk/scorer                      7-dimension governance scoring
governance-sdk/behavioral-scorer           behavioral signal adjustments
governance-sdk/repo-patterns               repository capability detection

# Injection detection
governance-sdk/injection-detect            54-pattern regex detector
governance-sdk/injection-classifier        pluggable ML classifier interface
governance-sdk/injection-benchmark         LIB — 6.9K-sample benchmark runner

# Audit + identity
governance-sdk/audit-integrity             HMAC hash-chain verification
governance-sdk/agent-identity              agent identity tokens
governance-sdk/agent-identity-ed25519      Ed25519 signing + verification
governance-sdk/kill-switch                 priority-999 emergency halt

# Standards / compliance
governance-sdk/compliance                  EU AI Act (6 articles + deadlines)
governance-sdk/owasp-agentic               OWASP Top 10 for LLMs / Agentic
governance-sdk/nist-ai-rmf                 NIST AI RMF (Govern/Map/Measure/Manage)
governance-sdk/iso-42001                   ISO/IEC 42001 controls

# Supply chain
governance-sdk/supply-chain                validate supply-chain provenance
governance-sdk/supply-chain-sbom           CycloneDX SBOM generation

# Eval loop + red team
governance-sdk/eval-types                  shared eval types
governance-sdk/eval-scorer                 trace scoring
governance-sdk/eval-trace                  trace submission
governance-sdk/eval-red-team               adversarial test suites

# Runtime + storage
governance-sdk/events                      typed event emitter
governance-sdk/metrics                     Prometheus-style metrics
governance-sdk/otel-hooks                  OpenTelemetry integration
governance-sdk/storage-postgres            PostgreSQL storage adapter
governance-sdk/storage-postgres-schema     schema DDL + migrations
governance-sdk/federation                  multi-org policy federation
governance-sdk/sandbox                     deterministic sandbox execution

# Scanner + type surface
governance-sdk/scanner-plugins             scanner plugin interface
governance-sdk/token-types                 token type guards

# Framework adapters (10 featured + 4 specialty)
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
governance-sdk/plugins/mcp
governance-sdk/plugins/mcp-annotations
governance-sdk/plugins/mcp-trust
governance-sdk/plugins/mcp-chain-audit
governance-sdk/plugins/bedrock
```

## Project Stats

- **0** runtime dependencies
- **1,291** tests, 0 failures (`npm test`)
- **44** export paths — tree-shakeable, import only what you use
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

See [CONTRIBUTING.md](./CONTRIBUTING.md). Security issues: see [SECURITY.md](./SECURITY.md).

## License

[MIT](./LICENSE)

## Links

- Homepage: [heygovernance.ai](https://heygovernance.ai)
- Organization: [Lua](https://heylua.ai)
- Repository: [github.com/lua-ai-global/governance](https://github.com/lua-ai-global/governance)
