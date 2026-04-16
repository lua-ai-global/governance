# Changelog

## [0.11.2] - 2026-04-16 — Automate README sync

Adds infrastructure to prevent the npm README from drifting out of sync
with the repo-root README again:

- New `scripts/sync-readme.mjs` — generates `packages/governance/README.md`
  from the root `README.md`, normalizing repo-relative links to absolute
  GitHub URLs so they resolve on npmjs.com. Idempotent.
- Wired into `prepublishOnly` so every npm release ships an in-sync README
  automatically.
- New `npm run sync-readme` at the monorepo root for manual runs.
- CI guard added to `.github/workflows/ci.yml` — fails the build if anyone
  commits a manual edit to the package README without running the sync.

No code changes. SDK behavior identical to 0.11.1.

## [0.11.1] - 2026-04-16 — Sync npm README with repo

The `packages/governance/README.md` (the file npm publishes) had drifted ~3
release cycles behind the repo-root README. This patch syncs the two so
npm users see the same content GitHub viewers see — including the "What
this is NOT" scope disclosures, the 0.11 module removals, and the
behavioral-scorer demotion. Relative links normalized to absolute GitHub
URLs so they resolve correctly when read on npmjs.com.

No code changes. SDK behavior identical to 0.11.0.

## [0.11.0] - 2026-04-15 — Scope honesty pass 2

This release follows up the 0.10 cleanup with another round of cuts based on
a feature-by-feature audit against actual `governance-cloud` consumers and
the major competitors (Microsoft `agent-governance-toolkit`, NeMo Guardrails,
Phoenix, Langfuse, Braintrust). Removes 5 modules with no consumers and no
competitor treating them as load-bearing features, and clarifies framing
around 4 more that ship but were oversold as built-in observability / eval
infrastructure. **1,328 tests** pass with **0 failures**.

### Removed (BREAKING)

- **`governance-sdk/eval-trace`**, **`governance-sdk/eval-scorer`**,
  **`governance-sdk/eval-types`**, and the **`gov.eval`** field on
  `GovernanceInstance`. The in-memory trace ring buffer + naive
  eval-adjustment scoring loop was unused by every audited consumer and
  easily mistaken for a real eval pipeline. Use a dedicated harness
  (inspect-ai, PyRIT, Garak, Phoenix, Langfuse, Braintrust) and route
  results to your audit stream via `gov.audit.log()`.
- **`governance-sdk/plugins/mcp-annotations`** — annotation-rule generator
  was a static template, not a runtime governance feature.
- **`governance-sdk/supply-chain-sbom`** — proprietary `LuaAgentSBOM`
  capability manifest with no producers or consumers. The CycloneDX
  exporter (`governance-sdk/supply-chain-cyclonedx`) and the supply-chain
  policy primitive (`governance-sdk/supply-chain`) remain.
- **`GovernMCPConfig.traceCollector`** field — removed alongside `gov.eval`.
  Tool-call audit events still fire via `gov.audit`.

### Demoted (no API change — README framing only)

- **`metrics`**, **`otel-hooks`**, **`action-recorder`**,
  **`behavioral-scorer`** — remain shipped, but no longer headlined as
  built-in observability / eval / dynamic-trust features. A real OTel +
  OpenInference exporter and a TrustEngine promotion of behavioral
  scoring are on the roadmap.

### Migration

- `gov.eval.submit(...)` callers: stop calling. Eval results should land
  in your existing audit stream or your harness's own store.
- `import { generateAgentSBOM } from 'governance-sdk/supply-chain-sbom'`:
  if you need an SBOM, use `governance-sdk/supply-chain-cyclonedx` instead
  (CycloneDX 1.5, validates against the official schema).
- `import { generateAnnotationRules } from 'governance-sdk/plugins/mcp-annotations'`:
  no replacement; build annotation-aware rules directly with `policy-builder`
  or `policy-yaml`.
- `traceCollector` in `createGovernedMCP(...)` config: drop the field.

### Stats

- 49 → **44** export paths
- 1,358 → **1,328** tests (drop of 30 from removed test files)
- 0 runtime dependencies (unchanged)

## [0.10.0] - 2026-04-15 — Scope honesty release

This release tightens the SDK to the surface we can defend, and is honest
about everything it doesn't do. No new features. The remaining
**1,348 tests** pass with **0 failures**.

### Removed (BREAKING)

- **`governance-sdk/federation`** — was advisory-only posture exchange
  with no distributed protocol or signature enforcement. Cross-cluster
  policy replication and signed posture exchange live in Lua Governance
  Cloud.
- **`governance-sdk/sandbox`** — was a `node:vm` wrapper. `node:vm` is
  not a security boundary (per Node docs; see CVE-2023-32002-class
  escapes). Use OS-level isolation (containers, gVisor, Firecracker)
  for untrusted code. Action-gating is still available as ordinary
  policy rules.
- **`governance-sdk/eval-red-team`** and **`gov.eval.runRedTeam(...)`** —
  was a policy-effectiveness audit, not adversarial jailbreak testing.
  Use a dedicated harness (inspect-ai, PyRIT, Garak) and submit results
  via `gov.eval.submit(...)`.
- **`packages/governance-benchmark`** moved to `research/governance-benchmark/`
  and marked private. It is a research artifact (dataset + harness with
  no shipped ML model) and was never published to npm in shippable form.

### Renamed (additive — old names still work for one minor)

- `dryRun` → **`simulatePolicy`** (preferred)
- `fleetDryRun` → **`simulateFleetPolicy`** (preferred)
- `assessCompliance` → **`mapToEuAiAct`** (preferred), matching
  the existing `mapToIso42001` / `mapToNistAiRmf` / `mapToOwaspAgentic`.

### Documentation

- New **"What this is NOT"** section in the SDK README that pre-empts
  scope questions: kill switch is per-process, sandbox is gone,
  injection F1 ≈ 0.48, compliance mapping is self-assessment, SBOM is
  npm-only, eval is in-memory, simulator does not replay side effects,
  `enforce()` does not hash-chain by default, cloud `register()` is
  a synthetic confirmation, federation lives in Cloud.
- Fixed pattern-count drift: README now says **54 patterns** (matching
  the source files and the published baseline), not "64+".
- Benchmark README now reports the **actual baseline numbers**
  (precision 0.685, recall 0.373, F1 0.483, FP rate 0.074) rather than
  aspirational "≥85%" pass thresholds.
- Clarified scope in `supply-chain.ts` JSDoc: this is allowlist
  validation, not provenance / SLSA / signatures.
- Clarified `remote-enforce.ts` `register()` returns a synthetic
  confirmation; the API auto-registers on first `enforce()`.
- Clarified that `enforce()` writes audit events un-chained by default;
  use `createIntegrityAudit()` for tamper-evident audit.

### Migration

- If you imported from `governance-sdk/federation`, `governance-sdk/sandbox`,
  or `governance-sdk/eval-red-team` — those subpaths are gone. Federation
  + signed posture exchange is in Lua Governance Cloud. Sandbox: use
  OS-level isolation. Red team: use inspect-ai / PyRIT / Garak.
- If you called `gov.eval.runRedTeam(...)`, it no longer exists. Submit
  results from your own harness via `gov.eval.submit(...)`.
- If you used `dryRun` / `fleetDryRun` / `assessCompliance`, those still
  work — but `simulatePolicy` / `simulateFleetPolicy` / `mapToEuAiAct`
  are the preferred names going forward.

## [0.9.0] - 2026-04-14

### Added — full LLM lifecycle coverage across all featured adapters

Every featured adapter now supports **pre-scan on user input**, **post-scan
on model output**, **streaming post-scan** (buffered / sliding / per-chunk),
and **tool-call enforcement**. Shared pre/post + streaming helpers live in
`src/plugins/pre-post-enforce.ts` and `src/plugins/pre-post-stream.ts`.

New exports per adapter:

- **Vercel AI SDK** — `createGovernanceMiddleware` now returns a middleware
  implementing `transformParams` (pre), `wrapGenerate` (post), `wrapStream`
  (streaming post). Config accepts `streamMode`, `streamLookbackChunks`,
  `streamLookbackChars`.
- **Anthropic SDK** — `createGovernedMessages` (wraps `messages.create`),
  `createGovernedMessageStream` (wraps `messages.stream`).
- **LangChain** — `wrapChatModel` overrides `.invoke()` and `.stream()` with
  governance pre/post enforcement. Prototype-preserving.
- **OpenAI Agents SDK** — `createInputGuardrail`, `createOutputGuardrail`
  produce SDK-native guardrail objects. Streaming post-scan is SDK-native
  (fires at final assembly).
- **Mastra Processor** — implements the previously-TODO'd
  `processOutputStream` Mastra lifecycle hook with per-chunk / sliding /
  buffered modes.
- **Mastra middleware** — now exposes `scanInput`, `scanOutput`,
  `scanOutputStream` helpers for explicit pre/post scanning from a custom
  runtime loop.
- **Genkit** — `createGovernedGenerate`, `createGovernedGenerateStream`
  wrap `ai.generate` and `ai.generateStream`.
- **LlamaIndex** — `wrapLlamaLLM` wraps any LLM implementing
  `chat({ messages, stream? })`. Covers non-streaming and streaming paths.
- **Mistral** — `createGovernedChat`, `createGovernedChatStream` wrap
  `chat.complete` and `chat.stream`.
- **Ollama** — `createGovernedOllamaChat`, `createGovernedOllamaChatStream`
  wrap `ollama.chat` in both shapes.
- **MCP** — added symmetric input injection scan on tool-call arguments
  (`scanToolInputs`, `inputInjectionThreshold`) to match the existing
  output scan.
- **Bedrock** — entry-gate pre-scan on `invokeAgent` input + `scanOutput`
  helper for post-scan after the caller drains the streamed response.
  Internal tool calls inside a Bedrock Agent run remain opaque (server-side
  inside AWS).

### Removed

Dropped 8 adapter stubs that didn't meaningfully govern anything:

- `plugins/crewai`, `plugins/autogen`, `plugins/semantic-kernel` — primarily
  Python / C# frameworks; the JS stubs don't map onto the real agent
  runtimes. Python support is via the Lua Governance REST API.
- `plugins/a2a` — inter-agent message protocol, not a tool-call surface.
- `plugins/e2b` — sandbox governance is an AppArmor/seccomp-layer problem,
  not a policy-over-tool-calls problem.
- `plugins/deno`, `plugins/cloudflare-ai` — runtimes / raw model invocation,
  not agent frameworks. The SDK already works in those runtimes without a
  specific adapter.
- `plugins/composio` — redundant; govern at the agent framework layer that
  consumes Composio tools.

The corresponding `package.json` subpath exports, peer dependencies, and
`peerDependenciesMeta` entries have been removed. The previously-public
barrel re-exports `GovernanceBlockedError` and `GovernanceApprovalRequiredError`
remain available from every featured adapter.

### Changed

READMEs refactored to a single **Featured** tier (10 adapters) and a
**Specialty** tier (MCP, Bedrock) with honest scope framing. The prior
"20 adapters" marketing claim is retired.

### Breaking — drop Node 18 support

`engines.node` bumped from `>=18` to `>=20`. Node 18 reached end-of-life
in April 2025 and several existing tests (Ed25519 agent identity,
audit-integrity HMAC chain, agent-identity tokens) require crypto
primitives that aren't reliable on Node 18. CI matrix is now
`[20, 22, 24]`.

## [0.8.0] - 2026-04-07

### Added — Mastra Processor: full lifecycle coverage

The `GovernanceProcessor` plugin (`governance-sdk/plugins/mastra-processor`)
now implements three Mastra processor lifecycle methods. Previously it only
implemented `processOutputStep` (tool-call enforcement). A single processor
instance now covers the entire pipeline:

- **`processInput()`** — runs once before the LLM is invoked. Calls
  `governance.enforcePreprocess()` on the latest user message. This is
  where injection scanning, input blocklists, input length, and any other
  PRE-stage rules fire.
- **`processOutputStep()`** — unchanged. Runs after each LLM response,
  intercepting tool calls before execution. Calls `governance.enforce()`.
- **`processOutputResult()`** — runs once after the agent finishes
  generating, with the resolved final result. Calls
  `governance.enforcePostprocess()` on the agent's response text. This is
  where output filtering, PII redaction, and sensitive-data masking fire.
  On `outcome: 'mask'`, the latest assistant message is mutated in place
  with the SDK-computed `maskedText`.

All three methods call the SDK's public enforce APIs, which means a single
processor works in **both local mode** (in-process policy evaluation) and
**remote mode** (HTTP enforce against the governance cloud). The integrator
controls the transport via `createGovernance({ serverUrl, apiKey })`.

### Added — Per-call metadata enrichment

`GovernanceProcessorConfig` now accepts a `metadataProvider` callback that
runs once per enforce invocation (preprocess, tool call, postprocess) and
returns an object merged into `EnforcementContext.metadata`. The merged
metadata is serialized into the cloud HTTP body and persisted on every
audit event and approval queue entry.

```typescript
new GovernanceProcessor(gov, {
  agentName: 'my-agent',
  owner: 'my-team',
  metadataProvider: (stage, args) => {
    // For Mastra, args.requestContext is the canonical place to read
    // per-request data (userId, channel, threadId, etc.)
    const ctx = args.requestContext;
    return {
      stage,
      userId: ctx?.get('userId'),
      channel: ctx?.get('channel'),
      threadId: ctx?.get('threadId'),
    };
  },
});
```

A `metadata` (static, applied to every call) field is also accepted; per-call
values from `metadataProvider` take precedence on key conflicts.

### Added — Lifecycle-specific config flags

- `skipPreprocess?: boolean` — bypass `processInput` enforcement entirely
- `skipPostprocess?: boolean` — bypass `processOutputResult` enforcement entirely

Both default to `false`. Useful for legacy migration paths and for replay
flows where governance has already approved the call out-of-band.

### Added — Lifecycle-specific callbacks

- `onPreprocessBlocked?: (decision, message) => void` — fired when a
  preprocess rule blocks an inbound user message
- `onPostprocessBlocked?: (decision, output) => void` — fired when a
  postprocess rule blocks the agent's output
- `onApprovalRequired?: (decision, stage) => void` — fired when any stage
  returns `outcome: require_approval`. The `stage` parameter is one of
  `'preprocess' | 'tool_call' | 'postprocess'`
- `onMask?: (decision, original, masked) => void` — fired when a postprocess
  rule returns `outcome: mask`, with both the original text and the
  SDK-computed redacted version

### Added — Type exports

New types exported from `governance-sdk/plugins/mastra-processor`:

- `ProcessInputArgs` — Mastra `processInput` argument shape (mirror)
- `ProcessOutputResultArgs` — Mastra `processOutputResult` argument shape (mirror)
- `MastraOutputResult` — final generation result shape (mirror)
- `GovernanceLifecycleArgs` — union of all argument shapes for `metadataProvider`
- `GovernanceStage` — `'preprocess' | 'tool_call' | 'postprocess'`

### Backwards compatibility

This is an **additive** release. Existing consumers using only
`processOutputStep` see no behavior change — Mastra only calls the new
lifecycle methods if they're implemented, and the implementations are
gated on the new `skipPreprocess` / `skipPostprocess` flags as well as
fail-open if the agent isn't yet registered.

The existing tool-call EnforcementContext now includes any
`metadataProvider` output as well; this is additive — previously the
metadata field was empty.

### Tests

14 new tests covering all new lifecycle methods, metadata threading,
async metadataProvider promise handling, structured-content text
extraction, mask outcome message mutation, skip flags, and the
fail-open paths. Test count: 1201 → 1215.

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
