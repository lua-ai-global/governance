/**
 * governance-sdk — High-level agent-identity token helpers
 *
 * Thin, opinionated wrappers around {@link createEd25519Identity} for callers
 * who just want "sign an agent identity" and "verify it." The token format
 * includes a nonce (`jti`), expiry (`exp`), and the agent's public key so
 * any verifier can re-check the signature. Split from
 * `agent-identity-ed25519.ts` to keep each file under 300 LOC.
 */

import { deepSortKeys } from "./audit-integrity.js";
import {
  bufToHex,
  hexToBuf,
  importPublicKey,
  type Ed25519KeyPair,
} from "./agent-identity-ed25519.js";

export interface AgentIdentityToken {
  payload: {
    agentId: string;
    publicKeyHex: string;
    kid?: string;
    iat: number;
    exp: number;
    jti: string;
    capabilities?: string[];
  };
  signature: string;
}

export interface SignAgentIdentityInput {
  agentId: string;
  keys: { publicKey: CryptoKey; privateKey: CryptoKey } | Ed25519KeyPair;
  /** Token lifetime in seconds. Default 3600. */
  ttlSeconds?: number;
  /** Opaque key identifier for rotation. */
  kid?: string;
  capabilities?: string[];
  /** Override the issued-at (UNIX seconds). Useful for reproducibility in tests. */
  now?: number;
}

/**
 * Sign an agent identity token.
 *
 * @example
 * ```ts
 * import { createEd25519Identity, signAgentIdentity, verifyAgentIdentity } from 'governance-sdk/agent-identity-ed25519';
 *
 * const identity = createEd25519Identity();
 * const keys = await identity.generateKeyPair();
 * const token = await signAgentIdentity({ agentId: 'sales-bot', keys, ttlSeconds: 3600 });
 * const result = await verifyAgentIdentity(token);
 * // => { valid: true, agentId: 'sales-bot' }
 * ```
 */
export async function signAgentIdentity(input: SignAgentIdentityInput): Promise<AgentIdentityToken> {
  const { agentId, keys, ttlSeconds = 3600, kid, capabilities, now } = input;
  const rawPublic = await crypto.subtle.exportKey("raw", keys.publicKey);
  const publicKeyHex = bufToHex(new Uint8Array(rawPublic));
  const iat = now ?? Math.floor(Date.now() / 1000);
  const payload: AgentIdentityToken["payload"] = {
    agentId,
    publicKeyHex,
    iat,
    exp: iat + ttlSeconds,
    jti: randomJti(),
    ...(kid !== undefined ? { kid } : {}),
    ...(capabilities !== undefined ? { capabilities: [...capabilities].sort() } : {}),
  };
  const canonical = JSON.stringify(deepSortKeys(payload));
  const encoded = new TextEncoder().encode(canonical);
  const sig = await crypto.subtle.sign("Ed25519", keys.privateKey, encoded.buffer as ArrayBuffer);
  return { payload, signature: bufToHex(new Uint8Array(sig)) };
}

export interface VerifyAgentIdentityOptions {
  /** Clock skew tolerance in seconds. Default 60. */
  clockSkewSeconds?: number;
  now?: number;
  /**
   * Optional pinned public key (hex). If supplied, verification fails when
   * the token's embedded `publicKeyHex` doesn't match. Pin this when you
   * know which key the agent is supposed to be using — an attacker who
   * swaps in their own key + signs with their own private key still
   * produces a token that "verifies" against its self-describing key,
   * so without pinning the token only proves "someone signed this."
   */
  pinnedPublicKeyHex?: string;
}

export interface VerifyAgentIdentityResult {
  valid: boolean;
  agentId?: string;
  reason?: string;
}

/**
 * Verify an agent identity token produced by {@link signAgentIdentity}.
 * Checks expiry, clock skew, optional pinned public key, and the Ed25519
 * signature over the canonicalised payload.
 */
export async function verifyAgentIdentity(
  token: AgentIdentityToken,
  options: VerifyAgentIdentityOptions = {},
): Promise<VerifyAgentIdentityResult> {
  const { clockSkewSeconds = 60, now, pinnedPublicKeyHex } = options;
  const nowSec = now ?? Math.floor(Date.now() / 1000);

  if (!token || typeof token !== "object" || !token.payload || typeof token.signature !== "string") {
    return { valid: false, reason: "Malformed token" };
  }
  const { payload, signature } = token;

  if (typeof payload.exp !== "number" || payload.exp + clockSkewSeconds < nowSec) {
    return { valid: false, reason: "Token expired" };
  }
  if (typeof payload.iat !== "number" || payload.iat - clockSkewSeconds > nowSec) {
    return { valid: false, reason: "Token not yet valid" };
  }
  if (pinnedPublicKeyHex && pinnedPublicKeyHex !== payload.publicKeyHex) {
    return { valid: false, reason: "Public key does not match pinned key" };
  }

  let publicKey: CryptoKey;
  let sigBytes: Uint8Array;
  try {
    publicKey = await importPublicKey(payload.publicKeyHex);
    sigBytes = hexToBuf(signature);
  } catch (err) {
    return { valid: false, reason: `Invalid key or signature encoding: ${(err as Error).message}` };
  }

  const canonical = JSON.stringify(deepSortKeys(payload));
  const encoded = new TextEncoder().encode(canonical);
  const ok = await crypto.subtle.verify(
    "Ed25519",
    publicKey,
    sigBytes.buffer as ArrayBuffer,
    encoded.buffer as ArrayBuffer,
  );
  return ok
    ? { valid: true, agentId: payload.agentId }
    : { valid: false, reason: "Invalid signature" };
}

function randomJti(): string {
  const bytes = new Uint8Array(16);
  if (typeof globalThis.crypto !== "undefined" && globalThis.crypto.getRandomValues) {
    globalThis.crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  return bufToHex(bytes);
}
