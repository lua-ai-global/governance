/**
 * MCP call recorder — honest-naming re-export of `/plugins/mcp-chain-audit`.
 *
 * This records MCP tool calls that the caller explicitly reports via
 * `recordCall(...)`. It does NOT automatically propagate across MCP
 * server boundaries — nested MCP→MCP sub-calls must be recorded by the
 * intermediate server or they will not appear in the chain. Pattern
 * detection (read→upload, etc.) runs against whatever has been recorded.
 *
 * @example
 * ```ts
 * import { createMCPCallRecorder } from 'governance-sdk/plugins/mcp-call-recorder';
 * const recorder = createMCPCallRecorder();
 * recorder.recordCall({ server: 'files', tool: 'read', args: { path: '/secrets' } });
 * const patterns = recorder.detectPatterns();
 * ```
 */
export {
  createMCPCallRecorder,
  createChainAuditor,
  type ChainEntry,
  type ChainEntry as MCPCallRecord,
  type ChainAuditConfig,
  type ChainAuditConfig as MCPCallRecorderConfig,
  type SuspiciousPattern,
  type PatternMatch,
} from "./mcp-chain-audit.js";
