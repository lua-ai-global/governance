/**
 * governance-sdk — Ed25519 Cryptographic Agent Identity
 *
 * Public-key agent identity using Ed25519 via Web Crypto API.
 * Zero dependencies. Supports key generation, action signing, verification,
 * self-signed certificates, and capability-narrowing delegation.
 *
 * @example
 * ```ts
 * import { createEd25519Identity } from 'governance-sdk/agent-identity-ed25519';
 *
 * const identity = createEd25519Identity();
 * const keyPair = await identity.generateKeyPair();
 * const cert = await identity.createCertificate(keyPair.privateKey, {
 *   agentId: 'bot-1', name: 'sales-bot', capabilities: ['search', 'email'],
 * });
 * const signature = await identity.signAction(keyPair.privateKey, { action: 'tool_call', tool: 'search' });
 * const valid = await identity.verifyAction(keyPair.publicKey, { action: 'tool_call', tool: 'search' }, signature);
 * ```
 */

import { deepSortKeys } from "./audit-integrity.js";

// ─── Types ───────────────────────────────────────────────────

export interface Ed25519KeyPair {
  publicKey: CryptoKey;
  privateKey: CryptoKey;
  /** Hex-encoded public key for storage/transmission */
  publicKeyHex: string;
}

export interface AgentCertificate {
  agentId: string;
  name: string;
  publicKeyHex: string;
  capabilities: string[];
  issuedAt: string;
  expiresAt?: string;
  issuer?: string;
  delegationDepth: number;
  signature: string;
}

export interface DelegatedIdentity {
  keyPair: Ed25519KeyPair;
  certificate: AgentCertificate;
}

export interface Ed25519Config {
  /** Certificate expiry in ms (default: 24 hours) */
  certificateTtlMs?: number;
  /** Maximum delegation depth (default: 5) */
  maxDelegationDepth?: number;
}

// ─── Implementation ─────────────────────────────────────────

export function createEd25519Identity(config: Ed25519Config = {}) {
  const { certificateTtlMs = 86_400_000, maxDelegationDepth = 5 } = config;

  return {
    /** Generate a new Ed25519 key pair */
    async generateKeyPair(): Promise<Ed25519KeyPair> {
      const keyPair = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]);
      const rawPublic = await crypto.subtle.exportKey("raw", keyPair.publicKey);
      const publicKeyHex = bufToHex(new Uint8Array(rawPublic));
      return { publicKey: keyPair.publicKey, privateKey: keyPair.privateKey, publicKeyHex };
    },

    /** Sign an action context with the agent's private key */
    async signAction(privateKey: CryptoKey, data: Record<string, unknown>): Promise<string> {
      const canonical = JSON.stringify(deepSortKeys(data));
      const encoded = new TextEncoder().encode(canonical);
      const sig = await crypto.subtle.sign("Ed25519", privateKey, encoded.buffer as ArrayBuffer);
      return bufToHex(new Uint8Array(sig));
    },

    /** Verify an action signature with the agent's public key */
    async verifyAction(publicKey: CryptoKey, data: Record<string, unknown>, signature: string): Promise<boolean> {
      const canonical = JSON.stringify(deepSortKeys(data));
      const encoded = new TextEncoder().encode(canonical);
      const sigBytes = hexToBuf(signature);
      return crypto.subtle.verify("Ed25519", publicKey, sigBytes.buffer as ArrayBuffer, encoded.buffer as ArrayBuffer);
    },

    /** Create a self-signed agent certificate */
    async createCertificate(
      privateKey: CryptoKey,
      agent: { agentId: string; name: string; capabilities: string[] },
      issuer?: string,
    ): Promise<AgentCertificate> {
      const rawPublic = await crypto.subtle.exportKey("raw", await derivePublicKey(privateKey));
      const publicKeyHex = bufToHex(new Uint8Array(rawPublic));

      const cert: Omit<AgentCertificate, "signature"> = {
        agentId: agent.agentId,
        name: agent.name,
        publicKeyHex,
        capabilities: [...agent.capabilities].sort(),
        issuedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + certificateTtlMs).toISOString(),
        issuer: issuer ?? agent.agentId,
        delegationDepth: 0,
      };

      const canonical = JSON.stringify(deepSortKeys(cert));
      const encoded = new TextEncoder().encode(canonical);
      const sig = await crypto.subtle.sign("Ed25519", privateKey, encoded.buffer as ArrayBuffer);

      return { ...cert, signature: bufToHex(new Uint8Array(sig)) };
    },

    /** Verify a certificate's signature and expiry */
    async verifyCertificate(cert: AgentCertificate): Promise<{ valid: boolean; reason?: string }> {
      if (cert.expiresAt && new Date(cert.expiresAt).getTime() < Date.now()) {
        return { valid: false, reason: "Certificate has expired" };
      }

      const publicKey = await importPublicKey(cert.publicKeyHex);
      const { signature, ...certData } = cert;
      const canonical = JSON.stringify(deepSortKeys(certData));
      const encoded = new TextEncoder().encode(canonical);
      const sigBytes = hexToBuf(signature);

      const valid = await crypto.subtle.verify("Ed25519", publicKey, sigBytes.buffer as ArrayBuffer, encoded.buffer as ArrayBuffer);
      return valid ? { valid: true } : { valid: false, reason: "Invalid certificate signature" };
    },

    /**
     * Delegate identity to a child agent with narrowed capabilities.
     * Child capabilities must be a subset of parent capabilities.
     */
    async delegate(
      parentKey: CryptoKey,
      parentCert: AgentCertificate,
      child: { agentId: string; name: string; capabilities: string[] },
    ): Promise<DelegatedIdentity> {
      const depth = parentCert.delegationDepth + 1;
      if (depth > maxDelegationDepth) {
        throw new Error(`Delegation depth ${depth} exceeds maximum ${maxDelegationDepth}`);
      }

      const invalid = child.capabilities.filter((c) => !parentCert.capabilities.includes(c));
      if (invalid.length > 0) {
        throw new Error(`Cannot delegate capabilities not held by parent: ${invalid.join(", ")}`);
      }

      const childKeyPair = await this.generateKeyPair();

      const cert: Omit<AgentCertificate, "signature"> = {
        agentId: child.agentId,
        name: child.name,
        publicKeyHex: childKeyPair.publicKeyHex,
        capabilities: [...child.capabilities].sort(),
        issuedAt: new Date().toISOString(),
        expiresAt: parentCert.expiresAt, // inherit parent expiry
        issuer: parentCert.agentId,
        delegationDepth: depth,
      };

      const canonical = JSON.stringify(deepSortKeys(cert));
      const encoded = new TextEncoder().encode(canonical);
      const sig = await crypto.subtle.sign("Ed25519", parentKey, encoded);

      return { keyPair: childKeyPair, certificate: { ...cert, signature: bufToHex(new Uint8Array(sig)) } };
    },

    /** Import a public key from hex for verification */
    importPublicKey,
  };
}

// ─── Utilities ──────────────────────────────────────────────

function bufToHex(buf: Uint8Array): string {
  return Array.from(buf, (b) => b.toString(16).padStart(2, "0")).join("");
}

function hexToBuf(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.slice(i, i + 2), 16);
  }
  return bytes;
}

async function importPublicKey(hex: string): Promise<CryptoKey> {
  const raw = hexToBuf(hex);
  return crypto.subtle.importKey("raw", raw.buffer as ArrayBuffer, "Ed25519", true, ["verify"]);
}

async function derivePublicKey(privateKey: CryptoKey): Promise<CryptoKey> {
  // Export the private key as JWK, then import only the public component
  const jwk = await crypto.subtle.exportKey("jwk", privateKey);
  delete jwk.d; // remove private component
  jwk.key_ops = ["verify"];
  return crypto.subtle.importKey("jwk", jwk, "Ed25519", true, ["verify"]);
}
