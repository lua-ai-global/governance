/**
 * @lua-ai-global/governance — Tamper-Evident Audit Logging
 *
 * HMAC-SHA256 hash chaining for audit events. Each event's hash includes
 * the previous hash, making tampering immediately detectable.
 * EU AI Act Article 12 compliant.
 */

import type { AuditEvent, AuditQueryFilters, GovernanceInstance } from "./index";

// ─── Types ──────────────────────────────────────────────────

/** Integrity metadata attached to each audit event */
export interface AuditIntegrity {
  /** HMAC-SHA256 hash of this event (including previousHash) */
  hash: string;
  /** Hash of the previous event in the chain */
  previousHash: string;
  /** Sequence number in the chain (1-indexed) */
  sequence: number;
  /** ISO timestamp when the hash was computed */
  signedAt: string;
}

/** An audit event with tamper-evident integrity */
export interface IntegrityAuditEvent extends AuditEvent {
  integrity: AuditIntegrity;
}

/** Configuration for integrity audit */
export interface IntegrityAuditConfig {
  /** HMAC signing key — keep this secret */
  signingKey: string;
  /** Algorithm label (default: "hmac-sha256") */
  algorithm?: string;
}

/** Result of verifying the audit chain */
export interface ChainVerificationResult {
  /** Whether the entire chain is valid */
  valid: boolean;
  /** Number of events verified */
  eventsVerified: number;
  /** Total events in the chain */
  totalEvents: number;
  /** Index of first broken link (null if valid) */
  brokenAt: number | null;
  /** Details of the break (null if valid) */
  breakDetail: string | null;
  /** When the verification was performed */
  verifiedAt: string;
}

/** Integrity audit interface */
export interface IntegrityAudit {
  /** Log an event with tamper-evident hash chaining */
  log: (event: Omit<AuditEvent, "id" | "createdAt">) => Promise<IntegrityAuditEvent>;
  /** Verify the entire audit chain */
  verify: (filters?: AuditQueryFilters) => Promise<ChainVerificationResult>;
  /** Export the chain for external audit */
  export: (filters?: AuditQueryFilters) => Promise<IntegrityAuditEvent[]>;
  /** Get chain statistics */
  stats: () => Promise<{
    totalEvents: number;
    latestSequence: number;
    latestHash: string;
    algorithm: string;
  }>;
}

// ─── HMAC-SHA256 Implementation ─────────────────────────────
// Uses Web Crypto API (available in Node 18+ and all modern browsers)

export async function hmacSha256(key: string, data: string): Promise<string> {
  const encoder = new TextEncoder();
  const keyData = encoder.encode(key);
  const msgData = encoder.encode(data);

  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    keyData,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );

  const signature = await crypto.subtle.sign("HMAC", cryptoKey, msgData);
  const hashArray = Array.from(new Uint8Array(signature));
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Deep-sort all object keys for deterministic serialization */
export function deepSortKeys(value: unknown): unknown {
  if (value === null || value === undefined || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(deepSortKeys);
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    sorted[key] = deepSortKeys((value as Record<string, unknown>)[key]);
  }
  return sorted;
}

/** Compute the canonical string representation of an audit event for hashing */
export function canonicalize(event: AuditEvent, previousHash: string, sequence: number): string {
  // Deterministic serialization: ALL keys sorted recursively (including nested detail)
  const canonical = deepSortKeys({
    agentId: event.agentId,
    createdAt: event.createdAt,
    detail: event.detail ?? null,
    eventType: event.eventType,
    id: event.id,
    outcome: event.outcome,
    policyRuleId: event.policyRuleId ?? null,
    previousHash,
    sequence,
    severity: event.severity,
  });

  return JSON.stringify(canonical);
}

// ─── Create Integrity Audit ─────────────────────────────────

export const GENESIS_HASH = "0".repeat(64); // Initial chain hash

/**
 * Create a tamper-evident audit trail on top of a governance instance.
 *
 * Wraps the governance audit system with HMAC-SHA256 hash chaining.
 * Each event's hash includes the previous event's hash, creating
 * an immutable chain. Any tampering is immediately detectable.
 *
 * Satisfies EU AI Act Article 12 logging integrity requirements.
 */
export function createIntegrityAudit(
  governance: GovernanceInstance,
  config: IntegrityAuditConfig,
): IntegrityAudit {
  const algorithm = config.algorithm ?? "hmac-sha256";

  // Chain state
  let lastHash = GENESIS_HASH;
  let sequence = 0;
  const integrityMap = new Map<string, AuditIntegrity>();

  // Serialization queue — prevents concurrent log() calls from forking the chain
  let chainLock: Promise<unknown> = Promise.resolve();

  async function log(
    eventInput: Omit<AuditEvent, "id" | "createdAt">,
  ): Promise<IntegrityAuditEvent> {
    // Chain operations serially to prevent hash fork from concurrent calls
    const result = chainLock.then(async () => {
      const event = await governance.audit.log(eventInput);

      sequence++;
      const previousHash = lastHash;
      const canonical = canonicalize(event, previousHash, sequence);
      const hash = await hmacSha256(config.signingKey, canonical);

      const integrity: AuditIntegrity = {
        hash,
        previousHash,
        sequence,
        signedAt: new Date().toISOString(),
      };

      lastHash = hash;
      integrityMap.set(event.id, integrity);

      return { ...event, integrity } as IntegrityAuditEvent;
    });

    // Update lock — next caller waits for this one to finish
    chainLock = result.catch(() => { /* lock must advance even on failure */ });

    return result;
  }

  async function verify(
    filters?: AuditQueryFilters,
  ): Promise<ChainVerificationResult> {
    const events = await governance.audit.query({
      ...filters,
      limit: undefined,
      offset: undefined,
    });

    // Sort by creation time (oldest first)
    const sorted = [...events].sort((a, b) =>
      a.createdAt.localeCompare(b.createdAt),
    );

    let currentPreviousHash = GENESIS_HASH;
    let seq = 0;

    for (let i = 0; i < sorted.length; i++) {
      const event = sorted[i];
      const integrity = integrityMap.get(event.id);

      if (!integrity) {
        return {
          valid: false,
          eventsVerified: i,
          totalEvents: sorted.length,
          brokenAt: i,
          breakDetail: `Event ${event.id} has no integrity record — possible insertion`,
          verifiedAt: new Date().toISOString(),
        };
      }

      // Verify chain continuity
      if (integrity.previousHash !== currentPreviousHash) {
        return {
          valid: false,
          eventsVerified: i,
          totalEvents: sorted.length,
          brokenAt: i,
          breakDetail: `Chain break at sequence ${integrity.sequence}: expected previousHash ${currentPreviousHash.slice(0, 12)}..., got ${integrity.previousHash.slice(0, 12)}...`,
          verifiedAt: new Date().toISOString(),
        };
      }

      // Recompute hash to verify content integrity
      seq++;
      const canonical = canonicalize(event, currentPreviousHash, seq);
      const expectedHash = await hmacSha256(config.signingKey, canonical);

      if (expectedHash !== integrity.hash) {
        return {
          valid: false,
          eventsVerified: i,
          totalEvents: sorted.length,
          brokenAt: i,
          breakDetail: `Hash mismatch at sequence ${seq}: event ${event.id} has been modified`,
          verifiedAt: new Date().toISOString(),
        };
      }

      currentPreviousHash = integrity.hash;
    }

    return {
      valid: true,
      eventsVerified: sorted.length,
      totalEvents: sorted.length,
      brokenAt: null,
      breakDetail: null,
      verifiedAt: new Date().toISOString(),
    };
  }

  async function exportChain(
    filters?: AuditQueryFilters,
  ): Promise<IntegrityAuditEvent[]> {
    const events = await governance.audit.query({
      ...filters,
      limit: undefined,
      offset: undefined,
    });

    const sorted = [...events].sort((a, b) =>
      a.createdAt.localeCompare(b.createdAt),
    );

    return sorted
      .filter((e) => integrityMap.has(e.id))
      .map((e) => ({
        ...e,
        integrity: integrityMap.get(e.id)!,
      }));
  }

  async function stats() {
    const total = await governance.audit.count();
    return {
      totalEvents: total,
      latestSequence: sequence,
      latestHash: lastHash,
      algorithm,
    };
  }

  return { log, verify, export: exportChain, stats };
}
