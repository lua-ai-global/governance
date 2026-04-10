/**
 * Default stage assignments for condition types.
 * Used when a rule doesn't explicitly set its stage.
 */

import type { PolicyStage } from "./policy.js";

const STAGE_MAP: Record<string, PolicyStage> = {
  // Preprocess — run before agent processing
  injection_guard: "preprocess",
  data_classification: "preprocess",
  blocklist: "preprocess",
  input_length: "preprocess",
  input_pattern: "preprocess",

  // Process — run during execution (default)
  tool_blocked: "process",
  tool_allowed: "process",
  action_type: "process",
  agent_level: "process",
  require_signed_identity: "process",
  tool_sequence: "process",
  rate_limit: "process",
  token_limit: "process",
  time_window: "process",
  network_allowlist: "process",
  scope_boundary: "process",
  cost_budget: "process",
  concurrent_limit: "process",

  // Postprocess — run after execution
  output_length: "postprocess",
  output_pattern: "postprocess",
  sensitive_data_filter: "postprocess",
};

/** Get the default stage for a condition type. Returns "process" for unknown types. */
export function getDefaultStage(conditionType: string): PolicyStage {
  return STAGE_MAP[conditionType] ?? "process";
}
