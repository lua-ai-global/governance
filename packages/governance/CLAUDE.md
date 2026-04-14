# governance-sdk — SDK Development Rules

## WHAT THIS IS
The first standalone governance SDK for TypeScript AI agents. Zero runtime dependencies. MIT license. Thin client — local policy evaluation, scoring, injection detection, and adapters. Stateful operations (rate limiting, distributed kill switch, durable audit) belong in the API layer.

## CURRENT STATE (Post-Audit)
- **1,395+ tests, 0 failures** — run with `npm test`
- **0 runtime dependencies** — only devDependencies (tsx, typescript)
- **Featured adapters (full pre + post + streaming + tool coverage)**: Mastra processor, Mastra middleware, Vercel AI, OpenAI Agents, LangChain, Anthropic, Genkit, LlamaIndex, Mistral, Ollama
- **Specialty adapters**: MCP (governed MCP server builder — input + output injection scans), Bedrock (entry-gate pre-scan + scanOutput helper; can't see internal tool calls)
- **Python / other languages**: use the REST API directly — no JS stubs for non-TS frameworks.

## ABSOLUTE RULES
- **Zero runtime dependencies** — NEVER add a `dependency`. Framework imports go in `peerDependencies` (optional).
- **No `any` types** — use proper TypeScript types throughout.
- **Run tests after EVERY change** — `npm test`. All must pass before committing.
- **<300 LOC per file** — split into modules if approaching limit.
- **Files: `kebab-case.ts`** — Functions/variables: `camelCase`.
- **Commit and push after completing each feature** — `git add <files> && git commit && git push origin main`

## ARCHITECTURE
```
src/
  index.ts              # Main entry — createGovernance(), re-exports
  policy.ts             # Policy engine — conditions, rules, evaluation
  scorer.ts             # 7-dimension governance scoring
  types.ts              # Shared TypeScript types
  kill-switch.ts        # Emergency agent shutdown (priority 999)
  storage-postgres.ts   # PostgreSQL storage adapter (PgPoolLike interface)
  storage-postgres-schema.ts # PostgreSQL schema DDL
  injection-detect.ts   # Prompt injection detection (64+ patterns, 7 categories)
  injection-patterns.ts # Core injection pattern definitions
  injection-patterns-ext.ts # Extended injection patterns
  audit-integrity.ts    # HMAC hash-chained audit verification
  compliance.ts         # EU AI Act compliance assessment (6 articles)
  compliance-articles.ts # EU AI Act article data with deadlines and fines
  behavioral-scorer.ts  # Behavioral signal scoring adjustments
  scorer-dimensions.ts  # 7-dimension scorer implementations (split from scorer.ts)
  policy-presets.ts     # Policy preset builder functions
  repo-patterns.ts      # Repository capability detection
  monorepo-detect.ts    # Monorepo root detection
  plugins/
    mastra.ts           # Mastra middleware adapter
    mastra-processor.ts # Mastra Processor adapter
    vercel-ai.ts        # Vercel AI SDK adapter (+ vercel-ai-middleware.ts, vercel-ai-stream.ts)
    langchain.ts        # LangChain adapter (+ langchain-model.ts, langchain-stream.ts)
    openai-agents.ts    # OpenAI Agents SDK adapter (+ openai-agents-guardrails.ts)
    anthropic.ts        # Anthropic SDK adapter (+ anthropic-messages.ts, anthropic-stream.ts)
    mcp.ts              # Model Context Protocol adapter (governed MCP server)
    bedrock.ts          # AWS Bedrock Agents adapter (entry-gate only)
    genkit.ts           # Firebase Genkit adapter (+ genkit-generate.ts)
    llamaindex.ts       # LlamaIndex adapter (+ llamaindex-llm.ts)
    mistral.ts          # Mistral AI adapter (+ mistral-messages.ts)
    ollama.ts           # Ollama adapter (+ ollama-chat.ts)
  cli/
    init.ts             # CLI scaffolding tool
```

## HOW THE SDK WORKS
1. `createGovernance()` — creates an instance with storage + policy engine
2. `gov.register()` — registers an agent, auto-scores across 7 dimensions
3. `gov.enforce()` — evaluates policies BEFORE an action executes
4. `gov.audit.*` — immutable audit trail (log, query, count)
5. `gov.scoreFleet()` — fleet-wide governance assessment

## ADDING A NEW FEATURE
1. Create `src/feature-name.ts` (<300 LOC)
2. Create `src/feature-name.test.ts` with comprehensive tests
3. Add export to `src/index.ts`
4. Add to `package.json` exports if it needs a separate import path
5. Run `npm test` — all tests must pass
6. Run `npm run build` — must compile clean
7. Commit and push

## ADDING A FRAMEWORK ADAPTER
1. Create `src/plugins/framework-name.ts`
2. Use `PeerDependency` — import types only, never add to `dependencies`
3. Create tests with mock framework objects (don't require real framework)
4. Add to `package.json` exports AND `peerDependencies` + `peerDependenciesMeta`

## KEY DESIGN DECISIONS
- **Thin client** — SDK does local enforcement only. Production rate limiting, distributed kill switch, and durable audit are API-layer concerns.
- **Standalone SDK** — NOT a framework feature. Works with ANY TypeScript agent framework.
- **Before-action enforcement** — policies evaluate BEFORE actions execute, not after.
- **Max-weight scoring for injection** — score = highest pattern weight + boosts for multiple matches.
- **PgPoolLike interface** — accepts any pg.Pool-compatible object without importing pg.
- **Priority 999 for kill switch** — overrides ALL other policy rules.

## GIT RULES
- Imperative mood, <72 chars commit messages
- ALWAYS push to `origin main` after committing
- Pull before committing if remote has changes: `git pull --rebase origin main`
- Never commit generated files (dist/)

## WHAT NOT TO DO
- Don't add runtime dependencies
- Don't break existing tests
- Don't change the public API without updating README.md
- Don't create files >300 LOC
- Don't use `console.log` — remove before commit
