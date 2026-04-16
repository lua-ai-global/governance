/**
 * governance-sdk — OpenTelemetry Hook Points
 *
 * Produces structured span-compatible data from governance events.
 * Zero dependencies — outputs plain objects that users wire to their OTel tracer.
 *
 * Since 0.13, `createOtelHooks({ conventions })` defaults to "gen_ai" so
 * governance spans correlate out of the box with Anthropic / OpenAI /
 * Vercel-AI SDK spans in Honeycomb / Datadog / New Relic. Options:
 *   - "governance" — legacy `governance.*` namespace (pre-0.12 default)
 *   - "gen_ai"     — OpenTelemetry GenAI semantic conventions (0.13 default)
 *   - "both"       — emit both; pin this if you have dashboards that query
 *                    the legacy `governance.*` operation names
 *
 * GenAI spec: https://opentelemetry.io/docs/specs/semconv/gen-ai/
 *
 * @example
 * ```ts
 * import { createOtelHooks, type GovernanceSpan } from 'governance-sdk/otel-hooks';
 * import { trace } from '@opentelemetry/api';
 *
 * const tracer = trace.getTracer('governance');
 * const hooks = createOtelHooks({ conventions: "gen_ai" });
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

/** Which attribute/operation-name conventions to emit. */
export type OtelConventions = "governance" | "gen_ai" | "both";

/** Configuration for OTel hooks */
export interface OtelHooksConfig {
  /** Service name for span attributes (default: "governance-sdk") */
  serviceName?: string;
  /**
   * Which attribute namespace to emit. Default "gen_ai" from 0.13 onward.
   * Pass "both" to additionally emit the legacy `governance.*` namespace
   * or "governance" to fully disable gen_ai.* output.
   */
  conventions?: OtelConventions;
  /** Custom attribute mapper — runs after built-in mapping. */
  attributeMapper?: (event: GovernanceEventInput) => Record<string, string | number | boolean>;
}

/** Input event shape matching GovernanceEvent from events.ts */
export interface GovernanceEventInput {
  type: string;
  timestamp: string;
  agentId?: string;
  detail: Record<string, unknown>;
}

// ─── Convention mapping ─────────────────────────────────────

/**
 * Map a governance event type to a GenAI-convention operation name.
 * Returns null for events with no natural GenAI analogue (e.g. agent
 * lifecycle, kill-switch) — those keep the governance.* operation name.
 */
function genAiOperationName(eventType: string): string | null {
  switch (eventType) {
    case "enforcement":
    case "policy_evaluation":
    case "policy_evaluation_preprocess":
    case "policy_evaluation_process":
    case "policy_evaluation_postprocess":
      return "gen_ai.policy.evaluate";
    case "action_outcome":
      return "gen_ai.tool.execute";
    case "agent_registered":
      return "gen_ai.agent.register";
    case "audit":
      return "gen_ai.audit.log";
    default:
      return null;
  }
}

function addGenAiAttributes(
  attrs: Record<string, string | number | boolean>,
  event: GovernanceEventInput,
): void {
  const detail = event.detail;

  // Core system / model / operation (gen_ai.*)
  if (typeof detail.system === "string") attrs["gen_ai.system"] = detail.system;
  else if (typeof detail.framework === "string") attrs["gen_ai.system"] = detail.framework;
  if (typeof detail.model === "string") attrs["gen_ai.request.model"] = detail.model;
  if (typeof detail.responseModel === "string") attrs["gen_ai.response.model"] = detail.responseModel;

  // Token usage
  if (typeof detail.inputTokens === "number") attrs["gen_ai.usage.input_tokens"] = detail.inputTokens;
  if (typeof detail.outputTokens === "number") attrs["gen_ai.usage.output_tokens"] = detail.outputTokens;
  if (typeof detail.tokensUsed === "number" && typeof detail.outputTokens !== "number") {
    // tokensUsed is our generic field; map to output_tokens as the best approximation.
    attrs["gen_ai.usage.output_tokens"] = detail.tokensUsed;
  }

  // Finish reason
  if (typeof detail.finishReason === "string") attrs["gen_ai.response.finish_reasons"] = detail.finishReason;

  // Tool call — the GenAI spec names the individual tool + call id
  if (typeof detail.tool === "string") attrs["gen_ai.tool.name"] = detail.tool;
  if (typeof detail.toolCallId === "string") attrs["gen_ai.tool.call.id"] = detail.toolCallId;

  // Server address if we can infer it
  if (typeof detail.serverAddress === "string") attrs["server.address"] = detail.serverAddress;
  if (typeof detail.serverPort === "number") attrs["server.port"] = detail.serverPort;
}

function addGovernanceAttributes(
  attrs: Record<string, string | number | boolean>,
  event: GovernanceEventInput,
): void {
  attrs["governance.event.type"] = event.type;
  if (event.agentId) attrs["governance.agent.id"] = event.agentId;

  const detail = event.detail;
  if (typeof detail.outcome === "string") attrs["governance.outcome"] = detail.outcome;
  if (typeof detail.blocked === "boolean") attrs["governance.blocked"] = detail.blocked;
  if (typeof detail.ruleId === "string") attrs["governance.rule.id"] = detail.ruleId;
  if (typeof detail.tool === "string") attrs["governance.tool"] = detail.tool;
  if (typeof detail.action === "string") attrs["governance.action"] = detail.action;
  if (typeof detail.score === "number") attrs["governance.score"] = detail.score;
  if (typeof detail.level === "number") attrs["governance.level"] = detail.level;
  if (typeof detail.durationMs === "number") attrs["governance.duration_ms"] = detail.durationMs;
  if (typeof detail.rulesEvaluated === "number") attrs["governance.rules_evaluated"] = detail.rulesEvaluated;
}

// ─── Implementation ─────────────────────────────────────────

export function createOtelHooks(config: OtelHooksConfig = {}) {
  const serviceName = config.serviceName ?? "governance-sdk";
  // Default flipped from "both" → "gen_ai" in 0.13 per the 0.12 roadmap.
  // Back-compat: set `conventions: "both"` to keep emitting legacy
  // governance.* operation names alongside the new gen_ai.* ones.
  const conventions = config.conventions ?? "gen_ai";

  return {
    /**
     * Convert a governance event to an OTel-compatible span.
     * The returned object has no OTel dependency — wire it to your tracer.
     */
    toSpan(event: GovernanceEventInput): GovernanceSpan {
      const now = Date.now();
      const eventTime = new Date(event.timestamp).getTime();
      const startTimeMs = eventTime || now;

      const attrs: Record<string, string | number | boolean> = {
        "service.name": serviceName,
      };

      // Governance-specific attributes — always written under governance.*
      // when convention is "governance" or "both"; always written under
      // governance.* even in "gen_ai" mode for fields with no GenAI
      // equivalent (rule id, outcome, blocked, score, level).
      if (conventions === "governance" || conventions === "both") {
        addGovernanceAttributes(attrs, event);
      } else {
        // In pure "gen_ai" mode we still surface the governance decision
        // primitives — regulators and dashboards need them. Use the
        // governance.* namespace for policy-specific fields the GenAI
        // spec does not cover.
        addGovernanceAttributes(attrs, event);
      }

      // GenAI attributes — only when convention allows.
      if (conventions === "gen_ai" || conventions === "both") {
        addGenAiAttributes(attrs, event);
      }

      const customAttrs = config.attributeMapper?.(event) ?? {};
      const attributes = { ...attrs, ...customAttrs };

      const status = event.detail.blocked === true || event.detail.outcome === "block" ? "error" : "ok";

      // Operation name: only change away from the legacy governance.<type>
      // form when the caller has explicitly opted into "gen_ai". "both"
      // remains additive on attributes only so existing dashboards keep
      // matching. In 0.13 the default flips to "gen_ai".
      let operationName = `governance.${event.type}`;
      if (conventions === "gen_ai") {
        const genAiName = genAiOperationName(event.type);
        if (genAiName) operationName = genAiName;
      }

      return {
        traceId: generateId(32),
        spanId: generateId(16),
        operationName,
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
      // GenAI fields — optional, passed through to gen_ai.* attributes
      system?: string;
      model?: string;
      inputTokens?: number;
      outputTokens?: number;
      finishReason?: string;
      toolCallId?: string;
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
