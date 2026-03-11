/**
 * Governance Event Emitter
 *
 * Subscribe to governance events in real-time — enforcement decisions,
 * agent registrations, kill switch activations, score changes.
 * Essential for dashboards, monitoring, and alerting.
 *
 * Zero-dependency implementation using native EventTarget.
 */

// ─── Types ──────────────────────────────────────────────────────

export type GovernanceEventType =
  | "enforcement"
  | "registration"
  | "kill"
  | "revive"
  | "score_change"
  | "policy_added"
  | "policy_removed"
  | "audit";

export interface GovernanceEvent {
  type: GovernanceEventType;
  timestamp: string;
  agentId?: string;
  detail: Record<string, unknown>;
}

export type GovernanceEventHandler = (event: GovernanceEvent) => void;

export interface GovernanceEmitter {
  /** Subscribe to a specific event type */
  on: (type: GovernanceEventType, handler: GovernanceEventHandler) => void;
  /** Subscribe to all events */
  onAny: (handler: GovernanceEventHandler) => void;
  /** Unsubscribe from a specific event type */
  off: (type: GovernanceEventType, handler: GovernanceEventHandler) => void;
  /** Unsubscribe from all events */
  offAny: (handler: GovernanceEventHandler) => void;
  /** Emit an event (used internally by governance hooks) */
  emit: (event: GovernanceEvent) => void;
  /** Get count of listeners */
  listenerCount: (type?: GovernanceEventType) => number;
  /** Remove all listeners */
  removeAllListeners: () => void;
}

// ─── Implementation ─────────────────────────────────────────────

/**
 * Create a governance event emitter.
 *
 * Lightweight, synchronous, zero-dependency event system.
 * Use with governance hooks to stream events to dashboards,
 * logging systems, or alerting pipelines.
 *
 * @example
 * ```ts
 * const emitter = createGovernanceEmitter();
 *
 * emitter.on('enforcement', (event) => {
 *   if (event.detail.blocked) {
 *     alert(`Agent ${event.agentId} blocked!`);
 *   }
 * });
 *
 * emitter.onAny((event) => {
 *   metrics.increment(`governance.${event.type}`);
 * });
 * ```
 */
export function createGovernanceEmitter(): GovernanceEmitter {
  const listeners = new Map<GovernanceEventType, Set<GovernanceEventHandler>>();
  const anyListeners = new Set<GovernanceEventHandler>();

  function on(type: GovernanceEventType, handler: GovernanceEventHandler): void {
    const set = listeners.get(type);
    if (set) {
      set.add(handler);
    } else {
      listeners.set(type, new Set([handler]));
    }
  }

  function onAny(handler: GovernanceEventHandler): void {
    anyListeners.add(handler);
  }

  function off(type: GovernanceEventType, handler: GovernanceEventHandler): void {
    listeners.get(type)?.delete(handler);
  }

  function offAny(handler: GovernanceEventHandler): void {
    anyListeners.delete(handler);
  }

  function emit(event: GovernanceEvent): void {
    const typeListeners = listeners.get(event.type);
    if (typeListeners) {
      for (const handler of typeListeners) {
        handler(event);
      }
    }
    for (const handler of anyListeners) {
      handler(event);
    }
  }

  function listenerCount(type?: GovernanceEventType): number {
    if (type) {
      return (listeners.get(type)?.size ?? 0) + anyListeners.size;
    }
    let total = anyListeners.size;
    for (const set of listeners.values()) {
      total += set.size;
    }
    return total;
  }

  function removeAllListeners(): void {
    listeners.clear();
    anyListeners.clear();
  }

  return { on, onAny, off, offAny, emit, listenerCount, removeAllListeners };
}
