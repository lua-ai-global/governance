/**
 * Governance Metrics — real-time statistics for governance operations.
 *
 * Tracks enforcement decisions, policy evaluations, audit events,
 * and agent registrations. Zero-dependency, in-memory counters.
 * Export to any monitoring system (Prometheus, Datadog, etc.)
 */

// ─── Types ──────────────────────────────────────────────────────

export interface GovernanceMetrics {
  /** Increment a counter */
  increment: (name: MetricName, labels?: MetricLabels) => void;
  /** Record a timing (duration in ms) */
  timing: (name: TimingName, durationMs: number, labels?: MetricLabels) => void;
  /** Get current snapshot of all metrics */
  snapshot: () => MetricsSnapshot;
  /** Reset all metrics */
  reset: () => void;
}

export type MetricName =
  | "enforcement.total"
  | "enforcement.blocked"
  | "enforcement.allowed"
  | "enforcement.require_approval"
  | "registration.total"
  | "audit.total"
  | "audit.failures"
  | "kill_switch.activations"
  | "kill_switch.revocations"
  | "injection.detected"
  | "injection.clean"
  | "policy.rules_evaluated";

export type TimingName =
  | "enforcement.duration_ms"
  | "registration.duration_ms";

export type MetricLabels = Record<string, string>;

export interface MetricCounter {
  name: MetricName;
  value: number;
  labels: MetricLabels;
}

export interface MetricTiming {
  name: TimingName;
  count: number;
  totalMs: number;
  avgMs: number;
  minMs: number;
  maxMs: number;
}

export interface MetricsSnapshot {
  counters: MetricCounter[];
  timings: MetricTiming[];
  collectedAt: string;
  uptimeMs: number;
}

// ─── Implementation ─────────────────────────────────────────────

/**
 * Create a governance metrics collector.
 *
 * @example
 * ```ts
 * const metrics = createGovernanceMetrics();
 *
 * // After enforcement
 * metrics.increment('enforcement.total');
 * metrics.increment('enforcement.blocked', { agent: 'sales-bot' });
 * metrics.timing('enforcement.duration_ms', 12.5);
 *
 * // Export snapshot
 * const snap = metrics.snapshot();
 * console.log(snap.counters); // [{ name: 'enforcement.total', value: 1, labels: {} }, ...]
 * ```
 */
export function createGovernanceMetrics(): GovernanceMetrics {
  const startTime = Date.now();
  const counters = new Map<string, MetricCounter>();
  const timings = new Map<TimingName, MetricTiming>();

  function counterKey(name: MetricName, labels: MetricLabels = {}): string {
    const labelStr = Object.entries(labels)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}=${v}`)
      .join(",");
    return labelStr ? `${name}{${labelStr}}` : name;
  }

  function increment(name: MetricName, labels: MetricLabels = {}): void {
    const key = counterKey(name, labels);
    const existing = counters.get(key);
    if (existing) {
      existing.value++;
    } else {
      counters.set(key, { name, value: 1, labels });
    }
  }

  function timing(name: TimingName, durationMs: number, _labels: MetricLabels = {}): void {
    const existing = timings.get(name);
    if (existing) {
      existing.count++;
      existing.totalMs += durationMs;
      existing.avgMs = existing.totalMs / existing.count;
      existing.minMs = Math.min(existing.minMs, durationMs);
      existing.maxMs = Math.max(existing.maxMs, durationMs);
    } else {
      timings.set(name, {
        name,
        count: 1,
        totalMs: durationMs,
        avgMs: durationMs,
        minMs: durationMs,
        maxMs: durationMs,
      });
    }
  }

  function snapshot(): MetricsSnapshot {
    return {
      counters: Array.from(counters.values()),
      timings: Array.from(timings.values()),
      collectedAt: new Date().toISOString(),
      uptimeMs: Date.now() - startTime,
    };
  }

  function reset(): void {
    counters.clear();
    timings.clear();
  }

  return { increment, timing, snapshot, reset };
}
