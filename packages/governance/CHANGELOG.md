# Changelog

## [0.3.0] - 2026-03-10

### Changed
- **Thin-client positioning** — SDK handles local policy evaluation, scoring, injection detection, and adapters. Stateful operations (rate limiting, distributed kill switch, durable audit) are the API layer's responsibility.
- Enterprise modules extracted to separate `@lua-ai-global/governance-enterprise` package (585 tests)
- Expanded from 20 to 33 export paths (15 new framework adapters)
- OSS test count: 935 tests across the governance package
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
- Prompt injection detection (22 patterns, 6 categories)
- HMAC hash-chained audit trail
- EU AI Act compliance mapping (6 articles)
- PostgreSQL storage adapter
- Cloud/remote enforcement via `serverUrl` config

### Changed
- Expanded from 5 to 18 export paths
- Test count: 600 -> 935

## [0.1.0] - 2026-02-15

### Added
- Core governance engine (register, enforce, score)
- Policy engine with presets
- 7-dimension scoring model
- In-memory storage
- Basic compliance checks
- Event emitter + metrics collector
