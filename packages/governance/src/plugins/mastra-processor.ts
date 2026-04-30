/**
 * governance-sdk — Native Mastra Processor
 *
 * Framework-level governance integration for Mastra agents. Implements three
 * Mastra processor lifecycle methods so a single instance covers the full
 * enforcement pipeline:
 *
 *   - processInput()        → governance.enforcePreprocess
 *                              (user message before LLM, injection scanning)
 *   - processOutputStep()   → governance.enforce
 *                              (tool calls after LLM, before execution)
 *   - processOutputResult() → governance.enforcePostprocess
 *                              (final agent output, masking + filtering)
 *
 * All three call the SDK's public enforce methods, which means the same
 * processor works in both local mode (in-process policy evaluation) and
 * remote mode (HTTP enforce against the governance cloud) — the integrator
 * controls this via createGovernance({ serverUrl, apiKey }).
 *
 * Types are in mastra-processor-types.ts.
 */

import type { GovernanceInstance, AuditEvent } from "../index";
import type { EnforcementContext, EnforcementDecision, PolicyAction } from "../policy";
import type { AgentRegistration } from "../types";
import type {
  MastraProcessorInterface,
  MastraToolCallInfo,
  MastraMessage,
  MastraStreamChunk,
  ProcessInputArgs,
  ProcessOutputStepArgs,
  ProcessOutputResultArgs,
  ProcessOutputStreamArgs,
  GovernanceLifecycleArgs,
  GovernanceStage,
  GovernanceProcessorConfig,
  GovernanceViolation,
  ProcessorStats,
} from "./mastra-processor-types.js";
import { governStreamChunk } from "./mastra-processor-stream.js";
import {
  wrapToolWithGovernance,
  wrapToolsWithGovernance,
  extractFields,
  type MastraTool,
} from "./mastra-processor-tool-wrap.js";

// Re-export all types
export type {
  MastraStreamChunk,
  ProcessOutputStreamArgs,
  MastraToolCallInfo,
  MastraAbortOptions,
  GovernanceViolation,
  MastraAbortFn,
  MastraMessage,
  MastraStreamWriter,
  MastraOutputResult,
  ProcessInputArgs,
  ProcessOutputStepArgs,
  ProcessOutputResultArgs,
  GovernanceLifecycleArgs,
  GovernanceStage,
  MastraProcessorInterface,
  GovernanceProcessorConfig,
  ProcessorStats,
} from "./mastra-processor-types.js";

// ─── GovernanceProcessor ──────────────────────────────────────

export class GovernanceProcessor implements MastraProcessorInterface {
  readonly id = "governance-sdk" as const;
  readonly name = "Lua Governance Processor";

  private governance: GovernanceInstance;
  private config: GovernanceProcessorConfig;
  private agentId: string | null = null;
  private agentLevel: number = 0;
  private registrationPromise: Promise<void> | null = null;
  private stats: ProcessorStats = {
    totalProcessed: 0, totalBlocked: 0, totalAllowed: 0,
    byTool: {}, initializedAt: new Date().toISOString(),
  };

  constructor(governance: GovernanceInstance, config: GovernanceProcessorConfig) {
    this.governance = governance;
    this.config = config;
  }

  private async ensureRegistered(): Promise<void> {
    if (this.agentId) return;
    if (!this.registrationPromise) this.registrationPromise = this.doRegister();
    await this.registrationPromise;
  }

  private async doRegister(): Promise<void> {
    const registration: AgentRegistration = {
      // Pass through the caller-supplied id when present so the runtime
      // record binds to a pre-existing dashboard record (e.g. Lua's
      // canonical agentId). Without this, the SDK would generate a new
      // UUID on first register and create a duplicate row.
      id: this.config.agentId,
      name: this.config.agentName,
      framework: this.config.framework ?? "mastra",
      owner: this.config.owner,
      description: this.config.description,
      version: this.config.version,
      channels: this.config.channels,
      hasAuth: this.config.hasAuth,
      hasGuardrails: this.config.hasGuardrails,
      hasObservability: this.config.hasObservability,
      hasAuditLog: this.config.hasAuditLog ?? true,
      permissions: this.config.permissions,
      metadata: this.config.metadata,
    };
    const result = await this.governance.register(registration);
    this.agentId = result.id;
    this.agentLevel = result.level;
  }

  async processOutputStep(args: ProcessOutputStepArgs): Promise<void> {
    const { toolCalls, abort, retryCount } = args;
    if (!toolCalls || toolCalls.length === 0) return;

    await this.ensureRegistered();

    const abortOnBlock = this.config.abortOnBlock ?? true;
    const retryOnBlock = this.config.retryOnBlock ?? false;
    const maxRetries = this.config.maxRetries ?? 2;
    const violations: GovernanceViolation[] = [];

    for (const toolCall of toolCalls) {
      const decision = await this.evaluateToolCall(toolCall, args);

      this.stats.totalProcessed++;
      if (!this.stats.byTool[toolCall.toolName]) {
        this.stats.byTool[toolCall.toolName] = { allowed: 0, blocked: 0 };
      }

      if (decision.blocked) {
        this.stats.totalBlocked++;
        this.stats.byTool[toolCall.toolName].blocked++;
        this.config.onBlocked?.(decision, toolCall);

        // Notify approval-required separately so integrators can branch on it
        if (decision.outcome === "require_approval") {
          this.config.onApprovalRequired?.(decision, "tool_call");
        }

        violations.push({
          toolName: toolCall.toolName,
          ruleId: decision.ruleId ?? "unknown",
          reason: decision.reason ?? "Policy violation",
          decision,
        });

        if (abortOnBlock) {
          const message = this.config.abortMessage
            ? this.config.abortMessage(decision, toolCall)
            : `[GOVERNANCE] Blocked: ${toolCall.toolName} — ${decision.reason} (rule: ${decision.ruleId})`;

          if (retryOnBlock && retryCount < maxRetries) {
            abort(`${message}. Please choose a different approach that doesn't use blocked tools.`, { retry: true, metadata: { violations } });
          } else {
            abort(message, { retry: false, metadata: { violations } });
          }
          return;
        }
      } else {
        this.stats.totalAllowed++;
        this.stats.byTool[toolCall.toolName].allowed++;
      }

      this.config.onDecision?.(decision, toolCall);
    }
  }

  /**
   * Mastra calls this BEFORE the LLM runs for the first time.
   *
   * Runs governance preprocess on the latest user message — this is where
   * injection scanning, input blocklists, input length limits, and any
   * other PRE-stage rules fire. Calls the SDK's public `enforcePreprocess`,
   * which routes to either the local policy engine or the remote cloud API
   * depending on how `createGovernance()` was configured.
   */
  async processInput(args: ProcessInputArgs): Promise<MastraMessage[]> {
    if (this.config.skipPreprocess) return args.messages;

    await this.ensureRegistered();
    if (!this.agentId) return args.messages;

    const userMessageText = this.extractUserText(args.messages);
    if (!userMessageText) return args.messages;

    const metadata = await this.buildMetadata("preprocess", args);

    const decision = await this.governance.enforcePreprocess({
      agentId: this.agentId,
      agentName: this.config.agentName,
      agentLevel: this.agentLevel,
      action: "message_send",
      input: { message: userMessageText },
      metadata,
    });

    this.config.onDecision?.(decision, {
      toolName: "__preprocess__",
      args: { message: userMessageText },
      toolCallId: "preprocess",
    });

    if (!decision.blocked && decision.outcome !== "warn" && decision.outcome !== "require_approval") {
      return args.messages;
    }

    // warn → fire callback, continue
    if (decision.outcome === "warn") {
      this.config.onPreprocessBlocked?.(decision, userMessageText);
      return args.messages;
    }

    // require_approval → fire approval callback, then halt
    if (decision.outcome === "require_approval") {
      this.config.onApprovalRequired?.(decision, "preprocess");
    }

    // block / require_approval → fire callback, halt with violation metadata
    this.config.onPreprocessBlocked?.(decision, userMessageText);

    const violation: GovernanceViolation = {
      toolName: "__preprocess__",
      ruleId: decision.ruleId ?? "unknown",
      reason: decision.reason ?? "Preprocess governance policy violation",
      decision,
    };
    const reason = `[GOVERNANCE] Preprocess blocked — ${decision.reason ?? "policy violation"} (rule: ${decision.ruleId ?? "unknown"})`;
    args.abort(reason, { retry: false, metadata: { violations: [violation] } });
    // args.abort returns `never`, but the type system doesn't know that
    // through the optional chain. Throw to satisfy TS.
    throw new Error(reason);
  }

  /**
   * Mastra calls this ONCE after the agent has finished generating, with the
   * resolved final result.
   *
   * Runs governance postprocess on the agent's final response text — this is
   * where output filtering, PII redaction, sensitive-data masking, and any
   * other POST-stage rules fire. Calls the SDK's public `enforcePostprocess`,
   * which routes to either local or remote enforcement.
   *
   * On `mask` outcome, the latest assistant message text is mutated in place
   * with the SDK-computed maskedText.
   */
  async processOutputResult(args: ProcessOutputResultArgs): Promise<MastraMessage[]> {
    if (this.config.skipPostprocess) return args.messages;

    // Skip if registration hasn't happened (the agent may not have made any
    // tool calls or input was empty, so neither processInput nor
    // processOutputStep ran). Fail-open in that case.
    if (!this.agentId) return args.messages;

    const responseText = args.result?.text ?? "";
    if (!responseText) return args.messages;

    const metadata = await this.buildMetadata("postprocess", args);

    const decision = await this.governance.enforcePostprocess({
      agentId: this.agentId,
      agentName: this.config.agentName,
      agentLevel: this.agentLevel,
      action: "message_send",
      input: { message: responseText },
      outputText: responseText,
      outputTokenCount: args.result?.usage?.outputTokens,
      metadata,
    });

    this.config.onDecision?.(decision, {
      toolName: "__postprocess__",
      args: { message: responseText },
      toolCallId: "postprocess",
    });

    // Allow / unknown → pass through
    if (!decision.blocked && decision.outcome !== "warn" && decision.outcome !== "mask" && decision.outcome !== "require_approval") {
      return args.messages;
    }

    // warn → fire callback, continue
    if (decision.outcome === "warn") {
      this.config.onPostprocessBlocked?.(decision, responseText);
      return args.messages;
    }

    // mask → mutate the latest assistant message text and return.
    // The SDK computes maskedText for us; we just substitute it.
    if (decision.outcome === "mask") {
      const maskedText = decision.maskedText ?? responseText;
      this.config.onMask?.(decision, responseText, maskedText);
      this.mutateLastAssistantMessage(args.messages, maskedText);
      return args.messages;
    }

    // require_approval → fire approval callback, then halt
    if (decision.outcome === "require_approval") {
      this.config.onApprovalRequired?.(decision, "postprocess");
    }

    // block / require_approval → fire callback, halt with violation metadata
    this.config.onPostprocessBlocked?.(decision, responseText);

    const violation: GovernanceViolation = {
      toolName: "__postprocess__",
      ruleId: decision.ruleId ?? "unknown",
      reason: decision.reason ?? "Postprocess governance policy violation",
      decision,
    };
    const reason = `[GOVERNANCE] Postprocess blocked — ${decision.reason ?? "policy violation"} (rule: ${decision.ruleId ?? "unknown"})`;
    args.abort(reason, { retry: false, metadata: { violations: [violation] } });
    throw new Error(reason);
  }

  /**
   * Build the EnforcementContext for a tool call. Includes the per-call
   * metadata produced by `config.metadataProvider` (if set), merged with
   * the static `config.metadata`. Per-call values win on conflict.
   */
  private async evaluateToolCall(
    toolCall: MastraToolCallInfo,
    args: ProcessOutputStepArgs,
  ): Promise<EnforcementDecision> {
    const action = this.config.actionMapper
      ? this.config.actionMapper(toolCall.toolName)
      : "tool_call" as PolicyAction;

    const metadata = await this.buildMetadata("tool_call", args);

    // Pull `targetPath` / `targetUrl` off the tool's args so policy
    // conditions like `scope_boundary` and `network_allowlist` actually
    // fire at the `process` stage. Without this, those rules silently
    // never match — they read ctx.targetPath/ctx.targetUrl, not raw
    // input args. Same registry that wrapTool uses for `tool_result` —
    // generic name conventions (path / filePath / url / href / ...) cover
    // most tools without explicit configuration.
    const toolArgs = toolCall.args as Record<string, unknown> | undefined;
    const fields = extractFields(toolArgs, this.config.toolFieldExtraction, toolCall.toolName);

    const ctx: EnforcementContext = {
      agentId: this.agentId!,
      agentName: this.config.agentName,
      agentLevel: this.agentLevel,
      action,
      tool: toolCall.toolName,
      input: toolArgs,
      targetPath: fields.targetPath,
      targetUrl: fields.targetUrl,
      sessionTokensUsed: this.config.sessionTokenTracker?.(),
      ...(metadata && Object.keys(metadata).length > 0 ? { metadata } : {}),
    };
    return this.governance.enforce(ctx);
  }

  /**
   * Merge static config.metadata with the per-call metadataProvider output.
   * Per-call values take precedence on key conflicts.
   */
  private async buildMetadata(
    stage: GovernanceStage,
    args: GovernanceLifecycleArgs,
  ): Promise<Record<string, unknown> | undefined> {
    const staticMeta = this.config.metadata;
    const perCallMeta = this.config.metadataProvider
      ? await this.config.metadataProvider(stage, args)
      : undefined;

    if (!staticMeta && !perCallMeta) return undefined;
    return { ...(staticMeta ?? {}), ...(perCallMeta ?? {}) };
  }

  /**
   * Pull the latest user-role message text from a Mastra message list.
   * Handles both string content and structured (array of parts) content
   * shapes. Returns an empty string if no user message is found.
   */
  private extractUserText(messages: MastraMessage[]): string {
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg.role !== "user") continue;
      return this.messageContentToText(msg.content);
    }
    return "";
  }

  /**
   * Convert a Mastra message content payload to plain text.
   *
   * Mastra has several content shapes depending on which API path the
   * message came from:
   *
   *   1. Plain string (legacy / simple agents):
   *      content: "hello"
   *
   *   2. Top-level array of parts (Vercel AI SDK / UserModelMessage shape):
   *      content: [{ type: 'text', text: 'hello' }, { type: 'image', ... }]
   *
   *   3. Mastra DB format 2 — an object with `parts` AND a flat `content` string:
   *      content: { format: 2, parts: [{ type: 'text', text: 'hello' }], content: 'hello' }
   *      This is what `agent.stream()` and `agent.generate()` see when reading
   *      messages back from the memory store.
   *
   * We handle all three. For the object form we prefer `parts[]` so that
   * structured multi-modal content is preserved correctly, falling back to
   * the flat `content` string if `parts` is missing.
   */
  private messageContentToText(content: unknown): string {
    if (typeof content === "string") return content;

    // Top-level array of parts (shape #2)
    if (Array.isArray(content)) {
      return this.partsToText(content);
    }

    // Mastra DB format 2 object (shape #3)
    if (content && typeof content === "object") {
      const obj = content as Record<string, unknown>;
      if (Array.isArray(obj.parts)) {
        const fromParts = this.partsToText(obj.parts);
        if (fromParts) return fromParts;
      }
      if (typeof obj.content === "string") {
        return obj.content;
      }
      // Some shapes nest text under `text`
      if (typeof obj.text === "string") {
        return obj.text;
      }
    }

    return "";
  }

  /** Extract text from an array of message parts (shape #2 or shape #3.parts). */
  private partsToText(parts: unknown[]): string {
    return parts
      .map((part) => {
        if (typeof part === "string") return part;
        if (part && typeof part === "object" && "type" in part) {
          const p = part as { type: string; text?: string };
          if (p.type === "text") return p.text ?? "";
        }
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }

  /**
   * Mutate the latest assistant-role message in place to use new text.
   * Used by the postprocess `mask` outcome to substitute redacted output
   * without requiring the integrator to handle masking themselves.
   *
   * Handles all three message content shapes (see messageContentToText).
   */
  private mutateLastAssistantMessage(messages: MastraMessage[], newText: string): void {
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg.role !== "assistant") continue;

      // Shape #1: Plain string content
      if (typeof msg.content === "string") {
        msg.content = newText;
        return;
      }

      // Shape #2: Top-level array of parts
      if (Array.isArray(msg.content)) {
        this.replaceTextInParts(msg.content as unknown[], newText);
        return;
      }

      // Shape #3: Mastra DB format 2 object — replace BOTH parts text and the
      // flat `content` string field so downstream consumers see the masked text
      // regardless of which they read.
      if (msg.content && typeof msg.content === "object") {
        const obj = msg.content as Record<string, unknown>;
        if (Array.isArray(obj.parts)) {
          this.replaceTextInParts(obj.parts as unknown[], newText);
        }
        if (typeof obj.content === "string") {
          obj.content = newText;
        }
        if (typeof obj.text === "string") {
          obj.text = newText;
        }
      }
      return;
    }
  }

  /**
   * Replace the first text part in an array with new text. If no text part
   * exists, append one. Mutates the array in place.
   */
  private replaceTextInParts(parts: unknown[], newText: string): void {
    for (const part of parts) {
      if (part && typeof part === "object" && "type" in part && (part as { type: string }).type === "text") {
        (part as unknown as { text: string }).text = newText;
        return;
      }
    }
    parts.push({ type: "text", text: newText });
  }

  /**
   * Mastra calls this for each chunk emitted by `agent.stream()`. We route
   * through governStreamChunk (mastra-processor-stream.ts) which handles
   * the three streaming modes (per-chunk, sliding, buffered).
   *
   * Preprocess already ran at processInput time, so we only post-scan here.
   * On block, governStreamChunk calls args.abort() to tripwire the stream.
   */
  async processOutputStream(
    args: ProcessOutputStreamArgs,
  ): Promise<MastraStreamChunk | null | undefined> {
    await this.ensureRegistered();
    if (!this.agentId) return args.part;

    // Mastra's callback shapes are framework-specific (e.g. onBlocked takes
    // a MastraToolCallInfo) and don't line up with the generic OutcomeCallbacks
    // contract used by the shared pre/post helpers. Build an adapter view so
    // governStreamChunk can drive generic callbacks while preserving any
    // Mastra-specific side effects the integrator wired up.
    const genericCallbacks: import("./outcome-handler.js").OutcomeCallbacks = {
      onMask: (decision, _toolName, masked) => {
        this.config.onMask?.(decision, "", masked);
      },
    };

    return governStreamChunk(
      args,
      this.governance,
      this.config,
      this.agentId,
      this.agentLevel,
      genericCallbacks,
    );
  }

  getAgentId(): string | null { return this.agentId; }
  getAgentLevel(): number { return this.agentLevel; }
  getStats(): ProcessorStats { return { ...this.stats }; }
  getGovernance(): GovernanceInstance { return this.governance; }

  async logToolResult(toolName: string, outcome: "success" | "failure", detail?: Record<string, unknown>): Promise<AuditEvent> {
    await this.ensureRegistered();
    return this.governance.audit.log({
      agentId: this.agentId!, eventType: "tool_call", outcome,
      severity: outcome === "failure" ? "warning" : "info",
      detail: { tool: toolName, ...detail },
    });
  }

  /**
   * Wrap a Mastra tool with governance scanning on its result.
   *
   * Mastra's Processor lifecycle has no hook between a tool's `execute()`
   * returning and the LLM ingesting the result. Tool-result scanning has
   * to happen INSIDE the tool's execute. Call this when assembling the
   * agent's tool dict; the returned tool is a shallow copy with `execute`
   * replaced by a closure that calls the original then runs the result
   * through `scanToolResult()` (signal generation + policy engine at
   * stage `tool_result`).
   *
   * On block: the wrapped execute returns `{ blocked, reason, ruleId }`
   * instead of the original content. The LLM never sees the blocked value.
   *
   * @example
   * ```ts
   * const tools = {
   *   read_file: processor.wrapTool(readFileTool),
   *   write_file: processor.wrapTool(writeFileTool),
   * };
   * const agent = new Agent({ tools, ... });
   * ```
   */
  wrapTool<T extends MastraTool>(tool: T): T {
    if (this.config.scanToolResults === false) return tool;
    return wrapToolWithGovernance(tool, {
      governance: this.governance,
      agentId: this.agentId ?? this.config.agentId ?? "",
      agentName: this.config.agentName,
      agentLevel: this.agentLevel,
      toolFieldExtraction: this.config.toolFieldExtraction,
      injectionThreshold: this.config.toolResultInjectionThreshold,
      toolResultScans: this.config.toolResultScans,
      metadata: this.config.metadata,
    });
  }

  /**
   * Bulk-wrap a tools dict. Convenience over calling `wrapTool` for each.
   *
   * @example
   * ```ts
   * const agent = new Agent({
   *   tools: processor.wrapTools({ read_file, write_file, take_screenshot }),
   *   ...
   * });
   * ```
   */
  wrapTools<T extends Record<string, MastraTool>>(tools: T): T {
    if (this.config.scanToolResults === false) return tools;
    return wrapToolsWithGovernance(tools, {
      governance: this.governance,
      agentId: this.agentId ?? this.config.agentId ?? "",
      agentName: this.config.agentName,
      agentLevel: this.agentLevel,
      toolFieldExtraction: this.config.toolFieldExtraction,
      injectionThreshold: this.config.toolResultInjectionThreshold,
      toolResultScans: this.config.toolResultScans,
      metadata: this.config.metadata,
    });
  }

  resetStats(): void {
    this.stats = { totalProcessed: 0, totalBlocked: 0, totalAllowed: 0, byTool: {}, initializedAt: new Date().toISOString() };
  }
}
