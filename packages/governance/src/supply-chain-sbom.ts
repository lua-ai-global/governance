/**
 * governance-sdk — Agent Software Bill of Materials (SBOM)
 *
 * Generates a JSON manifest of agent capabilities, dependencies,
 * and governance posture. Compatible with CycloneDX concepts.
 *
 * @example
 * ```ts
 * import { generateAgentSBOM } from 'governance-sdk/supply-chain-sbom';
 *
 * const sbom = generateAgentSBOM({
 *   agent: storedAgent,
 *   dependencies: { tools: ['search'], mcpServers: ['mcp://files'] },
 *   governanceScore: 87,
 *   governanceLevel: 4,
 *   complianceFrameworks: ['eu-ai-act', 'owasp-agentic'],
 * });
 * ```
 */

import type { AgentDependencies } from "./supply-chain.js";

// ─── Types ───────────────────────────────────────────────────

export interface AgentSBOMInput {
  agent: {
    id: string;
    name: string;
    framework?: string;
    owner?: string;
    version?: string;
    description?: string;
  };
  dependencies?: AgentDependencies;
  governanceScore?: number;
  governanceLevel?: number;
  complianceFrameworks?: string[];
  policies?: Array<{ id: string; name: string; outcome: string }>;
}

export interface AgentSBOM {
  bomFormat: "LuaAgentSBOM";
  specVersion: "1.0";
  serialNumber: string;
  generatedAt: string;
  component: {
    type: "agent";
    name: string;
    version: string;
    description: string;
    supplier: string;
    properties: Record<string, string | number>;
  };
  dependencies: {
    tools: string[];
    mcpServers: string[];
    apiEndpoints: string[];
    agents: string[];
  };
  governance: {
    score: number;
    level: number;
    complianceFrameworks: string[];
    policyCount: number;
    policies: Array<{ id: string; name: string; outcome: string }>;
  };
}

// ─── Implementation ─────────────────────────────────────────

export function generateAgentSBOM(input: AgentSBOMInput): AgentSBOM {
  const { agent, dependencies, governanceScore, governanceLevel, complianceFrameworks, policies } = input;

  return {
    bomFormat: "LuaAgentSBOM",
    specVersion: "1.0",
    serialNumber: `urn:uuid:${generateUUID()}`,
    generatedAt: new Date().toISOString(),
    component: {
      type: "agent",
      name: agent.name,
      version: agent.version ?? "0.0.0",
      description: agent.description ?? "",
      supplier: agent.owner ?? "unknown",
      properties: {
        "agent:id": agent.id,
        "agent:framework": agent.framework ?? "unknown",
      },
    },
    dependencies: {
      tools: dependencies?.tools ?? [],
      mcpServers: dependencies?.mcpServers ?? [],
      apiEndpoints: dependencies?.apiEndpoints ?? [],
      agents: dependencies?.agents ?? [],
    },
    governance: {
      score: governanceScore ?? 0,
      level: governanceLevel ?? 0,
      complianceFrameworks: complianceFrameworks ?? [],
      policyCount: policies?.length ?? 0,
      policies: policies ?? [],
    },
  };
}

// ─── Utilities ──────────────────────────────────────────────

function generateUUID(): string {
  if (typeof globalThis.crypto !== "undefined" && globalThis.crypto.randomUUID) {
    return globalThis.crypto.randomUUID();
  }
  // Fallback for environments without randomUUID
  const bytes = new Uint8Array(16);
  if (typeof globalThis.crypto !== "undefined" && globalThis.crypto.getRandomValues) {
    globalThis.crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x40; // version 4
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // variant 1
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
