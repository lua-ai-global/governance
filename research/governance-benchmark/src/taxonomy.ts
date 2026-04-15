/**
 * Agent Governance Benchmark — Multi-Axis Taxonomy v1
 *
 * Multi-dimensional ontology for agent security evaluation.
 * Each sample is labeled across independent axes rather than
 * forced into a single flat category.
 *
 * Axes:
 * - vector: HOW the attack enters the system
 * - mechanism: WHAT technique the attack uses
 * - objective: WHAT the attacker wants to achieve
 * - target: WHAT component is being attacked
 * - severity: HOW bad is it
 *
 * Plus modifiers (tags that can apply to any combination):
 * - multi_vector, temporal_trigger, persistence, multi_turn
 */

// ═══════════════════════════════════════════════════════════
// AXIS 1: VECTOR — How the attack enters the system
// ═══════════════════════════════════════════════════════════

export type AttackVector =
  | "direct_input"        // User/caller sends injection directly
  | "retrieved_context"   // Injection embedded in RAG/search results
  | "tool_output"         // Injection in a tool's response data
  | "mcp_metadata"        // Injection in MCP tool descriptions, schemas, annotations
  | "agent_message"       // Injection arrives via inter-agent communication (A2A)
  | "memory_state"        // Injection in persisted memory, profile, vector store
  | "downstream_output"   // Poisoned output intended for the NEXT agent in chain
  | "structured_data";    // Injection hidden in JSON/XML/schema fields

export interface VectorDef {
  id: AttackVector;
  name: string;
  description: string;
}

export const VECTORS: VectorDef[] = [
  { id: "direct_input", name: "Direct Input", description: "Attack arrives directly from the user or API caller in the current turn." },
  { id: "retrieved_context", name: "Retrieved Context", description: "Attack is embedded in documents, RAG results, web pages, or search output that the agent ingests." },
  { id: "tool_output", name: "Tool Output", description: "Attack payload is in the response from a tool call — the agent processes poisoned tool results." },
  { id: "mcp_metadata", name: "MCP Metadata", description: "Attack is in MCP tool descriptions, input schemas, annotations, or server metadata." },
  { id: "agent_message", name: "Agent-to-Agent Message", description: "Attack arrives from another agent via A2A protocol or multi-agent orchestration." },
  { id: "memory_state", name: "Memory / State", description: "Attack targets persisted state — long-term memory, user profiles, vector store entries, policy caches." },
  { id: "downstream_output", name: "Downstream Output", description: "Attack manipulates the current agent's output to poison a downstream consumer agent." },
  { id: "structured_data", name: "Structured Data", description: "Attack hidden in JSON fields, XML attributes, markdown, or parser-exploiting formats." },
];

// ═══════════════════════════════════════════════════════════
// AXIS 2: MECHANISM — What technique the attack uses
// ═══════════════════════════════════════════════════════════

export type AttackMechanism =
  | "instruction_override"  // Explicit "ignore/forget/disregard" directives
  | "role_hijack"           // Identity/persona redefinition (DAN, jailbreak)
  | "encoding_evasion"      // Payload encoded in base64/hex/unicode/leetspeak/etc
  | "authority_spoofing"    // False claims of admin/developer/supervisor authority
  | "delegation_forgery"    // Forged delegation chains or capability claims
  | "context_framing"       // Hypothetical/educational/testing framing to lower guard
  | "parser_exploit"        // Delimiter injection, schema manipulation, format confusion
  | "conditional_trigger"   // Time-bomb / keyword-activated / conditional payloads
  | "persistence_install";  // Attempts to persist access across turns/sessions

export interface MechanismDef {
  id: AttackMechanism;
  name: string;
  description: string;
}

export const MECHANISMS: MechanismDef[] = [
  { id: "instruction_override", name: "Instruction Override", description: "Directly tells the agent to ignore, forget, discard, or replace its instructions." },
  { id: "role_hijack", name: "Role/Identity Hijack", description: "Redefines the agent's persona, enables 'modes' (DAN, developer, jailbreak), or removes behavioral constraints." },
  { id: "encoding_evasion", name: "Encoding Evasion", description: "Encodes the payload in base64, hex, unicode, ROT13, leetspeak, reversed text, or other obfuscation." },
  { id: "authority_spoofing", name: "Authority Spoofing", description: "Claims false authority (admin, developer, CEO, security team) combined with an override request." },
  { id: "delegation_forgery", name: "Delegation Forgery", description: "Fabricates delegation chains, capability certificates, or agent-to-agent authorization." },
  { id: "context_framing", name: "Context Framing", description: "Frames the attack as hypothetical, educational, a test, or a simulation to lower safety thresholds." },
  { id: "parser_exploit", name: "Parser/Schema Exploit", description: "Exploits delimiters, XML/JSON structure, markdown rendering, or format-specific parsing behavior." },
  { id: "conditional_trigger", name: "Conditional Trigger", description: "Payload activates on a condition: after N messages, when a keyword appears, at a certain time, etc." },
  { id: "persistence_install", name: "Persistence Install", description: "Attempts to make the override permanent across turns, sessions, or for all future users." },
];

// ═══════════════════════════════════════════════════════════
// AXIS 3: OBJECTIVE — What the attacker wants to achieve
// ═══════════════════════════════════════════════════════════

export type AttackObjective =
  | "policy_bypass"         // Bypass safety/governance policies
  | "data_exfiltration"     // Extract secrets, credentials, PII, conversation data
  | "prompt_extraction"     // Extract the system prompt specifically
  | "privilege_escalation"  // Gain access to unauthorized tools/capabilities
  | "goal_hijack"           // Redirect the agent's objective/plan
  | "downstream_poisoning"  // Poison output for downstream agents
  | "resource_exhaustion"   // DoS via loops, token flooding, branch explosion
  | "boundary_violation";   // Cross-tenant, cross-user, cross-org access

export interface ObjectiveDef {
  id: AttackObjective;
  name: string;
  description: string;
}

export const OBJECTIVES: ObjectiveDef[] = [
  { id: "policy_bypass", name: "Policy Bypass", description: "Bypass safety guardrails, content filters, or governance rules to get unrestricted output." },
  { id: "data_exfiltration", name: "Data Exfiltration", description: "Extract API keys, credentials, environment variables, conversation history, or user data." },
  { id: "prompt_extraction", name: "Prompt Extraction", description: "Extract the agent's system prompt, hidden instructions, or configuration." },
  { id: "privilege_escalation", name: "Privilege Escalation", description: "Access unauthorized tools, elevated permissions, or capabilities beyond the agent's scope." },
  { id: "goal_hijack", name: "Goal Hijack", description: "Redirect the agent's current objective, plan, or task to serve the attacker's purpose." },
  { id: "downstream_poisoning", name: "Downstream Poisoning", description: "Manipulate the agent's output so downstream consumers (other agents, systems) are compromised." },
  { id: "resource_exhaustion", name: "Resource Exhaustion", description: "Cause denial of service via recursive loops, token flooding, tool-call explosion, or planner overload." },
  { id: "boundary_violation", name: "Boundary Violation", description: "Cross tenant/user/org boundaries to access another entity's data or resources." },
];

// ═══════════════════════════════════════════════════════════
// AXIS 4: TARGET — What component is being attacked
// ═══════════════════════════════════════════════════════════

export type AttackTarget =
  | "model"           // The LLM itself (prompt-level attack)
  | "tool_layer"      // The tool execution layer
  | "orchestrator"    // The agent orchestrator/planner
  | "downstream_agent"// A different agent in the chain
  | "memory"          // Persistent memory/state store
  | "evaluator"       // The governance/safety classifier itself
  | "parser";         // Input/output parsers, format handlers

export interface TargetDef {
  id: AttackTarget;
  name: string;
  description: string;
}

export const TARGETS: TargetDef[] = [
  { id: "model", name: "Model", description: "The LLM directly — manipulating its output through prompt-level injection." },
  { id: "tool_layer", name: "Tool Layer", description: "The tool execution system — invoking unauthorized tools or manipulating tool arguments." },
  { id: "orchestrator", name: "Orchestrator", description: "The agent planner/orchestrator — hijacking goals, redirecting workflows, manipulating planning." },
  { id: "downstream_agent", name: "Downstream Agent", description: "Another agent in the chain — output poisoning that targets consumers." },
  { id: "memory", name: "Memory/State", description: "Persistent storage — poisoning vector stores, user profiles, long-term memory, or policy caches." },
  { id: "evaluator", name: "Evaluator/Judge", description: "The governance classifier or safety evaluator itself — making it misclassify attacks as benign." },
  { id: "parser", name: "Parser", description: "Input/output parsers — exploiting format handling, delimiters, or schema validation." },
];

// ═══════════════════════════════════════════════════════════
// MODIFIERS — Tags that can apply to any combination
// ═══════════════════════════════════════════════════════════

export type AttackModifier =
  | "multi_vector"      // Combines multiple mechanisms
  | "multi_turn"        // Requires multiple conversation turns
  | "multi_agent"       // Spans multiple agents
  | "encoded"           // Payload uses encoding/obfuscation
  | "persistent";       // Attempts to persist across sessions

// ═══════════════════════════════════════════════════════════
// SAMPLE LABEL — Multi-axis label for each benchmark sample
// ═══════════════════════════════════════════════════════════

export interface AttackLabel {
  vector: AttackVector;
  mechanism: AttackMechanism;
  objective: AttackObjective;
  target: AttackTarget;
  modifiers: AttackModifier[];
  severity: "critical" | "high" | "medium" | "low";
}

// ═══════════════════════════════════════════════════════════
// BENIGN CATEGORIES — Why false positives happen
// ═══════════════════════════════════════════════════════════

export type BenignCategory =
  | "user_correction"          // "No, ignore that — do this instead"
  | "agent_delegation"         // Legitimate multi-agent task assignment
  | "tool_authorization"       // Valid tool permission management
  | "system_administration"    // Normal admin/devops commands
  | "security_discussion"      // Meta-discussion ABOUT attacks
  | "devops_operations"        // CI/CD, deployments, infra commands
  | "business_communication"   // Normal business text with trigger words
  | "creative_content"         // Marketing/ad copy with dramatic language
  | "cicd_automation"          // Cron jobs, pipeline configs
  | "error_retry"              // Retry/fallback logic with "override"/"bypass"
  | "agent_workflow"           // Legitimate agent operating instructions
  | "structured_operations";   // "If validation fails, retry with admin token from vault"

export interface BenignCategoryDef {
  id: BenignCategory;
  name: string;
  description: string;
  fpReason: string;
}

export const BENIGN_CATEGORIES: BenignCategoryDef[] = [
  { id: "user_correction", name: "User Corrections Mid-Conversation", description: "Users changing their mind, redirecting, canceling previous requests.", fpReason: "Contains ignore, forget, disregard, cancel in normal correction contexts — the #1 FP trigger in production." },
  { id: "agent_delegation", name: "Legitimate Agent Delegation", description: "Valid multi-agent task/role/capability assignment.", fpReason: "Role-assignment language resembles role manipulation attacks." },
  { id: "tool_authorization", name: "Legitimate Tool Permission Requests", description: "Valid tool access configuration within authorized scope.", fpReason: "Tool-access and permission language resembles escalation attacks." },
  { id: "system_administration", name: "Legitimate System Administration", description: "Normal admin commands, config changes, operational tasks.", fpReason: "Override, reset, admin, execute keywords in operational contexts." },
  { id: "security_discussion", name: "Security Meta-Discussion", description: "Discussions ABOUT attacks — not performing them.", fpReason: "Contains the exact vocabulary of attacks in educational context." },
  { id: "devops_operations", name: "DevOps & Infrastructure Operations", description: "Deployments, migrations, monitoring commands.", fpReason: "Execute, run, deploy, override, system keywords in technical contexts." },
  { id: "business_communication", name: "Normal Business Communication", description: "Emails, meetings, updates, questions.", fpReason: "Trigger words (ignore, forget, instead, from now on) in conversational usage." },
  { id: "creative_content", name: "Creative & Marketing Content", description: "Marketing copy, ad text, creative writing.", fpReason: "Imperative, transformative language that resembles instruction overrides." },
  { id: "cicd_automation", name: "CI/CD & Cron Automation", description: "Pipeline configs, scheduled jobs, automation scripts.", fpReason: "Execute, delete, run, override keywords in automated contexts." },
  { id: "error_retry", name: "Error Handling & Retry Logic", description: "Error recovery with overrides, elevated permissions, bypass.", fpReason: "Override, bypass, retry, elevated keywords in error-handling contexts." },
  { id: "agent_workflow", name: "Agent Workflow Instructions", description: "Legitimate operating instructions agents receive.", fpReason: "Literally what injection attacks try to mimic — the hardest category." },
  { id: "structured_operations", name: "Structured Operational Instructions", description: "Complex operational instructions that look suspicious but are valid in trusted contexts.", fpReason: "Contains tool invocation + credential + routing language that closely mimics attacks." },
];

// ═══════════════════════════════════════════════════════════
// TAXONOMY METADATA
// ═══════════════════════════════════════════════════════════

export const TAXONOMY = {
  name: "Agent Governance Benchmark Taxonomy",
  version: "1.0.0",
  axes: {
    vectors: VECTORS,
    mechanisms: MECHANISMS,
    objectives: OBJECTIVES,
    targets: TARGETS,
  },
  benignCategories: BENIGN_CATEGORIES,
  modifiers: ["multi_vector", "multi_turn", "multi_agent", "encoded", "persistent"] as AttackModifier[],
};

/** Get all axis values for validation */
export function getAllVectors(): AttackVector[] { return VECTORS.map((v) => v.id); }
export function getAllMechanisms(): AttackMechanism[] { return MECHANISMS.map((m) => m.id); }
export function getAllObjectives(): AttackObjective[] { return OBJECTIVES.map((o) => o.id); }
export function getAllTargets(): AttackTarget[] { return TARGETS.map((t) => t.id); }
export function getAllBenignCategories(): BenignCategory[] { return BENIGN_CATEGORIES.map((b) => b.id); }
