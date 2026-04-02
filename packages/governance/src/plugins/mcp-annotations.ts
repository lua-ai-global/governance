/**
 * MCP Tool Annotations → Governance Policy Mapping
 *
 * Automatically generates policy rules from MCP tool annotations (spec 2025-11-25).
 * Maps destructiveHint, readOnlyHint, openWorldHint, and idempotentHint to
 * governance policies.
 *
 * @example
 * ```ts
 * import { generateAnnotationRules } from 'governance-sdk/plugins/mcp-annotations';
 *
 * const tools = await mcpClient.listTools();
 * const rules = generateAnnotationRules(tools);
 * // => PolicyRule[] based on each tool's annotations
 *
 * const governance = createGovernance({ rules: [...existingRules, ...rules] });
 * ```
 */

import type { MCPToolDefinition, MCPToolAnnotations } from "./mcp-types.js";
import type { PolicyRule } from "../policy.js";

// ─── Types ───────────────────────────────────────────────────

/** Configuration for annotation-based rule generation */
export interface AnnotationRuleConfig {
  /** Whether destructive tools require approval (default: true) */
  requireApprovalForDestructive?: boolean;
  /** Whether open-world tools get injection scanning (default: true) */
  injectGuardForOpenWorld?: boolean;
  /** Priority offset for generated rules (default: 50) */
  basePriority?: number;
  /** Custom rule ID prefix (default: "mcp-annotation") */
  ruleIdPrefix?: string;
}

// ─── Implementation ─────────────────────────────────────────

/**
 * Generate governance policy rules from MCP tool annotations.
 *
 * Mapping:
 * - `destructiveHint: true` → require_approval (unless readOnlyHint is also true)
 * - `openWorldHint: true` → injection_guard on inputs
 * - `readOnlyHint: true` → no additional rules (safe by default)
 * - Non-idempotent + destructive → higher priority enforcement
 */
export function generateAnnotationRules(
  tools: MCPToolDefinition[],
  config: AnnotationRuleConfig = {},
): PolicyRule[] {
  const {
    requireApprovalForDestructive = true,
    injectGuardForOpenWorld = true,
    basePriority = 50,
    ruleIdPrefix = "mcp-annotation",
  } = config;

  const rules: PolicyRule[] = [];

  for (const tool of tools) {
    const annotations = tool.annotations ?? {};
    const toolName = tool.name;

    // Destructive tools: require human approval
    if (requireApprovalForDestructive && isDestructive(annotations)) {
      const priority = annotations.idempotentHint ? basePriority : basePriority + 10;
      rules.push({
        id: `${ruleIdPrefix}-destructive-${toolName}`,
        name: `MCP: Destructive tool requires approval — ${toolName}`,
        condition: {
          type: "all_of",
          params: {
            conditions: [
              { type: "action_type", params: { actions: ["tool_call"] } },
              { type: "tool_blocked", params: { tools: [toolName] } },
            ],
          },
        },
        outcome: "require_approval",
        reason: `Tool "${toolName}" has destructiveHint annotation — requires human approval`,
        priority,
        enabled: true,
        stage: "process",
      });
    }

    // Open-world tools: apply injection guard
    if (injectGuardForOpenWorld && annotations.openWorldHint === true) {
      rules.push({
        id: `${ruleIdPrefix}-openworld-${toolName}`,
        name: `MCP: Open-world tool injection scan — ${toolName}`,
        condition: {
          type: "injection_guard",
          params: { threshold: 0.4 }, // Lower threshold for open-world tools
        },
        outcome: "block",
        reason: `Tool "${toolName}" interacts with untrusted external systems — injection scanning enforced`,
        priority: basePriority + 20,
        enabled: true,
        stage: "preprocess",
      });
    }
  }

  return rules;
}

/**
 * Classify MCP tool risk level based on annotations.
 * Returns a risk level for each tool for scoring and reporting.
 */
export function classifyToolRisk(tool: MCPToolDefinition): ToolRiskClassification {
  const annotations = tool.annotations ?? {};

  if (isDestructive(annotations) && annotations.openWorldHint === true) {
    return { tool: tool.name, risk: "critical", reason: "Destructive + open-world interaction" };
  }
  if (isDestructive(annotations)) {
    return { tool: tool.name, risk: "high", reason: "Destructive operation" };
  }
  if (annotations.openWorldHint === true) {
    return { tool: tool.name, risk: "medium", reason: "Open-world interaction with untrusted systems" };
  }
  if (annotations.readOnlyHint === true) {
    return { tool: tool.name, risk: "low", reason: "Read-only operation" };
  }
  return { tool: tool.name, risk: "medium", reason: "No annotations — assuming moderate risk" };
}

/** Classify all tools in a list */
export function classifyToolsRisk(tools: MCPToolDefinition[]): ToolRiskClassification[] {
  return tools.map(classifyToolRisk);
}

// ─── Types ───────────────────────────────────────────────────

export interface ToolRiskClassification {
  tool: string;
  risk: "critical" | "high" | "medium" | "low";
  reason: string;
}

// ─── Helpers ────────────────────────────────────────────────

function isDestructive(annotations: MCPToolAnnotations): boolean {
  // Per MCP spec: destructiveHint defaults to true when readOnlyHint is false
  if (annotations.readOnlyHint === true) return false;
  if (annotations.destructiveHint === true) return true;
  // Default: destructive when not explicitly marked as non-destructive
  return annotations.destructiveHint !== false;
}
