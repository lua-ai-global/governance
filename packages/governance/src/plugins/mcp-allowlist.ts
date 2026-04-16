/**
 * MCP server allowlist — honest-naming re-export of `/plugins/mcp-trust`.
 *
 * This is a declarative URI allowlist, not a cryptographic trust registry.
 * It does NOT perform TLS pinning, public-key pinning, signature
 * verification, or checksum validation. If you need cryptographic trust,
 * build it in your transport layer and pass validated URIs here.
 *
 * @example
 * ```ts
 * import { createMCPAllowlist } from 'governance-sdk/plugins/mcp-allowlist';
 * const gate = createMCPAllowlist({
 *   servers: [{ uri: 'mcp://files.company.com', trust: 'verified' }],
 *   defaultTrust: 'untrusted',
 *   blockUntrusted: true,
 * });
 * ```
 */
export {
  createMCPAllowlist,
  createMCPTrustRegistry,
  type MCPAllowlistLevel,
  type MCPAllowlistConfig,
  type MCPAllowlistEntry,
  type MCPAllowlistValidation,
  type MCPTrustLevel,
  type MCPTrustConfig,
  type MCPServerEntry,
  type MCPTrustValidation,
} from "./mcp-trust.js";
