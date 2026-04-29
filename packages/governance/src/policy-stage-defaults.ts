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

  // Tool result — run after a tool returns, before the LLM ingests the result
  // on the next turn. This is where injection scanning of external content
  // (file contents, clipboard, scraped pages, MCP returns) belongs — the
  // canonical untrusted-content surface. ml_injection_guard defaults here
  // because that's where the host populates ctx.mlInjectionScore via
  // detectInjection (local mode) or DeBERTa preflight (cloud mode).
  ml_injection_guard: "tool_result",

  // Postprocess — run after execution, on the agent's final output to the user.
  // sensitive_data_filter stays here for back-compat — users who want it on
  // tool returns set stage: "tool_result" explicitly on their rule. Different
  // threat models: postprocess protects the user from agent leaks; tool_result
  // protects the LLM context from external-content injection.
  output_length: "postprocess",
  output_pattern: "postprocess",
  sensitive_data_filter: "postprocess",
};

/** Get the default stage for a condition type. Returns "process" for unknown types. */
export function getDefaultStage(conditionType: string): PolicyStage {
  return STAGE_MAP[conditionType] ?? "process";
}
