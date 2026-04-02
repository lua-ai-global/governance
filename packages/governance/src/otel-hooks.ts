/**
 * governance-sdk — OpenTelemetry Hook Points
 *
 * Produces structured span-compatible data from governance events.
 * Zero dependencies — outputs plain objects that users wire to their OTel tracer.
 *
 * @example
 * ```ts
 * import { createOtelHooks, type GovernanceSpan } from 'governance-sdk/otel-hooks';
 * import { trace } from '@opentelemetry/api';
 *
 * const tracer = trace.getTracer('governance');
 * const hooks = createOtelHooks();
 *
 * governance.events.onAny((event) => {
 *   const span = hooks.toSpan(event);
 *   const otelSpan = tracer.startSpan(span.operationName, { startTime: span.startTimeMs });
 *   for (const [k, v] of Object.entries(span.attributes)) otelSpan.setAttribute(k, v);
 *   otelSpan.setStatus({ code: span.status === 'error' ? 2 : 0 });
 *   otelSpan.end(span.endTimeMs);
 * });
 * ```
 */

// ─── Types ───────────────────────────────────────────────────

/** OTel-compatible span data produced by governance hooks */
export interface GovernanceSpan {
  traceId: string;
  spanId: string;
  operationName: string;
  startTimeMs: number;
  endTimeMs: number;
  durationMs: number;
  attributes: Record<string, string | number | boolean>;
  status: "ok" | "error";
  kind: "internal";
}

/** Configuration for OTel hooks */
export interface OtelHooksConfig {
  /** Service name for span attributes (default: "governance-sdk") */
  serviceName?: string;
  /** Custom attribute mapper */
  attributeMapper?: (event: GovernanceEventInput) => Record<string, string | number | boolean>;
}

/** Input event shape matching GovernanceEvent from events.ts */
export interface GovernanceEventInput {
  type: string;
  timestamp: string;
  agentId?: string;
  detail: Record<string, unknown>;
}

// ─── Implementation ─────────────────────────────────────────

export function createOtelHooks(config: OtelHooksConfig = {}) {
  const serviceName = config.serviceName ?? "governance-sdk";

  return {
    /**
     * Convert a governance event to an OTel-compatible span.
     * The returned object has no OTel dependency — wire it to your tracer.
     */
    toSpan(event: GovernanceEventInput): GovernanceSpan {
      const now = Date.now();
      const eventTime = new Date(event.timestamp).getTime();
      const startTimeMs = eventTime || now;

      const baseAttributes: Record<string, string | number | boolean> = {
        "service.name": serviceName,
        "governance.event.type": event.type,
      };
      if (event.agentId) baseAttributes["governance.agent.id"] = event.agentId;

      const detail = event.detail;
      if (typeof detail.outcome === "string") baseAttributes["governance.outcome"] = detail.outcome;
      if (typeof detail.blocked === "boolean") baseAttributes["governance.blocked"] = detail.blocked;
      if (typeof detail.ruleId === "string") baseAttributes["governance.rule.id"] = detail.ruleId;
      if (typeof detail.tool === "string") baseAttributes["governance.tool"] = detail.tool;
      if (typeof detail.action === "string") baseAttributes["governance.action"] = detail.action;
      if (typeof detail.score === "number") baseAttributes["governance.score"] = detail.score;
      if (typeof detail.level === "number") baseAttributes["governance.level"] = detail.level;
      if (typeof detail.durationMs === "number") baseAttributes["governance.duration_ms"] = detail.durationMs;
      if (typeof detail.rulesEvaluated === "number") baseAttributes["governance.rules_evaluated"] = detail.rulesEvaluated;

      const customAttrs = config.attributeMapper?.(event) ?? {};
      const attributes = { ...baseAttributes, ...customAttrs };

      const status = detail.blocked === true || detail.outcome === "block" ? "error" : "ok";

      return {
        traceId: generateId(32),
        spanId: generateId(16),
        operationName: `governance.${event.type}`,
        startTimeMs,
        endTimeMs: now,
        durationMs: now - startTimeMs,
        attributes,
        status,
        kind: "internal",
      };
    },

    /** Create a span for an enforcement decision (convenience wrapper) */
    enforcementSpan(decision: {
      blocked: boolean;
      outcome: string;
      ruleId?: string;
      rulesEvaluated?: number;
      agentId?: string;
      tool?: string;
      durationMs?: number;
    }): GovernanceSpan {
      return this.toSpan({
        type: "enforcement",
        timestamp: new Date().toISOString(),
        agentId: decision.agentId,
        detail: decision as Record<string, unknown>,
      });
    },
  };
}

// ─── Utilities ──────────────────────────────────────────────

/** Generate a random hex ID (no deps, uses Math.random) */
function generateId(byteLength: number): string {
  const bytes = new Uint8Array(byteLength);
  if (typeof globalThis.crypto !== "undefined" && globalThis.crypto.getRandomValues) {
    globalThis.crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < byteLength; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
