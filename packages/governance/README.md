# @lua-ai-global/governance

AI Agent Governance for TypeScript — local policy enforcement, scoring, and compliance.

[![Tests](https://img.shields.io/badge/tests-945%2B-brightgreen)]()
[![Zero Dependencies](https://img.shields.io/badge/dependencies-0-blue)]()
[![License: MIT](https://img.shields.io/badge/license-MIT-green)]()

> **Thin client SDK.** Handles policy evaluation, scoring, injection detection, and framework adapters locally. Production guarantees (server-side rate limiting, distributed kill switch, durable audit) belong in your API layer — see [Governance Cloud](#governance-cloud).

## Quick Start

```typescript
import { createGovernance, blockTools } from '@lua-ai-global/governance';

const gov = createGovernance({
  rules: [blockTools(['shell_exec', 'file_delete'])],
});

const decision = await gov.enforce({
  agentId: 'my-agent',
  action: 'tool_call',
  tool: 'shell_exec',
});
// -> { blocked: true, reason: 'Tool blocked by policy', ruleId: '...' }
```

## Features

- **33 export paths** — core, policy, scoring, 20 framework adapters, compliance, audit, and more
- **7-dimension governance scoring** — L0-L4 maturity levels mapped from composite scores
- **EU AI Act compliance mapping** — 6 articles, 18 requirements, deadline tracking
- **Prompt injection detection** — 22 patterns across 6 categories with weighted scoring
- **HMAC hash-chained audit trail** — tamper-evident, immutable event log
- **Kill switch** — priority 999 emergency shutdown, overrides all rules
- **Policy composition** — merge rules from multiple teams with conflict resolution
- **Dry-run simulation** — test policies against your fleet without enforcing
- **Policy suggestion engine** — fleet analysis with ready-to-apply rule recommendations
- **Zero runtime dependencies**

## Framework Adapters

Works with any TypeScript agent framework. First-class adapters for 20 frameworks:

### Mastra

```typescript
import { createGovernanceMiddleware } from '@lua-ai-global/governance/plugins/mastra';

const middleware = await createGovernanceMiddleware(gov, {
  agentName: 'research-agent',
  owner: 'research-team',
});
```

### Mastra Processor

```typescript
import { GovernanceProcessor } from '@lua-ai-global/governance/plugins/mastra-processor';

const processor = new GovernanceProcessor(gov, {
  agentName: 'pipeline-agent',
  owner: 'platform-team',
  abortOnBlock: true,
});
```

### Vercel AI SDK

```typescript
import { createGovernedTools } from '@lua-ai-global/governance/plugins/vercel-ai';

const { tools } = await createGovernedTools(gov, myTools, {
  agentName: 'assistant',
  owner: 'product-team',
});
```

### LangChain / LangGraph

```typescript
import { governTools } from '@lua-ai-global/governance/plugins/langchain';

const { tools } = await governTools(gov, [searchTool, writeTool], {
  agentName: 'research-agent',
  owner: 'research-team',
});
```

### OpenAI Agents SDK

```typescript
import { governAgent } from '@lua-ai-global/governance/plugins/openai-agents';

const { agent: governed } = await governAgent(gov, myAgent, {
  agentName: 'support-agent',
  owner: 'cx-team',
});
```

See the full adapter list in the [API Reference](#api-reference) below.

## Governance Cloud

Connect to Lua Governance Cloud for production-grade enforcement. Same API surface — enforcement runs server-side with Upstash rate limiting, Redis caching, and durable audit:

```typescript
const gov = createGovernance({
  serverUrl: 'https://api.heylua.ai',
  apiKey: process.env.LUA_API_KEY,
});
// Same API — enforcement runs in the cloud
```

Enterprise features (multi-tenant, RBAC, compliance reports, anomaly detection) are in the separate `@lua-ai-global/governance-enterprise` package.

## API Reference

### Core

| Export | Description |
|--------|-------------|
| `@lua-ai-global/governance` | Main entry — `createGovernance()`, policy presets, scoring, suggestions |
| `@lua-ai-global/governance/policy` | Standalone policy engine with condition evaluators |
| `@lua-ai-global/governance/scorer` | 7-dimension governance scoring (L0-L4) |
| `@lua-ai-global/governance/suggest` | Policy suggestion engine with fleet analysis |
| `@lua-ai-global/governance/policy-compose` | Merge policy sets with conflict resolution |
| `@lua-ai-global/governance/dry-run` | Dry-run simulation for CI/CD pipelines |
| `@lua-ai-global/governance/events` | Real-time governance event emitter |
| `@lua-ai-global/governance/metrics` | In-memory counters, timings, snapshots |

### Security & Compliance

| Export | Description |
|--------|-------------|
| `@lua-ai-global/governance/kill-switch` | Emergency agent shutdown (priority 999) |
| `@lua-ai-global/governance/injection-detect` | Prompt injection detection (22 patterns, 6 categories) |
| `@lua-ai-global/governance/audit-integrity` | HMAC hash-chained audit verification |
| `@lua-ai-global/governance/compliance` | EU AI Act compliance mapping (6 articles) |

### Storage

| Export | Description |
|--------|-------------|
| `@lua-ai-global/governance/storage-postgres` | PostgreSQL storage adapter |

### Framework Adapters (20)

| Export | Framework |
|--------|-----------|
| `@lua-ai-global/governance/plugins/mastra` | Mastra middleware |
| `@lua-ai-global/governance/plugins/mastra-processor` | Mastra Processor |
| `@lua-ai-global/governance/plugins/vercel-ai` | Vercel AI SDK |
| `@lua-ai-global/governance/plugins/langchain` | LangChain / LangGraph |
| `@lua-ai-global/governance/plugins/openai-agents` | OpenAI Agents SDK |
| `@lua-ai-global/governance/plugins/anthropic` | Anthropic SDK |
| `@lua-ai-global/governance/plugins/mcp` | Model Context Protocol |
| `@lua-ai-global/governance/plugins/crewai` | CrewAI |
| `@lua-ai-global/governance/plugins/bedrock` | AWS Bedrock |
| `@lua-ai-global/governance/plugins/genkit` | Firebase Genkit |
| `@lua-ai-global/governance/plugins/semantic-kernel` | Microsoft Semantic Kernel |
| `@lua-ai-global/governance/plugins/autogen` | AutoGen |
| `@lua-ai-global/governance/plugins/a2a` | Agent-to-Agent Protocol |
| `@lua-ai-global/governance/plugins/llamaindex` | LlamaIndex |
| `@lua-ai-global/governance/plugins/cloudflare-ai` | Cloudflare AI |
| `@lua-ai-global/governance/plugins/deno` | Deno |
| `@lua-ai-global/governance/plugins/mistral` | Mistral AI |
| `@lua-ai-global/governance/plugins/ollama` | Ollama |
| `@lua-ai-global/governance/plugins/e2b` | E2B |
| `@lua-ai-global/governance/plugins/composio` | Composio |

### Policy Presets

```typescript
import {
  blockTools,        // Block specific tools
  allowOnlyTools,    // Allowlist-only mode
  requireApproval,   // Flag actions for human review
  tokenBudget,       // Per-session token limits
  rateLimit,         // Declarative threshold check (not server-side rate limiting — use governance API for that)
  requireLevel,      // Minimum governance level
  requireSequence,   // Tool prerequisites (e.g., backup before delete)
  timeWindow,        // Restrict to business hours
} from '@lua-ai-global/governance';
```

## Known Limitations

- **`rateLimit` is declarative** — it checks a caller-supplied `recentActionCount` against a threshold. The SDK does not track action counts or enforce server-side rate limits. Use the governance API with Upstash/Redis for production rate limiting.
- **Kill switch is process-local** — a kill switch activated in one process won't propagate to others. Use the governance API for distributed kill switch across a fleet.
- **Audit integrity chain is in-memory** — the HMAC hash chain doesn't survive process restart without re-hydrating from persistent storage. Use PostgreSQL storage adapter or governance API for durable audit.
- **`autoMigrate` has no schema versioning** — it runs `CREATE TABLE IF NOT EXISTS` only. No `ALTER TABLE` for schema changes. Drop and recreate for schema updates, or manage migrations externally.
- **Injection detection is heuristic** — regex-based pattern matching (22 patterns, 6 categories), not LLM-based analysis. Effective for known attack patterns but not adaptive to novel techniques.

## License

MIT — [Lua](https://heylua.ai)
