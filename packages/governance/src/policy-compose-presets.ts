/**
 * Preset policy sets for common governance patterns.
 * Used with composePolicies() from policy-compose.ts.
 */

import type { PolicySet } from "./policy-compose";
import {
  blockTools,
  requireApproval,
  tokenBudget,
  rateLimit,
  requireLevel,
} from "./policy";

/**
 * Security baseline — blocks dangerous tools and requires minimum governance.
 */
export function securityBaseline(): PolicySet {
  return {
    name: "security-baseline",
    source: "security-team",
    priorityBoost: 50,
    rules: [
      blockTools([
        "shell_exec", "rm_rf", "database_drop",
        "file_delete", "process_kill", "eval",
        "system_command", "sudo",
      ], "Security baseline: dangerous tool blocked"),
      requireLevel(2),
    ],
  };
}

/**
 * Compliance overlay — EU AI Act minimum requirements.
 */
export function complianceOverlay(): PolicySet {
  return {
    name: "compliance-overlay",
    source: "compliance-team",
    priorityBoost: 30,
    rules: [
      requireApproval(
        ["payment", "database_mutation", "external_request"],
        "Compliance: high-risk actions require approval",
      ),
      tokenBudget(500_000),
    ],
  };
}

/**
 * Platform defaults — rate limiting and operational boundaries.
 */
export function platformDefaults(): PolicySet {
  return {
    name: "platform-defaults",
    source: "platform-team",
    priorityBoost: 0,
    rules: [
      rateLimit(100, 60_000),
      tokenBudget(1_000_000),
    ],
  };
}
