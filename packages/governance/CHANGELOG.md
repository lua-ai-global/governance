# Changelog

## [0.5.0] - 2026-04-02

### Changed
- **Renamed to `governance-sdk`** — unscoped npm package for maximum discoverability
- Package: `@lua-ai-global/governance` → `governance-sdk`
- Platform: `@lua-ai-global/governance-platform` → `governance-sdk-platform`
- Benchmark: `@lua-ai-global/governance-benchmark` → `governance-sdk-benchmark`
- CLI bin: `lua-governance` → `governance-sdk`
- Publish target: npmjs.org (public, unscoped)
- Synced all package versions to 0.5.0

### Migration

```bash
# Old
npm install @lua-ai-global/governance
# New
npm install governance-sdk
```

All import paths stay the same shape — just replace the package name:
```typescript
// Before
import { createGovernance } from '@lua-ai-global/governance';
import { detectInjection } from '@lua-ai-global/governance/injection-detect';

// After
import { createGovernance } from 'governance-sdk';
import { detectInjection } from 'governance-sdk/injection-detect';
```

## [0.4.4] - 2026-04-01

### Added
- PII and prompt leak detection patterns in injection detection
- Stage-aware dry-run and remote enforce forwarding
- Condition registry for pluggable policy conditions

### Fixed
- Broken detection patterns in injection-detect
- Pipeline demo action types for valid PolicyAction values
- `evaluateStage` to use condition-type stage defaults
- Serialize postgres migration per prefix to avoid duplicate pg_type

## [0.4.0] - 2026-03-28

### Added
- **Multi-stage policy engine** with 10 new conditions (preprocess/postprocess pipeline)
- Demo app scaffold with Vite + React + TypeScript

## [0.3.4] - 2026-03-20

### Added
- `KillSwitchState` to platform types and passthrough in queries
- Resolved per-agent policy display in demo app

### Fixed
- Demo app Configure tab remote policy display

## [0.3.3] - 2026-03-15

### Changed
- Remote `register()` is now a local no-op — API auto-registers on enforce
- Refactored policy storage: `saved_policies` as single source of truth
- `loadPolicyTiers` return now includes plan for quota enforcement

### Fixed
- Remote enforce response unwrapping
- Hosted mode: agent picker, policy display, sidebar state

### Added
- Remote config panel to demo app hosted mode
- Examples for hosted and local enforcement

## [0.3.2] - 2026-03-11

### Added
- `behavioral-scorer` export path — behavioral signal scoring adjustments
- `repo-patterns` export path — repository capability detection and scanning
- 35 export paths total

## [0.3.0] - 2026-03-10

### Changed
- **Thin-client positioning** — SDK handles local policy evaluation, scoring, injection detection, and adapters. Stateful operations (rate limiting, distributed kill switch, durable audit) are the API layer's responsibility.
- Enterprise modules extracted to separate `governance-sdk-enterprise` package (585 tests)
- 35 export paths (20 framework adapters + behavioral-scorer + repo-patterns + core modules)
- 935 tests across the governance package
- Removed dead `verbose` flag from `PolicyEngineConfig`

### Fixed
- Audit write isolation (fire-and-forget with `.catch()`)
- SQL injection prevention in `getSchemaSQL()`
- HMAC chain serialization queue (race condition fix)
- Custom evaluator Promise guard (async evaluator detection)
- Read-only `policies` on GovernanceInstance (encapsulation)
- Unicode normalization + cross-field concatenation in injection detection
- Memory storage 10K cap with FIFO eviction
- Kill switch `storageSynced` tracking
- Deep key sorting in canonicalize

### Added
- 15 new framework adapters: Anthropic, MCP, CrewAI, Bedrock, Genkit, Semantic Kernel, AutoGen, A2A, LlamaIndex, Cloudflare AI, Deno, Mistral, Ollama, E2B, Composio
- Adversarial test suite (priority ties, performance, error propagation, mutation safety)
- Known Limitations section in README

## [0.2.0] - 2026-03-10

### Added
- Policy composition engine with conflict resolution
- Dry-run simulation mode
- Policy suggestion engine with fleet analysis
- Kill switch with priority 999
- 5 framework adapters (Mastra MW, Mastra Processor, Vercel AI, LangChain, OpenAI Agents)
- Prompt injection detection (64+ patterns, 7 categories)
- HMAC hash-chained audit trail
- EU AI Act compliance mapping (6 articles)
- PostgreSQL storage adapter
- Cloud/remote enforcement via `serverUrl` config

### Changed
- 18 export paths
- 935 tests

## [0.1.0] - 2026-02-15

### Added
- Core governance engine (register, enforce, score)
- Policy engine with presets
- 7-dimension scoring model
- In-memory storage
- Basic compliance checks
- Event emitter + metrics collector
