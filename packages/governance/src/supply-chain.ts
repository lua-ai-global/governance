/**
 * governance-sdk — Agent Supply Chain Security
 *
 * Declare agent dependencies, validate against approved registries,
 * and enforce supply chain policies. Addresses OWASP AA-03.
 *
 * @example
 * ```ts
 * import { createSupplyChainPolicy, declareAgentDependencies } from 'governance-sdk/supply-chain';
 *
 * const deps = declareAgentDependencies({
 *   tools: ['web_search', 'email_send'],
 *   mcpServers: ['mcp://files.company.com'],
 *   apiEndpoints: ['https://api.internal.com'],
 * });
 *
 * const policy = createSupplyChainPolicy({
 *   approvedTools: ['web_search', 'email_send', 'calendar_read'],
 *   approvedMcpServers: ['mcp://files.company.com'],
 * });
 * governance.addRule(policy);
 * ```
 */

import type { PolicyRule } from "./policy.js";

// ─── Types ───────────────────────────────────────────────────

/** Declared dependencies for an agent */
export interface AgentDependencies {
  tools?: string[];
  mcpServers?: string[];
  apiEndpoints?: string[];
  agents?: string[];
}

/** Approved supply chain registry */
export interface ApprovedRegistry {
  approvedTools?: string[];
  approvedMcpServers?: string[];
  approvedApiEndpoints?: string[];
  approvedAgents?: string[];
}

/** Validation result for a single agent's supply chain */
export interface SupplyChainValidation {
  valid: boolean;
  violations: SupplyChainViolation[];
}

export interface SupplyChainViolation {
  type: "tool" | "mcp_server" | "api_endpoint" | "agent";
  name: string;
  reason: string;
}

// ─── Dependency Declaration ─────────────────────────────────

/** Declare and normalize an agent's dependency set */
export function declareAgentDependencies(deps: AgentDependencies): AgentDependencies {
  return {
    tools: deps.tools ? [...new Set(deps.tools)].sort() : [],
    mcpServers: deps.mcpServers ? [...new Set(deps.mcpServers)].sort() : [],
    apiEndpoints: deps.apiEndpoints ? [...new Set(deps.apiEndpoints)].sort() : [],
    agents: deps.agents ? [...new Set(deps.agents)].sort() : [],
  };
}

// ─── Validation ─────────────────────────────────────────────

/** Validate agent dependencies against an approved registry */
export function validateSupplyChain(
  deps: AgentDependencies,
  registry: ApprovedRegistry,
): SupplyChainValidation {
  const violations: SupplyChainViolation[] = [];

  if (registry.approvedTools) {
    for (const tool of deps.tools ?? []) {
      if (!registry.approvedTools.includes(tool)) {
        violations.push({ type: "tool", name: tool, reason: `Tool "${tool}" not in approved registry` });
      }
    }
  }

  if (registry.approvedMcpServers) {
    for (const server of deps.mcpServers ?? []) {
      if (!registry.approvedMcpServers.includes(server)) {
        violations.push({ type: "mcp_server", name: server, reason: `MCP server "${server}" not approved` });
      }
    }
  }

  if (registry.approvedApiEndpoints) {
    for (const ep of deps.apiEndpoints ?? []) {
      if (!registry.approvedApiEndpoints.includes(ep)) {
        violations.push({ type: "api_endpoint", name: ep, reason: `API endpoint "${ep}" not approved` });
      }
    }
  }

  if (registry.approvedAgents) {
    for (const agent of deps.agents ?? []) {
      if (!registry.approvedAgents.includes(agent)) {
        violations.push({ type: "agent", name: agent, reason: `Agent "${agent}" not in approved list` });
      }
    }
  }

  return { valid: violations.length === 0, violations };
}

// ─── Policy Rule ────────────────────────────────────────────

/**
 * Create a policy rule that blocks agents using unapproved tools.
 * Checks the tool being called against the approved registry.
 */
export function createSupplyChainPolicy(
  registry: ApprovedRegistry,
  opts?: { priority?: number; id?: string },
): PolicyRule {
  const approvedTools = new Set(registry.approvedTools ?? []);

  return {
    id: opts?.id ?? "supply-chain-tool-check",
    name: "Supply chain: block unapproved tools",
    condition: {
      type: "custom",
      params: {
        evaluate: (ctx: { tool?: string }) => {
          if (!ctx.tool) return false;
          return approvedTools.size > 0 && !approvedTools.has(ctx.tool);
        },
      },
    },
    outcome: "block",
    reason: "Tool not in approved supply chain registry",
    priority: opts?.priority ?? 105,
    enabled: true,
    stage: "process",
  };
}
