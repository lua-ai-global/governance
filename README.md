# governance-sdk

AI Agent Governance for TypeScript -- policy enforcement, behavioral scoring, compliance, and tamper-evident audit for AI agents. Zero runtime dependencies.

[![npm version](https://img.shields.io/npm/v/governance-sdk)](https://www.npmjs.com/package/governance-sdk)
[![tests](https://img.shields.io/badge/tests-1196%20passing-brightgreen)]()
[![license](https://img.shields.io/badge/license-MIT-blue)](./LICENSE)

---

## Why

Every AI agent framework lets you build agents. None of them govern what those agents actually do at runtime. This SDK adds policy enforcement, behavioral scoring, injection detection, and compliance auditing to any TypeScript agent -- regardless of framework.

## Packages

| Package | Description |
|---------|-------------|
| `governance-sdk` | Core SDK -- policy engine, scoring, injection detection, audit, compliance. Zero runtime deps. |
| `governance-sdk-platform` | PostgreSQL storage layer -- auto-migrating schema, org settings, policy tiers. |

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

Define rules that govern agent behavior at runtime. Policies return one of five outcomes: `allow`, `block`, `warn`, `require_approval`, or `mask`.

**8 preset policy builders:**

- `blockTools(toolNames)` -- block specific tools from being called
- `allowOnlyTools(toolNames)` -- whitelist-only tool access
- `requireApproval(condition)` -- gate actions behind human approval
- `tokenBudget(limit)` -- enforce token consumption limits
- `rateLimit(config)` -- throttle agent requests
- `requireLevel(level)` -- require minimum trust level
- `requireSequence(steps)` -- enforce ordered execution steps
- `timeWindow(config)` -- restrict actions to time windows

Policies compose with `policy-compose` for complex rule sets.

### Governance Scoring

7-dimension scoring model that quantifies agent trustworthiness:

```typescript
import { assessAgent, getGovernanceLevel } from 'governance-sdk/scorer';

const assessment = assessAgent('my-agent', {
  name: 'my-agent', framework: 'mastra', owner: 'platform-team',
  hasAuth: true, hasGuardrails: true, hasObservability: true, hasAuditLog: true,
});
// => { compositeScore: 87, level: 4, dimensions: { identity, permissions, ... } }
const level = getGovernanceLevel(assessment.compositeScore);
// => { level: 4, label: 'Certified', description: '...' }
```

### Injection Detection

64+ patterns across 7 categories to detect prompt injection attacks at the input layer.

```typescript
import { detectInjection } from 'governance-sdk/injection-detect';

const result = detectInjection(userInput);
if (result.detected) {
  // block or flag the input
}
```

### Kill Switch

Emergency halt for any agent, enforced at priority 999 (overrides all other policies).

```typescript
import { createKillSwitch } from 'governance-sdk/kill-switch';

const killSwitch = createKillSwitch(gov);
await killSwitch.kill('rogue-agent', 'Unauthorized data access');
```

### Compliance

EU AI Act coverage with structured article mapping (6 articles, deadline tracking).

```typescript
import { assessCompliance, getDaysUntilDeadline } from 'governance-sdk/compliance';

const daysLeft = getDaysUntilDeadline();
const report = await assessCompliance({
  governance: gov,
  agents: [agent],
  auditIntegrity: true,
  humanOversight: true,
});
```

### Tamper-Evident Audit Trail

HMAC-SHA256 signed audit entries. Every policy decision is logged with a cryptographic chain that detects tampering.

```typescript
import { verifyAuditIntegrity } from 'governance-sdk/audit-integrity';

const valid = await verifyAuditIntegrity(auditLog, secret);
```

### Dry-Run Simulation

Test policies against scenarios without affecting production.

```typescript
import { fleetDryRun } from 'governance-sdk/dry-run';

const result = await fleetDryRun(gov, scenarios);
// => { fleetSummary: { agentsAffected: 11, blockRate: 0.12 }, results: [...] }
```

## Framework Adapters

Drop-in integration with 20 agent frameworks via dedicated plugin exports:

| Framework | Import Path |
|-----------|------------|
| Mastra (middleware) | `governance-sdk/plugins/mastra` |
| Mastra (processor) | `governance-sdk/plugins/mastra-processor` |
| Vercel AI SDK | `governance-sdk/plugins/vercel-ai` |
| LangChain | `governance-sdk/plugins/langchain` |
| OpenAI Agents SDK | `governance-sdk/plugins/openai-agents` |
| Anthropic SDK | `governance-sdk/plugins/anthropic` |
| Model Context Protocol | `governance-sdk/plugins/mcp` |
| CrewAI | `governance-sdk/plugins/crewai` |
| AWS Bedrock | `governance-sdk/plugins/bedrock` |
| Google Genkit | `governance-sdk/plugins/genkit` |
| Semantic Kernel | `governance-sdk/plugins/semantic-kernel` |
| AutoGen | `governance-sdk/plugins/autogen` |
| A2A Protocol | `governance-sdk/plugins/a2a` |
| LlamaIndex | `governance-sdk/plugins/llamaindex` |
| Cloudflare AI | `governance-sdk/plugins/cloudflare-ai` |
| Deno | `governance-sdk/plugins/deno` |
| Mistral | `governance-sdk/plugins/mistral` |
| Ollama | `governance-sdk/plugins/ollama` |
| E2B | `governance-sdk/plugins/e2b` |
| Composio | `governance-sdk/plugins/composio` |

All framework dependencies are optional peer dependencies -- install only what you use.

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

The SDK ships 35 targeted exports so you can import only what you need:

```
governance-sdk            # core: createGovernance, enforce, presets
governance-sdk/policy     # policy types and builders
governance-sdk/scorer     # behavioral scoring engine
governance-sdk/injection-detect
governance-sdk/kill-switch
governance-sdk/compliance
governance-sdk/audit-integrity
governance-sdk/policy-compose
governance-sdk/dry-run
governance-sdk/events
governance-sdk/metrics
governance-sdk/behavioral-scorer
governance-sdk/repo-patterns
governance-sdk/storage-postgres
governance-sdk/storage-postgres-schema
governance-sdk/plugins/*  # 20 framework adapters
```

## Development

```bash
# Install dependencies
npm install

# Build all packages
npm run build

# Run tests (1196 tests, 0 failures)
npm test

# Type-check without emitting
npm run lint
```

### Requirements

- Node.js >= 18
- TypeScript >= 5.7

## License

[MIT](./LICENSE)

## Links

- Homepage: [heygovernance.ai](https://heygovernance.ai)
- Organization: [Lua](https://heylua.ai)
- Repository: [github.com/lua-ai-global/governance](https://github.com/lua-ai-global/governance)
