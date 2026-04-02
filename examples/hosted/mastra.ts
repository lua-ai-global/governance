/**
 * Mastra — Governance Enforcement Example
 *
 * Uses createGovernanceMiddleware to wrap tools with enforcement.
 * Demonstrates both wrapTool and wrapTools patterns.
 *
 * Run: GOVERNANCE_API_KEY=sk_... npm run mastra
 */

import { createGovernance } from "governance-sdk";
import { createGovernanceMiddleware } from "governance-sdk/plugins/mastra";
import { API_URL, API_KEY } from "../shared/config.ts";
import { printHeader, printResult, INJECTION_PAYLOADS } from "../shared/tools.ts";

printHeader("Mastra");

const gov = createGovernance({
  serverUrl: API_URL,
  apiKey: API_KEY,
});

console.log("Creating governance middleware...\n");

const middleware = await createGovernanceMiddleware(gov, {
  agentName: "mastra-example",
  owner: "examples",
  description: "Example agent using Mastra middleware adapter",
  hasAuth: true,
  hasGuardrails: true,
  hasAuditLog: true,
  onBlocked: (decision, toolName) => {
    console.log(`  [callback] Tool "${toolName}" was blocked: ${decision.reason}`);
  },
});

console.log(`Agent registered: ${middleware.agentId}`);
console.log(`  Score: ${middleware.score} | Level: ${middleware.level}\n`);

// Wrap tools using wrapTools (batch) — typed as Record<string, (input: Record<string, unknown>) => Promise<unknown>>
const rawTools: Record<string, (input: Record<string, unknown>) => Promise<unknown>> = {
  web_search: async (input) => `Results for: ${input.query}`,
  send_email: async (input) => `Sent to ${input.to}`,
  shell_exec: async (input) => `Executed: ${input.command}`,
  database_drop: async (input) => `Dropped: ${input.table}`,
};

const governed = middleware.wrapTools(rawTools);

// Direct enforcement checks
console.log("Running enforcement checks:\n");

const r1 = await middleware.beforeToolCall("web_search", { query: "governance" });
printResult("web_search (beforeToolCall)", r1);

const r2 = await middleware.beforeToolCall("shell_exec", { command: "whoami" });
printResult("shell_exec (beforeToolCall)", r2);

// Execute governed tools
console.log("\nExecuting governed tools:\n");

try {
  const result = await governed.web_search({ query: "AI safety" });
  console.log(`  web_search: ${result}`);
  await middleware.afterToolCall("web_search", "success");
} catch (err) {
  console.log(`  web_search blocked: ${(err as Error).message}`);
}

try {
  const result = await governed.shell_exec({ command: "rm -rf /" });
  console.log(`  shell_exec: ${result}`);
} catch (err) {
  console.log(`  shell_exec blocked: ${(err as Error).message}`);
}

// Wrap a single tool using wrapTool
console.log("\nSingle tool wrapping with wrapTool:\n");

const govSearch = middleware.wrapTool(
  "web_search",
  async (input: Record<string, unknown>) => `[single] Results for: ${input.query}`,
);

try {
  const result = await govSearch({ query: "single wrap test" });
  console.log(`  wrapTool result: ${result}`);
} catch (err) {
  console.log(`  wrapTool blocked: ${(err as Error).message}`);
}

// Injection detection — test payloads sent as tool input
console.log("\nInjection detection tests:\n");

for (const payload of INJECTION_PAYLOADS) {
  const r = await middleware.beforeToolCall("web_search", { query: payload.input });
  printResult(`injection: ${payload.label}`, r);
}

console.log("\nDone.\n");
