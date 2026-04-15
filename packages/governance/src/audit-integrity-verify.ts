/**
 * governance-sdk — Standalone audit-chain verifier
 *
 * Verifies a snapshot of integrity-wrapped audit entries without needing a
 * live {@link IntegrityAudit} instance. Useful for offline audit: export
 * the chain via `integrityAudit.export()`, ship the JSON somewhere else,
 * re-verify with this function + the shared signing secret.
 *
 * Detects:
 *   - content edits (hash mismatch on a given entry)
 *   - entry deletion (broken `previousHash` linkage, sequence gap)
 *   - entry reordering (sequence numbers mismatch reconstruction)
 *   - forged insertions without the secret (hash recomputation fails)
 *
 * Does NOT detect:
 *   - rollback to an earlier valid checkpoint (requires an external anchor)
 *   - forgery by anyone who holds the signing secret (plain HMAC chains are
 *     only tamper-evident to holders of the key — use key rotation + pair
 *     with an external anchor if you need defence in depth)
 */

import {
  GENESIS_HASH,
  canonicalize,
  constantTimeEqualHex,
  hmacSha256,
  type ChainVerificationResult,
  type IntegrityAuditEvent,
} from "./audit-integrity.js";

export async function verifyAuditIntegrity(
  entries: IntegrityAuditEvent[],
  signingKey: string,
): Promise<ChainVerificationResult> {
  const sorted = [...entries].sort((a, b) => {
    const t = a.createdAt.localeCompare(b.createdAt);
    if (t !== 0) return t;
    return a.integrity.sequence - b.integrity.sequence;
  });

  let currentPreviousHash = GENESIS_HASH;
  let seq = 0;

  for (let i = 0; i < sorted.length; i++) {
    const event = sorted[i];
    if (!event.integrity || typeof event.integrity.hash !== "string") {
      return broken(i, sorted.length, `Event ${event.id} missing integrity metadata`);
    }
    seq++;
    if (event.integrity.sequence !== seq) {
      return broken(
        i,
        sorted.length,
        `Sequence gap at position ${i}: expected sequence ${seq}, got ${event.integrity.sequence} (reordering or deletion)`,
      );
    }
    if (!constantTimeEqualHex(event.integrity.previousHash, currentPreviousHash)) {
      return broken(
        i,
        sorted.length,
        `Chain break at sequence ${seq}: expected previousHash ${currentPreviousHash.slice(0, 12)}..., got ${event.integrity.previousHash.slice(0, 12)}...`,
      );
    }
    const canonical = canonicalize(event, currentPreviousHash, seq);
    const expectedHash = await hmacSha256(signingKey, canonical);
    if (!constantTimeEqualHex(expectedHash, event.integrity.hash)) {
      return broken(
        i,
        sorted.length,
        `Hash mismatch at sequence ${seq}: event ${event.id} content has been modified`,
      );
    }
    currentPreviousHash = event.integrity.hash;
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

function broken(i: number, total: number, detail: string): ChainVerificationResult {
  return {
    valid: false,
    eventsVerified: i,
    totalEvents: total,
    brokenAt: i,
    breakDetail: detail,
    verifiedAt: new Date().toISOString(),
  };
}
