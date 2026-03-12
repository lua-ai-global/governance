# @lua-ai-global/governance

AI Agent Governance for TypeScript -- policy enforcement, behavioral scoring, compliance, and tamper-evident audit for AI agents. Zero runtime dependencies.

[![npm version](https://img.shields.io/npm/v/@lua-ai-global/governance)](https://github.com/lua-ai-global/governance/packages)
[![tests](https://img.shields.io/badge/tests-945%2B%20passing-brightgreen)]()
[![license](https://img.shields.io/badge/license-MIT-blue)](./LICENSE)

---

## Why

Every AI agent framework lets you build agents. None of them govern what those agents actually do at runtime. This SDK adds policy enforcement, behavioral scoring, injection detection, and compliance auditing to any TypeScript agent -- regardless of framework.

## Packages

| Package | Description |
|---------|-------------|
| `@lua-ai-global/governance` | Core SDK -- policy engine, scoring, injection detection, audit, compliance. Zero runtime deps. |
| `@lua-ai-global/governance-platform` | PostgreSQL storage layer -- auto-migrating schema, org settings, policy tiers. |

## Quick Start

### Install

```bash
# Core SDK (zero dependencies)
npm install @lua-ai-global/governance --registry=https://npm.pkg.github.com

# PostgreSQL storage (optional)
npm install @lua-ai-global/governance-platform --registry=https://npm.pkg.github.com
```

Or scaffold a project with the CLI:

```bash
npx @lua-ai-global/governance init
```

### Configure npm for GitHub Packages

Add to your project or user `.npmrc`:

```
@lua-ai-global:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${NODE_AUTH_TOKEN}
```

### Basic Usage

```typescript
import { createGovernance, blockTools, rateLimit } from '@lua-ai-global/governance';

const governance = createGovernance({
  policies: [
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

## Features

### Policy Engine

Define rules that govern agent behavior at runtime. Policies return one of four outcomes: `allow`, `block`, `warn`, or `require_approval`.

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
import { assessAgent, getGovernanceLevel } from '@lua-ai-global/governance/scorer';

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
import { detectInjection } from '@lua-ai-global/governance/injection-detect';

const result = detectInjection(userInput);
if (result.detected) {
  // block or flag the input
}
```

### Kill Switch

Emergency halt for any agent, enforced at priority 999 (overrides all other policies).

```typescript
import { createKillSwitch } from '@lua-ai-global/governance/kill-switch';

const killSwitch = createKillSwitch(gov);
await killSwitch.kill('rogue-agent', 'Unauthorized data access');
```

### Compliance

EU AI Act coverage with structured article mapping (6 articles, deadline tracking).

```typescript
import { assessCompliance, getDaysUntilDeadline } from '@lua-ai-global/governance/compliance';

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
import { verifyAuditIntegrity } from '@lua-ai-global/governance/audit-integrity';

const valid = await verifyAuditIntegrity(auditLog, secret);
```

### Dry-Run Simulation

Test policies against scenarios without affecting production.

```typescript
import { fleetDryRun } from '@lua-ai-global/governance/dry-run';

const result = await fleetDryRun(gov, scenarios);
// => { fleetSummary: { agentsAffected: 11, blockRate: 0.12 }, results: [...] }
```

## Framework Adapters

Drop-in integration with 20 agent frameworks via dedicated plugin exports:

| Framework | Import Path |
|-----------|------------|
| Mastra (middleware) | `@lua-ai-global/governance/plugins/mastra` |
| Mastra (processor) | `@lua-ai-global/governance/plugins/mastra-processor` |
| Vercel AI SDK | `@lua-ai-global/governance/plugins/vercel-ai` |
| LangChain | `@lua-ai-global/governance/plugins/langchain` |
| OpenAI Agents SDK | `@lua-ai-global/governance/plugins/openai-agents` |
| Anthropic SDK | `@lua-ai-global/governance/plugins/anthropic` |
| Model Context Protocol | `@lua-ai-global/governance/plugins/mcp` |
| CrewAI | `@lua-ai-global/governance/plugins/crewai` |
| AWS Bedrock | `@lua-ai-global/governance/plugins/bedrock` |
| Google Genkit | `@lua-ai-global/governance/plugins/genkit` |
| Semantic Kernel | `@lua-ai-global/governance/plugins/semantic-kernel` |
| AutoGen | `@lua-ai-global/governance/plugins/autogen` |
| A2A Protocol | `@lua-ai-global/governance/plugins/a2a` |
| LlamaIndex | `@lua-ai-global/governance/plugins/llamaindex` |
| Cloudflare AI | `@lua-ai-global/governance/plugins/cloudflare-ai` |
| Deno | `@lua-ai-global/governance/plugins/deno` |
| Mistral | `@lua-ai-global/governance/plugins/mistral` |
| Ollama | `@lua-ai-global/governance/plugins/ollama` |
| E2B | `@lua-ai-global/governance/plugins/e2b` |
| Composio | `@lua-ai-global/governance/plugins/composio` |

All framework dependencies are optional peer dependencies -- install only what you use.

## Export Paths

The SDK ships 35 targeted exports so you can import only what you need:

```
@lua-ai-global/governance            # core: createGovernance, enforce, presets
@lua-ai-global/governance/policy     # policy types and builders
@lua-ai-global/governance/scorer     # behavioral scoring engine
@lua-ai-global/governance/injection-detect
@lua-ai-global/governance/kill-switch
@lua-ai-global/governance/compliance
@lua-ai-global/governance/audit-integrity
@lua-ai-global/governance/policy-compose
@lua-ai-global/governance/dry-run
@lua-ai-global/governance/events
@lua-ai-global/governance/metrics
@lua-ai-global/governance/behavioral-scorer
@lua-ai-global/governance/repo-patterns
@lua-ai-global/governance/storage-postgres
@lua-ai-global/governance/storage-postgres-schema
@lua-ai-global/governance/plugins/*  # 20 framework adapters
```

## Development

```bash
# Install dependencies
npm install

# Build all packages
npm run build

# Run tests (945+ tests, 0 failures)
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

- Homepage: [heylua.ai/governance](https://heylua.ai/governance)
- Organization: [Lua](https://heylua.ai)
- Repository: [github.com/lua-ai-global/governance](https://github.com/lua-ai-global/governance)
