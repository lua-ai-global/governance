/**
 * MCP Tool Call Chain Auditing
 *
 * Tracks sequences of tool calls across MCP server boundaries.
 * Detects suspicious patterns and maintains a cross-server audit trail.
 *
 * @example
 * ```ts
 * import { createChainAuditor } from '@lua-ai-global/governance/plugins/mcp-chain-audit';
 *
 * const auditor = createChainAuditor({ maxChainLength: 20 });
 * auditor.recordCall({ server: 'mcp://files', tool: 'read_file', agentId: 'bot-1' });
 * auditor.recordCall({ server: 'mcp://web', tool: 'upload', agentId: 'bot-1' });
 *
 * const chain = auditor.getChain('bot-1');
 * // [{ server, tool, timestamp, sequence }, ...]
 * ```
 */

// ─── Types ───────────────────────────────────────────────────

export interface ChainEntry {
  server: string;
  tool: string;
  agentId: string;
  timestamp: string;
  sequence: number;
  durationMs?: number;
  outcome?: "success" | "failure" | "blocked";
}

export interface ChainAuditConfig {
  maxChainLength?: number;
  /** Alert patterns — sequences of tool calls that trigger warnings */
  suspiciousPatterns?: SuspiciousPattern[];
}

export interface SuspiciousPattern {
  id: string;
  description: string;
  /** Ordered tool names to match */
  sequence: string[];
  severity: "low" | "medium" | "high" | "critical";
}

export interface PatternMatch {
  patternId: string;
  description: string;
  severity: string;
  matchedAt: number[];
}

// ─── Implementation ─────────────────────────────────────────

export function createChainAuditor(config: ChainAuditConfig = {}) {
  const { maxChainLength = 50 } = config;
  const chains = new Map<string, ChainEntry[]>();
  const patterns = config.suspiciousPatterns ?? getDefaultPatterns();

  return {
    /** Record a tool call in the chain */
    recordCall(call: { server: string; tool: string; agentId: string; durationMs?: number; outcome?: ChainEntry["outcome"] }): ChainEntry {
      const chain = chains.get(call.agentId) ?? [];
      const entry: ChainEntry = {
        server: call.server,
        tool: call.tool,
        agentId: call.agentId,
        timestamp: new Date().toISOString(),
        sequence: chain.length,
        durationMs: call.durationMs,
        outcome: call.outcome,
      };

      chain.push(entry);
      if (chain.length > maxChainLength) chain.shift();
      chains.set(call.agentId, chain);

      return entry;
    },

    /** Get the call chain for an agent */
    getChain(agentId: string): ChainEntry[] {
      return [...(chains.get(agentId) ?? [])];
    },

    /** Check the current chain for suspicious patterns */
    detectPatterns(agentId: string): PatternMatch[] {
      const chain = chains.get(agentId) ?? [];
      if (chain.length < 2) return [];

      const toolSequence = chain.map((c) => c.tool);
      const matches: PatternMatch[] = [];

      for (const pattern of patterns) {
        const indices = findSubsequence(toolSequence, pattern.sequence);
        if (indices.length > 0) {
          matches.push({
            patternId: pattern.id,
            description: pattern.description,
            severity: pattern.severity,
            matchedAt: indices,
          });
        }
      }

      return matches;
    },

    /** Get cross-server transitions (tool calls that span different MCP servers) */
    getCrossServerTransitions(agentId: string): Array<{ from: ChainEntry; to: ChainEntry }> {
      const chain = chains.get(agentId) ?? [];
      const transitions: Array<{ from: ChainEntry; to: ChainEntry }> = [];

      for (let i = 1; i < chain.length; i++) {
        if (chain[i].server !== chain[i - 1].server) {
          transitions.push({ from: chain[i - 1], to: chain[i] });
        }
      }

      return transitions;
    },

    /** Clear chain for an agent */
    clearChain(agentId: string): void {
      chains.delete(agentId);
    },

    /** Get chain statistics */
    stats(agentId: string): { length: number; servers: number; tools: number; crossServerTransitions: number } {
      const chain = chains.get(agentId) ?? [];
      const servers = new Set(chain.map((c) => c.server));
      const tools = new Set(chain.map((c) => c.tool));
      let transitions = 0;
      for (let i = 1; i < chain.length; i++) {
        if (chain[i].server !== chain[i - 1].server) transitions++;
      }
      return { length: chain.length, servers: servers.size, tools: tools.size, crossServerTransitions: transitions };
    },
  };
}

// ─── Pattern Matching ───────────────────────────────────────

function findSubsequence(sequence: string[], pattern: string[]): number[] {
  const indices: number[] = [];
  for (let i = 0; i <= sequence.length - pattern.length; i++) {
    let match = true;
    for (let j = 0; j < pattern.length; j++) {
      if (pattern[j] !== "*" && sequence[i + j] !== pattern[j]) {
        match = false;
        break;
      }
    }
    if (match) indices.push(i);
  }
  return indices;
}

function getDefaultPatterns(): SuspiciousPattern[] {
  return [
    {
      id: "read-then-exfiltrate",
      description: "Data read followed by external upload — potential exfiltration",
      sequence: ["read_file", "upload"],
      severity: "high",
    },
    {
      id: "read-then-send",
      description: "Data read followed by message send — potential data leak",
      sequence: ["read_file", "send_message"],
      severity: "medium",
    },
    {
      id: "delete-after-read",
      description: "File deletion after read — potential evidence destruction",
      sequence: ["read_file", "delete_file"],
      severity: "high",
    },
  ];
}
