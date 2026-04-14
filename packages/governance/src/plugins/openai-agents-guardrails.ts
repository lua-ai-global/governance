/**
 * governance-sdk OpenAI Agents — input/output guardrails (pre/post)
 *
 * OpenAI's Agents SDK has first-class `inputGuardrails` and `outputGuardrails`
 * on the Agent config. Each guardrail is `{ name, execute }` where `execute`
 * returns `{ outputInfo, tripwireTriggered }`. Tripping a wire halts the run.
 *
 * We expose two builders that produce SDK-compatible guardrails wired to
 * governance pre/post enforcement:
 *
 *   - `createInputGuardrail(gov, config)`
 *   - `createOutputGuardrail(gov, config)`
 *
 * On block/require_approval we set `tripwireTriggered: true` — the Agents
 * runtime halts and surfaces `outputInfo` (the EnforcementDecision) to the
 * caller. On warn/allow we pass through. Mask outcomes fire the onMask
 * callback; the Agents SDK doesn't support output rewriting via guardrail,
 * so mask → tripwire with the masked text in outputInfo for the caller to
 * handle.
 *
 * @example
 * ```ts
 * import { Agent } from '@openai/agents';
 * import { createGovernance } from 'governance-sdk';
 * import {
 *   createInputGuardrail,
 *   createOutputGuardrail,
 * } from 'governance-sdk/plugins/openai-agents';
 *
 * const gov = createGovernance({ rules: [] });
 * const { id: agentId } = await gov.register({
 *   name: 'research', framework: 'openai', owner: 'team',
 * });
 *
 * const agent = new Agent({
 *   name: 'research',
 *   instructions: '...',
 *   inputGuardrails: [createInputGuardrail(gov, { agentId })],
 *   outputGuardrails: [createOutputGuardrail(gov, { agentId })],
 * });
 * ```
 */

import type { GovernanceInstance } from "../index";
import type { EnforcementDecision } from "../policy";
import type { OutcomeCallbacks } from "./outcome-handler.js";
import {
  GovernanceBlockedError,
  GovernanceApprovalRequiredError,
} from "./outcome-handler.js";
import { enforcePreprocess, enforcePostprocess } from "./pre-post-enforce.js";

// ─── Types ──────────────────────────────────────────────────────

/** Shape of an OpenAI Agents SDK input guardrail. */
export interface OpenAIInputGuardrail {
  name: string;
  execute: (args: {
    input: unknown;
    context?: unknown;
  }) => Promise<{
    outputInfo: unknown;
    tripwireTriggered: boolean;
  }>;
}

/** Shape of an OpenAI Agents SDK output guardrail. */
export interface OpenAIOutputGuardrail {
  name: string;
  execute: (args: {
    agentOutput: unknown;
    context?: unknown;
  }) => Promise<{
    outputInfo: unknown;
    tripwireTriggered: boolean;
  }>;
}

export interface OpenAIGuardrailConfig extends OutcomeCallbacks {
  agentId: string;
  agentName?: string;
  agentLevel?: number;
  /** Name used in the guardrail record (default: governance.input / .output). */
  name?: string;
  metadata?: Record<string, unknown>;
  sessionTokenTracker?: () => number;
}

export interface GuardrailOutputInfo {
  stage: "preprocess" | "postprocess";
  decision: EnforcementDecision;
  /** Original text that was scanned. */
  text: string;
  /** Masked text, if outcome was "mask". */
  maskedText?: string;
}

// ─── Input Guardrail ────────────────────────────────────────────

export function createInputGuardrail(
  governance: GovernanceInstance,
  config: OpenAIGuardrailConfig,
): OpenAIInputGuardrail {
  const callbacks: OutcomeCallbacks = config;

  return {
    name: config.name ?? "governance.input",
    execute: async ({ input }) => {
      const text = inputToText(input);
      if (!text) {
        return { outputInfo: null, tripwireTriggered: false };
      }

      try {
        const result = await enforcePreprocess(governance, text, {
          agentId: config.agentId,
          agentName: config.agentName,
          agentLevel: config.agentLevel,
          metadata: config.metadata,
          sessionTokensUsed: config.sessionTokenTracker?.(),
          callbacks,
          toolName: "openai-agents.inputGuardrail",
        });

        const info: GuardrailOutputInfo = {
          stage: "preprocess",
          decision: result.decision,
          text,
        };
        // Mask does not throw — surface via tripwire with maskedText so the
        // caller can substitute before re-running.
        if (result.decision.outcome === "mask") {
          info.maskedText = result.text;
          return { outputInfo: info, tripwireTriggered: true };
        }
        return { outputInfo: info, tripwireTriggered: false };
      } catch (err) {
        if (
          err instanceof GovernanceBlockedError ||
          err instanceof GovernanceApprovalRequiredError
        ) {
          return {
            outputInfo: {
              stage: "preprocess",
              decision: err.decision,
              text,
            } satisfies GuardrailOutputInfo,
            tripwireTriggered: true,
          };
        }
        throw err;
      }
    },
  };
}

// ─── Output Guardrail ───────────────────────────────────────────

export function createOutputGuardrail(
  governance: GovernanceInstance,
  config: OpenAIGuardrailConfig,
): OpenAIOutputGuardrail {
  const callbacks: OutcomeCallbacks = config;

  return {
    name: config.name ?? "governance.output",
    execute: async ({ agentOutput }) => {
      const text = outputToText(agentOutput);
      if (!text) {
        return { outputInfo: null, tripwireTriggered: false };
      }

      try {
        const result = await enforcePostprocess(governance, text, {
          agentId: config.agentId,
          agentName: config.agentName,
          agentLevel: config.agentLevel,
          metadata: config.metadata,
          sessionTokensUsed: config.sessionTokenTracker?.(),
          callbacks,
          toolName: "openai-agents.outputGuardrail",
        });

        const info: GuardrailOutputInfo = {
          stage: "postprocess",
          decision: result.decision,
          text,
        };
        if (result.decision.outcome === "mask") {
          info.maskedText = result.text;
          return { outputInfo: info, tripwireTriggered: true };
        }
        return { outputInfo: info, tripwireTriggered: false };
      } catch (err) {
        if (
          err instanceof GovernanceBlockedError ||
          err instanceof GovernanceApprovalRequiredError
        ) {
          return {
            outputInfo: {
              stage: "postprocess",
              decision: err.decision,
              text,
            } satisfies GuardrailOutputInfo,
            tripwireTriggered: true,
          };
        }
        throw err;
      }
    },
  };
}

// ─── Helpers ────────────────────────────────────────────────────

function inputToText(input: unknown): string {
  if (typeof input === "string") return input;
  if (Array.isArray(input)) {
    // Array of input items (Agents SDK message-style input)
    for (let i = input.length - 1; i >= 0; i--) {
      const item = input[i];
      if (!item || typeof item !== "object") continue;
      const obj = item as { role?: string; content?: unknown };
      if (obj.role !== "user") continue;
      return contentToText(obj.content);
    }
  }
  return "";
}

function outputToText(output: unknown): string {
  if (typeof output === "string") return output;
  if (output && typeof output === "object") {
    const obj = output as { content?: unknown; text?: unknown };
    if (typeof obj.text === "string") return obj.text;
    return contentToText(obj.content);
  }
  return "";
}

function contentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (part && typeof part === "object" && "type" in part) {
          const p = part as { type: string; text?: string };
          if (p.type === "text" || p.type === "input_text" || p.type === "output_text") {
            return p.text ?? "";
          }
        }
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  return "";
}
