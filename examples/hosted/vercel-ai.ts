/**
 * Vercel AI SDK — Governance Enforcement Example
 *
 * Wraps tools with governance enforcement via createGovernedTools.
 * Simulates tool calls against the live enforcement API.
 *
 * Run: GOVERNANCE_API_KEY=sk_... npm run vercel-ai
 */

import { createGovernance } from "@lua-ai-global/governance";
import { createGovernedTools, type VercelToolExecutionOptions } from "@lua-ai-global/governance/plugins/vercel-ai";
import { API_URL, API_KEY } from "../shared/config.ts";
import { printHeader, printResult, INJECTION_PAYLOADS } from "../shared/tools.ts";

printHeader("Vercel AI SDK");

const gov = createGovernance({
  serverUrl: API_URL,
  apiKey: API_KEY,
});

// Simulate Vercel AI SDK tool shape (SDK 6+)
const tools = {
  web_search: {
    description: "Search the web",
    parameters: { type: "object" as const, properties: { query: { type: "string" } } },
    execute: async (input: unknown, _opts: VercelToolExecutionOptions) => {
      const args = input as { query: string };
      return `Results for: ${args.query}`;
    },
  },
  send_email: {
    description: "Send an email",
    parameters: { type: "object" as const, properties: { to: { type: "string" }, subject: { type: "string" } } },
    execute: async (input: unknown, _opts: VercelToolExecutionOptions) => {
      const args = input as { to: string; subject: string };
      return `Sent to ${args.to}`;
    },
  },
  shell_exec: {
    description: "Execute a shell command",
    parameters: { type: "object" as const, properties: { command: { type: "string" } } },
    execute: async (input: unknown, _opts: VercelToolExecutionOptions) => {
      const args = input as { command: string };
      return `Executed: ${args.command}`;
    },
  },
  database_drop: {
    description: "Drop a database table",
    parameters: { type: "object" as const, properties: { table: { type: "string" } } },
    execute: async (input: unknown, _opts: VercelToolExecutionOptions) => {
      const args = input as { table: string };
      return `Dropped: ${args.table}`;
    },
  },
};

console.log("Registering agent and wrapping tools...\n");

const { tools: governed, agentId, score, level, enforce } = await createGovernedTools(gov, tools, {
  agentName: "vercel-ai-example",
  owner: "examples",
  description: "Example agent using Vercel AI SDK adapter",
  hasAuth: true,
  hasGuardrails: true,
  onBlocked: (decision, toolName) => {
    console.log(`  [callback] Tool "${toolName}" was blocked: ${decision.reason}`);
  },
});

console.log(`Agent registered: ${agentId}`);
console.log(`  Score: ${score} | Level: ${level}\n`);
console.log("Running enforcement checks:\n");

const r1 = await enforce("web_search", { query: "AI governance" });
printResult("web_search", r1);

const r2 = await enforce("send_email", { to: "team@example.com", subject: "Report" });
printResult("send_email", r2);

const r3 = await enforce("shell_exec", { command: "rm -rf /" });
printResult("shell_exec", r3);

const r4 = await enforce("database_drop", { table: "users" });
printResult("database_drop", r4);

// Execute a governed tool directly
console.log("\nExecuting governed web_search tool directly...");
try {
  const opts: VercelToolExecutionOptions = { toolCallId: "tc_1", messages: [] };
  const result = await governed.web_search.execute?.({ query: "governance SDK" }, opts);
  console.log(`  Result: ${result}`);
} catch (err) {
  console.log(`  Blocked: ${(err as Error).message}`);
}

// Injection detection — test payloads sent as tool input
console.log("\nInjection detection tests:\n");

for (const payload of INJECTION_PAYLOADS) {
  const r = await enforce("web_search", { query: payload.input });
  printResult(`injection: ${payload.label}`, r);
}

console.log("\nDone.\n");
