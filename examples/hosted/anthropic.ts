/**
 * Anthropic Claude SDK — Governance Enforcement Example
 *
 * Wraps tools with governance enforcement via governAnthropicTools.
 * Simulates Claude tool_use blocks against the live enforcement API.
 *
 * Run: GOVERNANCE_API_KEY=sk_... npm run anthropic
 */

import { createGovernance } from "governance-sdk";
import { governAnthropicTools, type AnthropicToolUseBlock } from "governance-sdk/plugins/anthropic";
import { API_URL, API_KEY } from "../shared/config.ts";
import { printHeader, printResult, INJECTION_PAYLOADS } from "../shared/tools.ts";

printHeader("Anthropic Claude SDK");

const gov = createGovernance({
  serverUrl: API_URL,
  apiKey: API_KEY,
});

// Simulate Anthropic tool executors (requires inputSchema)
const tools = [
  {
    name: "web_search",
    inputSchema: { type: "object" as const, properties: { query: { type: "string" } } },
    execute: async (input: Record<string, unknown>) =>
      `Results for: ${input.query}`,
  },
  {
    name: "send_email",
    inputSchema: { type: "object" as const, properties: { to: { type: "string" }, subject: { type: "string" } } },
    execute: async (input: Record<string, unknown>) =>
      `Sent to ${input.to}: ${input.subject}`,
  },
  {
    name: "shell_exec",
    inputSchema: { type: "object" as const, properties: { command: { type: "string" } } },
    execute: async (input: Record<string, unknown>) =>
      `Executed: ${input.command}`,
  },
  {
    name: "database_drop",
    inputSchema: { type: "object" as const, properties: { table: { type: "string" } } },
    execute: async (input: Record<string, unknown>) =>
      `Dropped: ${input.table}`,
  },
];

console.log("Registering agent and wrapping tools...\n");

const { handleToolUse, agentId, score, level, enforce } = await governAnthropicTools(gov, tools, {
  agentName: "anthropic-example",
  owner: "examples",
  description: "Example agent using Anthropic SDK adapter",
  hasAuth: true,
  onBlocked: (decision, toolName) => {
    console.log(`  [callback] Tool "${toolName}" was blocked: ${decision.reason}`);
  },
});

console.log(`Agent registered: ${agentId}`);
console.log(`  Score: ${score} | Level: ${level}\n`);
console.log("Running enforcement checks:\n");

const r1 = await enforce("web_search", { query: "EU AI Act" });
printResult("web_search", r1);

const r2 = await enforce("shell_exec", { command: "cat /etc/passwd" });
printResult("shell_exec", r2);

const r3 = await enforce("database_drop", { table: "production_data" });
printResult("database_drop", r3);

// Simulate Claude tool_use blocks
console.log("\nSimulating Claude tool_use blocks:\n");

const safeBlock: AnthropicToolUseBlock = {
  id: "tu_1", type: "tool_use", name: "web_search",
  input: { query: "governance" },
  caller: { type: "direct" },
};
try {
  const result = await handleToolUse(safeBlock);
  console.log(`  web_search result: ${JSON.stringify(result)}`);
} catch (err) {
  console.log(`  web_search blocked: ${(err as Error).message}`);
}

const dangerousBlock: AnthropicToolUseBlock = {
  id: "tu_2", type: "tool_use", name: "shell_exec",
  input: { command: "rm -rf /" },
  caller: { type: "direct" },
};
try {
  const result = await handleToolUse(dangerousBlock);
  console.log(`  shell_exec result: ${JSON.stringify(result)}`);
} catch (err) {
  console.log(`  shell_exec blocked: ${(err as Error).message}`);
}

// Injection detection — test payloads sent as tool input
console.log("\nInjection detection tests:\n");

for (const payload of INJECTION_PAYLOADS) {
  const r = await enforce("web_search", { query: payload.input });
  printResult(`injection: ${payload.label}`, r);
}

console.log("\nDone.\n");
