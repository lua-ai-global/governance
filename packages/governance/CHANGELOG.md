# Changelog

## [0.15.0] - 2026-04-30 — Tool-result scanning across the framework adapters

0.14 wired tool-result scanning into the Mastra processor and MCP adapter
only. 0.15 rolls the same protection out to the four other adapters that
already do tool wrapping at construction time:

- **LangChain** — `tool.invoke` wrap (in both `governTool` and `governTools`)
- **OpenAI Agents** — `tool.invoke` AND `tool.execute` wraps
- **Genkit** — `tool.call` wrap
- **LlamaIndex** — `tool.call` wrap

For each, the wrapped invoke/call/execute now runs the tool's return value
through `scanToolResult()` (the same shared signal-then-enforce helper
the Mastra processor uses) at stage `tool_result` before returning. On
block, a `{ blocked, reason, ruleId }` redacted detail object replaces
the original output, so the LLM never ingests the poisoned content.

### Added — `scanToolResults` config flag on each adapter

```ts
const { tools } = await governLangChainTools(gov, [searchTool], {
  agentName: "my-agent",
  scanToolResults: true,           // default — opt-out via false
  toolResultInjectionThreshold: 0.5,
});
```

Default `true` (matches the Mastra processor default). Existing callers
who upgrade to 0.15 get tool-result scanning automatically; set
`scanToolResults: false` to skip — useful for test environments that
mock tool returns.

### What didn't change

- **Anthropic / Mistral / Ollama** still use a caller-driven
  `handleToolUse` / `handleToolCall` pattern. Tool-result scanning here
  has to be integrated at the call site by the user — the SDK can't
  intercept transparently. Consider using `gov.scanToolResult()` in
  your handler manually.
- **Vercel AI** — no native tool-wrapping path on this adapter today.
  Tracked as a follow-up; for now use `scanOutput` on model output.
- **Bedrock** — entry-gate only; tool execution happens inside AWS,
  no post-execute hook is exposed by Bedrock Agents.
- **Mastra middleware adapter** (`mastra.ts`, not the processor) — uses
  a different wrap shape; coverage to follow.

### Migration

Drop-in. No public type breakage. The new config fields are optional
and additive. Existing tests that mock tool returns may need
`scanToolResults: false` if they don't expect the helper's path engine
to run on their fixtures.

### Added — `governance-sdk/scan/multi-modal` (opt-in)

Closes the bypass where image, PDF, and audio content blocks pass through
`enforce()` unscanned. Ships orchestration only — actual OCR / PDF parsing
/ ASR are caller-supplied via a registry pattern, preserving the zero-
runtime-dep promise. Mirrors the `InjectionClassifier` shape: pluggable
async scanner + global registry + pre-`enforce()` invocation.

```ts
import {
  registerModalityScanner,
  scanMultiModal,
  isFailClosed,
} from 'governance-sdk/scan/multi-modal';

registerModalityScanner('image', {
  extractText: async (block) => await ocrEngine.recognize(block),
});

const scan = await scanMultiModal(blocks, {
  enabled: ['text', 'image'],
  onMissingScanner: 'block',
  onExtractError: 'block',
  timeoutMs: 5_000,
});

if (scan.failClosed) { /* block before enforce() */ }
// otherwise: feed scan.text into the existing detectInjection / hybridDetect
```

Conservative defaults — every modality except `text` is OFF until the
caller opts in. `onMissingScanner` / `onExtractError` default to `'skip'`;
`timeoutMs` defaults to 30s per block.

`result.failClosed` is pre-evaluated against the policy passed in —
trust it directly. `isFailClosed(result, override?)` is available for
callers wanting to apply a different policy after the fact (defaults to
`result.policy` when no override is given).

Failure modes recorded in `result.blocked[]`:
- `no_scanner` — enabled modality with no extractor registered.
- `extract_error` — scanner threw, rejected, or returned a non-string.
- `extract_timeout` — scanner exceeded `timeoutMs`.

Scanner returning `null` is the documented benign signal "this block has
no extractable text" (e.g. a purely visual image). Recorded in
`result.modalitiesEmpty[]`, NOT `blocked[]`, and never triggers fail-
closed regardless of policy.

### Changed — README honesty pass

- 12 framework integrations (was undercounted as "10")
- 47 export paths (was "44")
- 1,340 tests (was "1,328")
- Plugin export list now lists all 16 paths — previously omitted
  `mcp-allowlist` and `mcp-call-recorder`
- Tamper-evident HMAC audit chain promoted from a body-text mention to a
  hero-section callout (it's a real competitive differentiator)
- Sandboxing reframed: leads with "Process isolation is the security
  model" instead of "No sandbox," same disclaimer scoped as a deliberate
  choice rather than a gap
- "What this is NOT" → "Limitations & Honest Scope"

## [0.14.1] - 2026-04-30 — Field extraction on the `process` stage

`scope_boundary` and `network_allowlist` rules at stage `process` (the
default for those conditions, where pre-execution blocking happens)
silently never fired on tool calls today — `evaluateToolCall` (the path
behind `processOutputStep`) didn't populate `ctx.targetPath` /
`ctx.targetUrl`, and those conditions read those fields exclusively.

0.14.0 wired the field-extraction registry into `wrapTool` (tool_result
stage). 0.14.1 wires it into `evaluateToolCall` too — same registry, same
generic name conventions (`path` / `filePath` / `url` / `href` / ...).
With this fix:

```yaml
- id: block-etc
  condition: { type: scope_boundary, params: { blockedPaths: ["/etc/**"] } }
  outcome: block
  stage: process
```

…now actually blocks `device__lua_desktop__read_file({ path: "/etc/passwd" })`
*before* Desktop runs the read, instead of falling through silently.

### Tests

1,372 tests, 0 failures (+2 — scope_boundary fires on `args.path`,
network_allowlist fires on `args.url`, both at stage process).

## [0.14.0] - 2026-04-30 — `tool_result` stage + `wrapTool` helper

Closes the framework gap where tool-call return content (file contents,
clipboard text, scraped pages, MCP returns) reached the LLM unscanned on
every Mastra agent. The Mastra processor lifecycle has no hook between a
tool's `execute()` returning and the next LLM call — scanning has to
happen inside the tool's execute. The new `wrapTool` / `wrapTools`
methods on `GovernanceProcessor` close that gap at construction time.

### Added — `"tool_result"` PolicyStage

Four stages now: `preprocess` → `process` → `tool_result` → `postprocess`.

```ts
export type PolicyStage = "preprocess" | "process" | "tool_result" | "postprocess";
```

`tool_result` is structurally distinct from `postprocess`:
- **postprocess** — agent's final output to the user. Threat: agent leaks
  credentials/PII. Default conditions: `output_pattern`, `output_length`,
  `sensitive_data_filter`.
- **tool_result** — content a tool returned, before the LLM ingests it on
  the next turn. Threat: external content carries prompt injection that
  poisons the LLM context. Default condition: `ml_injection_guard`.

Existing rules continue to fire at their original stage. Only condition
*defaults* shifted (`ml_injection_guard` → `tool_result`); explicit
`stage:` on a rule always wins.

### Added — `governance.enforceToolResult(ctx)`

Symmetric with `enforcePreprocess` / `enforcePostprocess`. Evaluates only
rules at the `tool_result` stage.

### Added — `scanToolResult()` helper (signal-then-enforce)

```ts
import { scanToolResult } from "governance-sdk";

const { result, blocked, decision } = await scanToolResult({
  governance: gov,
  agentId, tool, args, result: toolReturnValue,
  fields: { targetPath: "/path/from/args" }, // optional, enables scope_boundary
});
```

The helper does the orchestration: extracts scannable text from any
return shape, runs `detectInjection()` to populate
`ctx.mlInjectionScore`, calls the engine at `stage: "tool_result"`,
substitutes a redacted `BlockedToolResult` on block.

**Pattern: `detectInjection` is never a decision-maker.** It's a signal
generator. The policy engine — evaluating every applicable rule with all
its composites and priority — is always the sole decision-maker, in both
local mode (engine in-process) and cloud mode (engine via `enforce()`
HTTP).

### Added — `GovernanceProcessor.wrapTool` / `wrapTools`

The Mastra adapter for the helper above. Wrap individual tools or a tools
dict before handing to a Mastra `Agent`:

```ts
const agent = new Agent({
  tools: processor.wrapTools({ read_file, write_file, take_screenshot }),
  ...
});
```

Wrapped tools' `execute()` runs the original, scans the result, returns
either the original (allow) or a redacted `{ blocked, reason, ruleId }`
(block / require_approval). The LLM sees the redacted detail and adapts
naturally on its next turn.

Config flags on `GovernanceProcessorConfig`:
- `scanToolResults` — master switch, default `true`
- `toolResultScans: { [name]: "always" | "never" }` — per-tool override
- `toolResultInjectionThreshold` — local detection threshold, default 0.5
- `toolFieldExtraction` — per-tool registry mapping arg names to context
  fields (e.g. `{ "read_file": { path: "targetPath" } }`). Generic
  defaults cover `path`/`filePath`/`url`/`href`/`uri`/`endpoint`.

### Added — `toolFieldExtraction` registry (closes Gap B)

Without field extraction, rules like
`scope_boundary: { allowedPaths: ["/project/**"] }` silently never fire
— the engine reads `ctx.targetPath`, not raw `args.path`. The new
registry copies fields off the tool's input args onto the right
`EnforcementContext` fields before `enforce()` runs. Same registry feeds
both pre-call (`processOutputStep`) and post-call (`wrapTool`) scans.

### Changed — MCP adapter delegates to the policy engine

The MCP plugin's tool-output scan previously ran `detectInjection()`
inline and threw on detection — bypassing the policy engine. As of 0.14
it calls `scanToolResult()`, giving rule authors composite power
(`sensitive_data_filter`, `output_pattern`, `scope_boundary`,
`require_approval` outcomes, kill switch) on tool-output content.

**Behaviour change:** the block reason now comes from the matched rule
rather than a hard-coded "Injection detected (score: X)". Existing
behaviour is preserved for orgs whose rules look like the old default
(threshold 0.6, `outcome: block`) — but new rules can layer on PII
masking, path scope checks, or LLM-judge overrides on the same scan.

### Changed — default stage for `ml_injection_guard`

Previously unmapped (fell through to `process`). Now defaults to
`tool_result`. Rules with an explicit `stage:` are unaffected; rules
without one and using `ml_injection_guard` will now run at the new
stage. To preserve old behaviour, add `stage: "process"` to the rule.

### Tests

1,370 tests, 0 failures (+30 new tests covering `scanToolResult`,
`wrapTool` / `wrapTools`, field extraction, MCP cleanup behaviour).

### Roadmap (0.15+)

- `trigger_payload` stage for sibling treatment of framework triggers
  (e.g. Desktop's `selection_changed`, `app_focused`).
- Approval persistence — `decision: "always_allow" | "allow_once" |
  "always_block" | "deny_once"` on the approval response, mutating
  policy YAML or cloud rules so subsequent matching calls don't re-ask.
- Clone `wrapTool` / field-extraction shape into the Vercel AI SDK,
  LangChain, and OpenAI Agents adapters.

### Mastra core upstream (parallel)

A `processToolResult?(args)` lifecycle method has been proposed for the
Mastra `Processor` interface. If accepted, `wrapTool` becomes the
backwards-compat shim for older Mastra versions; both paths call the
same `governance.processToolResult(ctx)` core method, so users see no
disruption when the upstream hook lands.

## [0.13.0] - 2026-04-16 — Conventions flip + deprecation notices

Follow-up to 0.12. Two small, deliberate changes that the 0.12 roadmap
promised — committed now so users have runtime notice before 1.0.

### Changed — OTel `conventions` default flips from `"both"` to `"gen_ai"`

`createOtelHooks()` now defaults to emitting only the GenAI semantic
conventions. Governance spans correlate out of the box with Anthropic,
OpenAI, and Vercel-AI SDK spans in Honeycomb / Datadog / New Relic when
you ingest them through the same tracer.

**Migration.** If your dashboards query the legacy `governance.*`
operation names (`governance.enforcement`, `governance.audit`, etc.),
set `conventions: "both"` explicitly:

```ts
createOtelHooks({ conventions: "both" });
```

This keeps the old op names alongside the new `gen_ai.*` attributes,
same as the 0.12 default. `conventions: "governance"` disables GenAI
emission entirely for customers who cannot adopt the spec yet.

### Changed — `createMCPTrustRegistry` and `createChainAuditor` now warn

Both of these names misrepresented what the functions do. The honest
names (`createMCPAllowlist` and `createMCPCallRecorder`) shipped in
0.12 as path re-exports, and 0.13 adds a one-shot `console.warn` when
the old names are called so you see the nudge at runtime, once per
process.

- `createMCPTrustRegistry` → rename to `createMCPAllowlist`
  (path: `governance-sdk/plugins/mcp-allowlist`)
- `createChainAuditor` → rename to `createMCPCallRecorder`
  (path: `governance-sdk/plugins/mcp-call-recorder`)

Removal is scheduled for 1.0. Behaviour is identical across both
names — the internals were refactored into a shared `buildAllowlist` /
`buildCallRecorder` so the honest names call the core directly and
don't trigger the deprecation path.

### Tests

1,340 tests, 0 failures (up from 1,337 — three new tests pinning the
0.13 OTel default).

### Roadmap (0.14+)

Unchanged from the 0.12 CHANGELOG:
- Multi-modal input scanning (image / PDF / audio) on Anthropic /
  Vercel AI / Bedrock / Genkit / LlamaIndex.
- Signed compliance evidence export (EU AI Act + NIST AI RMF).

## [0.12.0] - 2026-04-16 — Trust hardening

Closes the three most load-bearing honesty gaps surfaced by the post-0.11
audit. Theme: the things the SDK already claims must actually hold up under
restart, real observability, and real naming.

### Changed — integrity audit chain is now durable (BREAKING-ISH)

Before 0.12, `integrityAudit: { signingKey }` maintained chain state
(latest hash, sequence, per-event integrity) in a `createGovernance()`
closure. Process restart reset the chain to genesis and every event in
Postgres lost its integrity metadata because the write path never touched
the `integrity_*` columns the schema already defined.

**What changed:**
- `GovernanceStorage` gained three optional methods —
  `createAuditEventWithIntegrity(event, integrity)`, `getChainHead()`,
  `getAuditIntegrity(eventId)`. Memory and Postgres adapters implement
  all three.
- `createGovernance()` now writes the event and its integrity metadata
  in a single `INSERT` when the storage adapter is integrity-aware, and
  resumes the chain from `getChainHead()` on boot. Kill the process
  mid-stream, boot a fresh instance, and `integrityChain.stats()`
  returns the pre-crash sequence; `verifyAuditIntegrity()` passes across
  the restart boundary.
- Third-party storage adapters written against the 0.11 interface still
  work. They fall back to the old in-process integrity map and emit an
  `onAuditError` notice explaining the chain is session-local on that
  adapter.

**Schema:** the base `getSchemaSQL()` now creates the integrity columns
on fresh tables; the existing `getIntegrityMigrationSQL()` remains for
0.11.x tables. Both paths are idempotent (`CREATE TABLE IF NOT EXISTS`,
`ADD COLUMN IF NOT EXISTS`). `integrity_sequence` widened from `INTEGER`
to `BIGINT`. A `UNIQUE` index on `integrity_sequence` enforces no
duplicate sequences even under concurrent writers.

**Honesty update:** the "What this is NOT" section in the README was
rewritten to state what HMAC chains prove and don't prove. No more
"tamper-evident" without the caveat.

### Changed — OTel GenAI semantic conventions

`createOtelHooks()` gained a `conventions: "governance" | "gen_ai" | "both"`
option. `"both"` (the 0.12 default) is additive: existing `governance.*`
attributes and operation names still emit, and `gen_ai.system`,
`gen_ai.request.model`, `gen_ai.usage.input_tokens` /
`gen_ai.usage.output_tokens`, `gen_ai.response.finish_reasons`,
`gen_ai.tool.name`, `gen_ai.tool.call.id` appear alongside when present
in the event detail. `"gen_ai"` switches operation names to the GenAI
form (`gen_ai.policy.evaluate`, `gen_ai.tool.execute`,
`gen_ai.agent.register`, `gen_ai.audit.log`) so governance spans can
correlate with Anthropic / OpenAI / Vercel-AI SDK spans in Honeycomb /
Datadog / New Relic. The default flips to `"gen_ai"` in 0.13.

### Changed — honest naming for MCP plugins

`createMCPTrustRegistry` is a URI allowlist, not a cryptographic trust
registry; `createChainAuditor` records caller-reported MCP calls, not
auto-propagated sub-calls. Both are now also exported under honest
names:

- `createMCPAllowlist` (new export path:
  `governance-sdk/plugins/mcp-allowlist`)
- `createMCPCallRecorder` (new export path:
  `governance-sdk/plugins/mcp-call-recorder`)

The original exports stay at their original paths and behave
identically. Rename on your next touch of the file; no rush.

### Fixed — remote status staleness after 4xx errors

`createRemoteEnforcer().status()` flipped `connected: false` whenever
the last `enforce()` call threw a `RemoteEnforcementError`, even on a
non-retryable 4xx. A 4xx means the API answered us — the connection is
fine. Status now stays `connected: true` through API-layer errors and
only reports `connected: false` on a network/timeout failure.

### Roadmap (0.13+)

Not in this release; on the roadmap:
- Shipped ML injection classifier as an opt-in peer-dep package.
- Multi-modal input scanning (image / PDF / audio) on Anthropic / Vercel
  AI / Genkit / LlamaIndex / Bedrock.
- Compliance evidence export (signed, dated dossiers).

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
