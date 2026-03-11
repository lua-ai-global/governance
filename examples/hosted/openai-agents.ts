/**
 * OpenAI Agents SDK — Governance Enforcement Example
 *
 * Wraps an OpenAI-style agent with governance via governAgent.
 * Demonstrates full agent wrapping with tool governance.
 *
 * Run: GOVERNANCE_API_KEY=sk_... npm run openai-agents
 */

import { createGovernance } from "@lua-ai-global/governance";
import { governAgent } from "@lua-ai-global/governance/plugins/openai-agents";
import { API_URL, API_KEY } from "../shared/config.ts";
import { printHeader, printResult, INJECTION_PAYLOADS } from "../shared/tools.ts";

printHeader("OpenAI Agents SDK");

const gov = createGovernance({
  serverUrl: API_URL,
  apiKey: API_KEY,
});

// Simulate OpenAI Agents SDK agent shape
const agent = {
  name: "openai-research-agent",
  instructions: "You are a research agent that finds information and produces reports.",
  tools: [
    {
      type: "function" as const,
      name: "web_search",
      description: "Search the web",
      parameters: { type: "object", properties: { query: { type: "string" } } },
      invoke: async (_ctx: unknown, args: string) => {
        const { query } = JSON.parse(args);
        return `Results for: ${query}`;
      },
    },
    {
      type: "function" as const,
      name: "read_file",
      description: "Read a file from disk",
      parameters: { type: "object", properties: { path: { type: "string" } } },
      invoke: async (_ctx: unknown, args: string) => {
        const { path } = JSON.parse(args);
        return `Contents of ${path}`;
      },
    },
    {
      type: "function" as const,
      name: "shell_exec",
      description: "Execute a shell command",
      parameters: { type: "object", properties: { command: { type: "string" } } },
      invoke: async (_ctx: unknown, args: string) => {
        const { command } = JSON.parse(args);
        return `Executed: ${command}`;
      },
    },
    {
      type: "function" as const,
      name: "database_drop",
      description: "Drop a database table",
      parameters: { type: "object", properties: { table: { type: "string" } } },
      invoke: async (_ctx: unknown, args: string) => {
        const { table } = JSON.parse(args);
        return `Dropped: ${table}`;
      },
    },
  ],
};

console.log("Registering agent and wrapping tools...\n");

const { agent: governed, agentId, score, level, enforce } = await governAgent(gov, agent, {
  agentName: "openai-agents-example",
  owner: "examples",
  description: "Example agent using OpenAI Agents SDK adapter",
  hasAuth: true,
  hasGuardrails: true,
  onBlocked: (decision, toolName) => {
    console.log(`  [callback] Tool "${toolName}" was blocked: ${decision.reason}`);
  },
});

console.log(`Agent registered: ${agentId}`);
console.log(`  Score: ${score} | Level: ${level}\n`);

// Direct enforcement checks
console.log("Running enforcement checks:\n");

const r1 = await enforce("web_search", { query: "AI governance" });
printResult("web_search", r1);

const r2 = await enforce("read_file", { path: "/tmp/report.txt" });
printResult("read_file", r2);

const r3 = await enforce("shell_exec", { command: "rm -rf /" });
printResult("shell_exec", r3);

const r4 = await enforce("database_drop", { table: "users" });
printResult("database_drop", r4);

// Invoke governed tools directly
console.log("\nInvoking governed agent tools:\n");

for (const tool of governed.tools) {
  if (tool.type !== "function" || !tool.invoke) continue;

  const testArgs: Record<string, string> = {
    web_search: JSON.stringify({ query: "test query" }),
    read_file: JSON.stringify({ path: "/tmp/safe.txt" }),
    shell_exec: JSON.stringify({ command: "whoami" }),
    database_drop: JSON.stringify({ table: "temp_cache" }),
  };

  const args = testArgs[tool.name] ?? "{}";

  try {
    const result = await tool.invoke(null, args);
    console.log(`  ALLOWED  ${tool.name} — ${result}`);
  } catch (err) {
    console.log(`  BLOCKED  ${tool.name} — ${(err as Error).message}`);
  }
}

// Injection detection — test payloads sent as tool input
console.log("\nInjection detection tests:\n");

for (const payload of INJECTION_PAYLOADS) {
  const r = await enforce("web_search", { query: payload.input });
  printResult(`injection: ${payload.label}`, r);
}

console.log("\nDone.\n");
