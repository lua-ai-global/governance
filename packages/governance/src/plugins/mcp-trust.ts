/**
 * MCP Server Trust Registry — **declarative allowlist**, not cryptographic trust.
 *
 * Manages a caller-curated registry of MCP server URIs with trust labels
 * and capability tags. Validates an MCP connection's URI against the
 * registry before allowing tool calls. Does NOT perform TLS pinning,
 * public-key pinning, signature verification, or checksum validation —
 * those would require the registry to hold cryptographic material, which
 * it does not. If you need cryptographic pin-trust, build it in your
 * transport layer and pass validated URIs to this registry.
 *
 * @example
 * ```ts
 * import { createMCPTrustRegistry } from 'governance-sdk/plugins/mcp-trust';
 *
 * const trust = createMCPTrustRegistry({
 *   servers: [
 *     { uri: 'mcp://files.company.com', trust: 'verified', capabilities: ['read', 'write'] },
 *     { uri: 'mcp://external-search.io', trust: 'untrusted' },
 *   ],
 *   defaultTrust: 'untrusted',
 * });
 *
 * const result = trust.validate('mcp://files.company.com');
 * // { allowed: true, trust: 'verified', capabilities: ['read', 'write'] }
 * ```
 */

// ─── Types ───────────────────────────────────────────────────

export type MCPTrustLevel = "verified" | "trusted" | "known" | "untrusted" | "blocked";

export interface MCPServerEntry {
  uri: string;
  trust: MCPTrustLevel;
  capabilities?: string[];
  addedAt?: string;
  lastVerifiedAt?: string;
}

export interface MCPTrustConfig {
  servers?: MCPServerEntry[];
  defaultTrust?: MCPTrustLevel;
  /** Block all untrusted servers (default: false — warn only) */
  blockUntrusted?: boolean;
}

export interface MCPTrustValidation {
  allowed: boolean;
  trust: MCPTrustLevel;
  capabilities: string[];
  reason: string;
}

// ─── Implementation ─────────────────────────────────────────

export function createMCPTrustRegistry(config: MCPTrustConfig = {}) {
  const { defaultTrust = "untrusted", blockUntrusted = false } = config;
  const registry = new Map<string, MCPServerEntry>();

  for (const server of config.servers ?? []) {
    registry.set(normalizeUri(server.uri), {
      ...server,
      uri: normalizeUri(server.uri),
      addedAt: server.addedAt ?? new Date().toISOString(),
    });
  }

  return {
    /** Validate whether an MCP server is trusted */
    validate(serverUri: string): MCPTrustValidation {
      const normalized = normalizeUri(serverUri);
      const entry = registry.get(normalized);

      if (!entry) {
        const allowed = defaultTrust !== "blocked" && !(blockUntrusted && defaultTrust === "untrusted");
        return {
          allowed,
          trust: defaultTrust,
          capabilities: [],
          reason: allowed ? `Unknown server — default trust: ${defaultTrust}` : `Unknown server blocked (default: ${defaultTrust})`,
        };
      }

      if (entry.trust === "blocked") {
        return { allowed: false, trust: "blocked", capabilities: [], reason: `Server "${normalized}" is explicitly blocked` };
      }

      if (blockUntrusted && entry.trust === "untrusted") {
        return { allowed: false, trust: "untrusted", capabilities: entry.capabilities ?? [], reason: `Server "${normalized}" is untrusted and blockUntrusted is enabled` };
      }

      return { allowed: true, trust: entry.trust, capabilities: entry.capabilities ?? [], reason: `Server "${normalized}" is ${entry.trust}` };
    },

    /** Add or update a server in the registry */
    register(entry: MCPServerEntry): void {
      registry.set(normalizeUri(entry.uri), {
        ...entry,
        uri: normalizeUri(entry.uri),
        addedAt: entry.addedAt ?? new Date().toISOString(),
      });
    },

    /** Remove a server from the registry */
    remove(uri: string): boolean {
      return registry.delete(normalizeUri(uri));
    },

    /** Block a server */
    block(uri: string, reason?: string): void {
      const normalized = normalizeUri(uri);
      const existing = registry.get(normalized);
      registry.set(normalized, {
        uri: normalized,
        trust: "blocked",
        capabilities: existing?.capabilities,
        addedAt: existing?.addedAt ?? new Date().toISOString(),
      });
    },

    /** List all registered servers */
    list(): MCPServerEntry[] {
      return [...registry.values()];
    },

    /** Get a specific server entry */
    get(uri: string): MCPServerEntry | undefined {
      return registry.get(normalizeUri(uri));
    },

    /** Count servers by trust level */
    stats(): Record<MCPTrustLevel, number> {
      const counts: Record<MCPTrustLevel, number> = { verified: 0, trusted: 0, known: 0, untrusted: 0, blocked: 0 };
      for (const entry of registry.values()) counts[entry.trust]++;
      return counts;
    },
  };
}

// ─── Utilities ──────────────────────────────────────────────

function normalizeUri(uri: string): string {
  return uri.toLowerCase().replace(/\/+$/, "");
}
