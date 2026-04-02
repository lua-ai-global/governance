/**
 * @lua-ai-global/governance — In-Memory Trace Collector
 *
 * Captures agent operation traces for eval scoring.
 * Default implementation stores traces in memory with configurable limits.
 * Commercial deployments replace this with a persistent backend.
 *
 * @example
 * ```ts
 * import { createTraceCollector } from '@lua-ai-global/governance/eval-trace';
 *
 * const traces = createTraceCollector({ maxTraces: 200 });
 * const ctx = traces.startTrace('luna', 'What deals closed this week?');
 * const spanId = ctx.addSpan({
 *   operation: 'tool_call', toolName: 'honeycomb_search',
 *   input: { query: 'deals closed this week' },
 *   output: { results: [...] }, latencyMs: 142, success: true,
 * });
 * const trace = ctx.end('3 deals closed this week totaling $45k');
 * ```
 */

import type {
  EvalTrace,
  EvalSpan,
  TraceCollector,
  TraceContext,
} from "./eval-types.js";

// ─── Config ────────────────────────────────────────────────────

export interface TraceCollectorConfig {
  /** Maximum traces to keep in memory (default: 100). Oldest evicted first. */
  maxTraces?: number;
}

// ─── Implementation ────────────────────────────────────────────

export function createTraceCollector(config: TraceCollectorConfig = {}): TraceCollector {
  const maxTraces = config.maxTraces ?? 100;

  /** All completed traces, keyed by agentId → traces[] */
  const store = new Map<string, EvalTrace[]>();
  /** In-flight traces, keyed by traceId */
  const pending = new Map<string, { trace: EvalTrace; agentId: string }>();

  function generateId(): string {
    const bytes = new Uint8Array(16);
    if (typeof globalThis.crypto !== "undefined" && globalThis.crypto.getRandomValues) {
      globalThis.crypto.getRandomValues(bytes);
    } else {
      for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
    }
    return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  }

  function evict(agentId: string): void {
    const traces = store.get(agentId);
    if (!traces) return;
    while (traces.length > maxTraces) {
      traces.shift(); // remove oldest
    }
  }

  return {
    startTrace(agentId: string, input?: string, metadata?: Record<string, unknown>): TraceContext {
      const traceId = generateId();
      const trace: EvalTrace = {
        traceId,
        agentId,
        spans: [],
        startedAt: new Date().toISOString(),
        input,
        metadata,
      };

      pending.set(traceId, { trace, agentId });
      let ended = false;

      return {
        traceId,

        addSpan(spanData: Omit<EvalSpan, "spanId" | "timestamp">): string {
          if (ended) return ""; // silently ignore spans after end
          const entry = pending.get(traceId);
          if (!entry) return "";

          const spanId = generateId().slice(0, 16);
          const span: EvalSpan = {
            ...spanData,
            spanId,
            timestamp: new Date().toISOString(),
          };
          entry.trace.spans.push(span);
          return spanId;
        },

        end(output?: string): EvalTrace {
          if (ended) return trace; // idempotent — return cached trace
          ended = true;

          const entry = pending.get(traceId);
          if (!entry) return trace;

          entry.trace.completedAt = new Date().toISOString();
          if (output !== undefined) entry.trace.output = output;

          // Move from pending to store
          pending.delete(traceId);
          if (!store.has(entry.agentId)) store.set(entry.agentId, []);
          store.get(entry.agentId)!.push(entry.trace);
          evict(entry.agentId);

          return entry.trace;
        },
      };
    },

    getTraces(agentId: string): EvalTrace[] {
      return store.get(agentId) ?? [];
    },

    getRecentTraces(agentId: string, since: string): EvalTrace[] {
      const traces = store.get(agentId) ?? [];
      const sinceMs = new Date(since).getTime();
      return traces.filter((t) => new Date(t.startedAt).getTime() >= sinceMs);
    },

    traceCount(): number {
      let total = 0;
      for (const traces of store.values()) total += traces.length;
      return total;
    },

    clear(): void {
      store.clear();
      pending.clear();
    },
  };
}
