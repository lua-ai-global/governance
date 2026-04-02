/**
 * LangChain — Governance Enforcement Example
 *
 * Wraps LangChain-style tools with governance via governTools.
 * Demonstrates multi-tool wrapping and governed invoke.
 *
 * Run: GOVERNANCE_API_KEY=sk_... npm run langchain
 */

import { createGovernance } from "governance-sdk";
import { governTools } from "governance-sdk/plugins/langchain";
import { API_URL, API_KEY } from "../shared/config.ts";
import { printHeader, printResult, INJECTION_PAYLOADS } from "../shared/tools.ts";

printHeader("LangChain");

const gov = createGovernance({
  serverUrl: API_URL,
  apiKey: API_KEY,
});

// Simulate LangChain tool shape (DynamicTool-like)
const tools = [
  {
    name: "web_search",
    description: "Search the web for information",
    schema: { type: "object" as const, properties: { query: { type: "string" } } },
    invoke: async (input: unknown) => {
      const args = input as Record<string, unknown>;
      return `Results for: ${args.query}`;
    },
  },
  {
    name: "send_email",
    description: "Send an email to a recipient",
    schema: { type: "object" as const, properties: { to: { type: "string" }, subject: { type: "string" } } },
    invoke: async (input: unknown) => {
      const args = input as Record<string, unknown>;
      return `Sent to ${args.to}: ${args.subject}`;
    },
  },
  {
    name: "shell_exec",
    description: "Execute a shell command on the server",
    schema: { type: "object" as const, properties: { command: { type: "string" } } },
    invoke: async (input: unknown) => {
      const args = input as Record<string, unknown>;
      return `Executed: ${args.command}`;
    },
  },
  {
    name: "database_drop",
    description: "Drop a database table",
    schema: { type: "object" as const, properties: { table: { type: "string" } } },
    invoke: async (input: unknown) => {
      const args = input as Record<string, unknown>;
      return `Dropped: ${args.table}`;
    },
  },
];

console.log("Registering agent and wrapping tools...\n");

const { tools: governed, agentId, score, level } = await governTools(gov, tools, {
  agentName: "langchain-example",
  owner: "examples",
  description: "Example agent using LangChain adapter",
  hasAuth: true,
  onBlocked: (decision, toolName) => {
    console.log(`  [callback] Tool "${toolName}" was blocked: ${decision.reason}`);
  },
});

console.log(`Agent registered: ${agentId}`);
console.log(`  Score: ${score} | Level: ${level}\n`);
console.log("Invoking governed tools:\n");

// Invoke each governed tool
for (const tool of governed) {
  const testInputs: Record<string, Record<string, unknown>> = {
    web_search: { query: "AI governance best practices" },
    send_email: { to: "lead@example.com", subject: "Weekly report" },
    shell_exec: { command: "cat /etc/shadow" },
    database_drop: { table: "user_sessions" },
  };

  const input = testInputs[tool.name] ?? {};

  try {
    const result = await tool.invoke(input);
    printResult(tool.name, { blocked: false, outcome: "allow", reason: `Result: ${result}` });
  } catch (err) {
    printResult(tool.name, { blocked: true, outcome: "block", reason: (err as Error).message });
  }
}

// Injection detection — invoke with malicious payloads
console.log("\nInjection detection tests:\n");

for (const payload of INJECTION_PAYLOADS) {
  try {
    await governed[0].invoke({ query: payload.input });
    printResult(`injection: ${payload.label}`, { blocked: false, outcome: "allow" });
  } catch (err) {
    printResult(`injection: ${payload.label}`, { blocked: true, reason: (err as Error).message });
  }
}

console.log("\nDone.\n");
