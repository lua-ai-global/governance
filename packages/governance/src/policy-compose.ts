/**
 * Policy Composition — merge policy sets from multiple sources.
 *
 * Enterprise teams need to compose policies from different authorities:
 * - Security team defines tool restrictions
 * - Compliance team defines approval workflows
 * - Platform team defines rate limits and budgets
 * - Individual teams add custom rules
 *
 * This module handles merging, deduplication, conflict resolution,
 * and layered policy application.
 */

import type { PolicyRule, PolicyAction } from "./policy";

// Re-export presets from separate file for <300 LOC compliance
export { securityBaseline, complianceOverlay, platformDefaults } from "./policy-compose-presets";

// ─── Types ──────────────────────────────────────────────────────

export interface PolicySet {
  /** Unique name for this policy set */
  name: string;
  /** Source authority (e.g., "security-team", "compliance", "platform") */
  source: string;
  /** Priority boost — added to all rules in this set */
  priorityBoost?: number;
  /** Rules in this set */
  rules: PolicyRule[];
}

export type ConflictStrategy =
  | "strict"      // Block wins over allow
  | "permissive"  // Allow wins over block
  | "priority"    // Higher priority wins (default)
  | "latest";     // Last-added set wins

export interface ComposeConfig {
  /** How to resolve conflicts between policy sets */
  conflictStrategy?: ConflictStrategy;
  /** Whether to deduplicate rules with same condition */
  deduplicate?: boolean;
  /** Maximum total rules (prevents policy explosion) */
  maxRules?: number;
}

export interface ComposeResult {
  rules: PolicyRule[];
  sources: string[];
  conflicts: PolicyConflict[];
  totalRulesInput: number;
  totalRulesOutput: number;
  deduplicatedCount: number;
}

export interface PolicyConflict {
  ruleIds: string[];
  sources: string[];
  resolution: string;
  winner: string;
}

// ─── Compose Engine ─────────────────────────────────────────────

/**
 * Compose multiple policy sets into a single merged rule array.
 *
 * Handles priority boosting, deduplication, conflict detection,
 * and rule count limits.
 *
 * @param sets - Array of PolicySets from different teams/authorities
 * @param config - Conflict resolution strategy, deduplication, max rules
 * @returns ComposeResult with merged rules, detected conflicts, and dedup stats
 *
 * @example
 * ```ts
 * const { rules, conflicts } = composePolicies([
 *   securityBaseline(), complianceOverlay(), platformDefaults(),
 * ], { conflictStrategy: 'strict' });
 * ```
 */
export function composePolicies(
  sets: PolicySet[],
  config: ComposeConfig = {},
): ComposeResult {
  const strategy = config.conflictStrategy ?? "priority";
  const deduplicate = config.deduplicate ?? true;
  const maxRules = config.maxRules ?? 100;

  const conflicts: PolicyConflict[] = [];
  const sources = sets.map((s) => s.source);
  let totalInput = 0;
  let deduplicatedCount = 0;

  // Phase 1: Collect all rules with priority boosts
  const allRules: { rule: PolicyRule; source: string; setIndex: number }[] = [];

  for (let i = 0; i < sets.length; i++) {
    const set = sets[i];
    const boost = set.priorityBoost ?? 0;

    for (const rule of set.rules) {
      totalInput++;
      allRules.push({
        rule: {
          ...rule,
          id: `${set.name}/${rule.id}`,
          priority: rule.priority + boost,
        },
        source: set.source,
        setIndex: i,
      });
    }
  }

  // Phase 2: Detect and resolve conflicts
  const rulesByConditionType = new Map<string, typeof allRules>();

  for (const entry of allRules) {
    const key = conditionKey(entry.rule);
    const existing = rulesByConditionType.get(key);
    if (existing) {
      existing.push(entry);
    } else {
      rulesByConditionType.set(key, [entry]);
    }
  }

  const resolvedRules: PolicyRule[] = [];

  for (const [key, entries] of rulesByConditionType) {
    if (entries.length === 1) {
      resolvedRules.push(entries[0].rule);
      continue;
    }

    // Conflict detected
    const hasConflict = !entries.every(
      (e) => e.rule.outcome === entries[0].rule.outcome,
    );

    if (hasConflict) {
      const winner = resolveConflict(entries, strategy);
      conflicts.push({
        ruleIds: entries.map((e) => e.rule.id),
        sources: entries.map((e) => e.source),
        resolution: strategy,
        winner: winner.rule.id,
      });
      resolvedRules.push(winner.rule);
      deduplicatedCount += entries.length - 1;
    } else if (deduplicate) {
      // Same outcome — keep highest priority
      const sorted = [...entries].sort(
        (a, b) => b.rule.priority - a.rule.priority,
      );
      resolvedRules.push(sorted[0].rule);
      deduplicatedCount += entries.length - 1;
    } else {
      for (const entry of entries) {
        resolvedRules.push(entry.rule);
      }
    }
  }

  // Phase 3: Enforce max rules limit
  const limited = resolvedRules
    .sort((a, b) => b.priority - a.priority)
    .slice(0, maxRules);

  return {
    rules: limited,
    sources,
    conflicts,
    totalRulesInput: totalInput,
    totalRulesOutput: limited.length,
    deduplicatedCount,
  };
}

// ─── Helpers ────────────────────────────────────────────────────

function conditionKey(rule: PolicyRule): string {
  const c = rule.condition;
  switch (c.type) {
    case "tool_blocked":
      return `tool_blocked:${[...c.tools].sort().join(",")}`;
    case "tool_allowed":
      return `tool_allowed:${[...c.tools].sort().join(",")}`;
    case "action_type":
      return `action_type:${[...c.actions].sort().join(",")}`;
    case "token_limit":
      return `token_limit`;
    case "rate_limit":
      return `rate_limit`;
    case "data_classification":
      return `data_classification:${[...c.blocked].sort().join(",")}`;
    case "agent_level":
      return `agent_level`;
    case "tool_sequence":
      return `tool_sequence:${c.tool}`;
    case "time_window":
      return `time_window:${c.allowedHours.start}-${c.allowedHours.end}`;
    default:
      return `${c.type}:${rule.id}`;
  }
}

function resolveConflict(
  entries: { rule: PolicyRule; source: string; setIndex: number }[],
  strategy: ConflictStrategy,
): { rule: PolicyRule; source: string; setIndex: number } {
  switch (strategy) {
    case "strict":
      // Block wins
      return (
        entries.find((e) => e.rule.outcome === "block") ??
        entries[0]
      );

    case "permissive":
      // Allow wins
      return (
        entries.find((e) => e.rule.outcome === "allow") ??
        entries[0]
      );

    case "latest":
      // Last set wins
      return entries.reduce((latest, e) =>
        e.setIndex > latest.setIndex ? e : latest,
      );

    case "priority":
    default:
      // Highest priority wins
      return entries.reduce((highest, e) =>
        e.rule.priority > highest.rule.priority ? e : highest,
      );
  }
}
