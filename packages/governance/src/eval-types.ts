/**
 * governance-sdk — Eval Type System
 *
 * Zero-dependency type definitions for the governance eval loop.
 * Traces capture what agents do. Metrics measure quality.
 * Results feed back into the governance score.
 *
 * @example
 * ```ts
 * import type { EvalTrace, EvalResult, TraceCollector } from 'governance-sdk/eval-types';
 * ```
 */

// ─── Spans & Traces ────────────────────────────────────────────

/** The type of operation captured in a span. */
export type SpanOperation =
  | "llm_call"
  | "tool_call"
  | "retrieval"
  | "generation"
  | "embedding"
  | "guard"        // governance enforcement check
  | "custom";

/** A single operation within a trace. */
export interface EvalSpan {
  spanId: string;
  parentSpanId?: string;
  operation: SpanOperation;
  /** What went in (prompt, tool args, query, etc.) */
  input: unknown;
  /** What came out (completion, tool result, documents, etc.) */
  output: unknown;
  /** Model used (if LLM call) */
  model?: string;
  /** Wall-clock duration */
  latencyMs: number;
  /** Token usage (if LLM call) */
  tokenUsage?: { input: number; output: number };
  /** Tool name (if tool call) */
  toolName?: string;
  /** Whether the operation succeeded */
  success: boolean;
  /** Error message (if failed) */
  error?: string;
  /** Arbitrary metadata */
  metadata?: Record<string, unknown>;
  timestamp: string;
}

/** A complete trace of an agent's work unit (one request/task). */
export interface EvalTrace {
  traceId: string;
  agentId: string;
  agentName?: string;
  spans: EvalSpan[];
  startedAt: string;
  completedAt?: string;
  /** The user/system input that triggered this trace */
  input?: string;
  /** The agent's final output */
  output?: string;
  /** Arbitrary context (task description, session ID, etc.) */
  metadata?: Record<string, unknown>;
}

// ─── Metrics & Results ─────────────────────────────────────────

/** Standard governance eval metric names. */
export type GovernanceMetricName =
  | "tool_correctness"      // Did it pick the right tool?
  | "output_faithfulness"   // Is the output grounded in source data?
  | "task_completion"       // Did it finish what was asked?
  | "safety_compliance"     // No injection, toxicity, PII leakage?
  | "instruction_following" // Did it follow the system prompt?
  | "red_team_resistance";  // Did it resist adversarial probing?

/** A single eval metric score. */
export interface EvalMetric {
  /** Metric name — use GovernanceMetricName for standard metrics */
  name: string;
  /** Score between 0 (worst) and 1 (best) */
  score: number;
  /** LLM-as-judge reasoning (why this score?) */
  reasoning?: string;
  /** Additional metric-specific data */
  metadata?: Record<string, unknown>;
}

/** The result of evaluating one trace. */
export interface EvalResult {
  traceId: string;
  agentId: string;
  metrics: EvalMetric[];
  evaluatedAt: string;
}

// ─── Trace Collector ───────────────────────────────────────────

/** Handle returned when starting a trace — used to add spans and finish. */
export interface TraceContext {
  traceId: string;
  /** Add a span to this trace. */
  addSpan(span: Omit<EvalSpan, "spanId" | "timestamp">): string;
  /** Mark the trace complete. Returns the full trace. */
  end(output?: string): EvalTrace;
}

/** Collects traces from agent operations. */
export interface TraceCollector {
  /** Start a new trace for an agent action. */
  startTrace(agentId: string, input?: string, metadata?: Record<string, unknown>): TraceContext;
  /** Retrieve completed traces for an agent. */
  getTraces(agentId: string): EvalTrace[];
  /** Retrieve traces completed since a given time. */
  getRecentTraces(agentId: string, since: string): EvalTrace[];
  /** Total trace count (all agents). */
  traceCount(): number;
  /** Clear all stored traces. */
  clear(): void;
}

// ─── Eval Runner ───────────────────────────────────────────────

/** Function that evaluates a trace and produces metrics. */
export type EvalMetricFn = (trace: EvalTrace) => Promise<EvalMetric[]>;

/** Configuration for an eval runner. */
export interface EvalRunnerConfig {
  /** Metrics to evaluate (functions that score traces) */
  metrics: EvalMetricFn[];
  /** Sample rate: evaluate 1 in N traces (default: 1 = all) */
  sampleRate?: number;
}
