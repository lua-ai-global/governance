# governance-sdk Examples

Runnable examples for every featured framework adapter, in two modes:

| Directory | What it shows |
|-----------|---------------|
| [`local/`](./local) | **Local mode** — `createGovernance({ rules: [...] })` evaluates policies in-process. No network, no API key. Best for learning how policies compose and how adapters intercept calls. |
| [`hosted/`](./hosted) | **Hosted mode** — `createGovernance({ serverUrl, apiKey })` forwards enforce calls to [Lua Governance Cloud](https://heygovernance.ai). Adds ML injection detection, approval workflows, and fleet analytics. |
| [`demo-app/`](./demo-app) | **Full-stack demo** — Vite + React SPA showing the approval UI, fleet scoring dashboard, and per-agent policy inspector against a hosted governance API. |
| [`shared/`](./shared) | Helpers (mock tools, injection payloads, pretty-printer) shared across the scripts above. |

## Setup

```bash
cd examples
npm install
```

## Run a local example (no API key needed)

```bash
npm run local:anthropic     # Anthropic SDK
npm run local:vercel-ai     # Vercel AI SDK
npm run local:mastra        # Mastra processor
npm run local:langchain     # LangChain
npm run local:openai-agents # OpenAI Agents SDK
npm run local:mcp           # Governed MCP server

# Run all at once
npm run local:all
```

## Run a hosted example

Get an API key from [heygovernance.ai](https://heygovernance.ai), then:

```bash
GOVERNANCE_API_KEY=ak_... npm run hosted:anthropic
GOVERNANCE_API_KEY=ak_... npm run hosted:all
```

Optional: override the API URL (defaults to production):

```bash
GOVERNANCE_API_URL=https://api.heygovernance.ai GOVERNANCE_API_KEY=ak_... npm run hosted:vercel-ai
```

## Run the demo app

```bash
cd demo-app
npm install
npm run dev
# Open http://localhost:5173
```

## What each script demonstrates

All scripts exercise the same agent-plus-tool scenario so you can compare how
each adapter intercepts LLM calls and tool invocations:

1. **Policy setup** — `blockTools`, `rateLimit`, and an injection-detection rule
2. **Tool-call enforcement** — a blocked tool returns `outcome: 'block'`
3. **Input pre-scan** — a message containing an injection payload is caught
   before the LLM sees it
4. **Output post-scan** — PII in the model's response is masked via
   `outcome: 'mask'`

Read `shared/tools.ts` and `shared/config.ts` for the shared scaffolding.
