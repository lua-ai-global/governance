/**
 * @lua-ai-global/governance — YAML Policy Serialization
 *
 * Serialize and deserialize PolicyRule[] to/from YAML format.
 * Zero dependencies — handwritten YAML emitter and parser.
 *
 * @example
 * ```ts
 * import { toYAML, fromYAML } from '@lua-ai-global/governance/policy-yaml';
 *
 * const yaml = toYAML(governance.policies.getRules());
 * // Save to file, commit to git, review in PR
 *
 * const rules = fromYAML(yamlString);
 * const gov = createGovernance({ rules });
 * ```
 */

import type { PolicyRule, PolicyStage, PolicyOutcome } from "./policy.js";

// ─── YAML Emitter ───────────────────────────────────────────

/** Serialize PolicyRule[] to a human-readable YAML string */
export function toYAML(rules: PolicyRule[]): string {
  const lines: string[] = ["rules:"];
  for (const rule of rules) {
    lines.push(`  - id: ${quote(rule.id)}`);
    lines.push(`    name: ${quote(rule.name)}`);
    lines.push(`    outcome: ${rule.outcome}`);
    lines.push(`    reason: ${quote(rule.reason)}`);
    lines.push(`    priority: ${rule.priority}`);
    lines.push(`    enabled: ${rule.enabled}`);
    if (rule.stage) lines.push(`    stage: ${rule.stage}`);
    lines.push(`    condition:`);
    lines.push(`      type: ${quote(rule.condition.type)}`);
    if (Object.keys(rule.condition.params).length > 0) {
      lines.push(`      params:`);
      emitParams(lines, rule.condition.params, 8);
    }
    lines.push("");
  }
  return lines.join("\n");
}

function emitParams(lines: string[], obj: Record<string, unknown>, indent: number): void {
  const pad = " ".repeat(indent);
  for (const [key, val] of Object.entries(obj)) {
    if (Array.isArray(val)) {
      lines.push(`${pad}${key}:`);
      for (const item of val) {
        if (typeof item === "object" && item !== null) {
          lines.push(`${pad}  -`);
          emitParams(lines, item as Record<string, unknown>, indent + 4);
        } else {
          lines.push(`${pad}  - ${formatValue(item)}`);
        }
      }
    } else if (typeof val === "object" && val !== null) {
      lines.push(`${pad}${key}:`);
      emitParams(lines, val as Record<string, unknown>, indent + 2);
    } else {
      lines.push(`${pad}${key}: ${formatValue(val)}`);
    }
  }
}

function formatValue(val: unknown): string {
  if (typeof val === "string") return quote(val);
  if (typeof val === "boolean" || typeof val === "number") return String(val);
  return String(val);
}

function quote(s: string): string {
  if (/[:#{}[\],&*?|>!%@`"'\n]/.test(s) || s === "" || s !== s.trim()) {
    return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  }
  return s;
}

// ─── YAML Parser ────────────────────────────────────────────

/** Deserialize a YAML string back to PolicyRule[] */
export function fromYAML(yaml: string): PolicyRule[] {
  const parsed = parseSimpleYAML(yaml);
  if (!parsed || !Array.isArray(parsed.rules)) {
    throw new Error("Invalid YAML: expected top-level 'rules' array");
  }

  return (parsed.rules as Record<string, unknown>[]).map((raw): PolicyRule => {
    if (!raw.id || !raw.condition) throw new Error(`Invalid rule: missing id or condition`);

    const condition = raw.condition as Record<string, unknown>;
    return {
      id: String(raw.id),
      name: String(raw.name ?? ""),
      condition: {
        type: String(condition.type ?? ""),
        params: (condition.params ?? {}) as Record<string, unknown>,
      },
      outcome: String(raw.outcome ?? "block") as PolicyOutcome,
      reason: String(raw.reason ?? ""),
      priority: Number(raw.priority ?? 50),
      enabled: raw.enabled !== false,
      stage: raw.stage ? (String(raw.stage) as PolicyStage) : undefined,
    };
  });
}

// ─── Minimal YAML Parser ───────────────────────────────────

function parseSimpleYAML(yaml: string): Record<string, unknown> {
  const lines = yaml.split("\n");
  return parseObject(lines, 0, 0).value as Record<string, unknown>;
}

function parseObject(lines: string[], start: number, minIndent: number): { value: Record<string, unknown>; end: number } {
  const obj: Record<string, unknown> = {};
  let i = start;

  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === "" || line.trim().startsWith("#")) { i++; continue; }

    const lineIndent = line.search(/\S/);
    if (lineIndent < minIndent) break;

    const match = line.match(/^(\s*)([^:\s]+)\s*:\s*(.*)/);
    if (!match) { i++; continue; }

    const [, , key, rest] = match;
    const valueIndent = lineIndent + 2;

    if (rest.trim() === "") {
      // Check if next non-empty line starts with "- " (array) or is a nested object
      const nextLine = findNextNonEmpty(lines, i + 1);
      if (nextLine && nextLine.trimmed.startsWith("- ")) {
        const arr = parseArray(lines, i + 1, valueIndent);
        obj[key] = arr.value;
        i = arr.end;
      } else {
        const nested = parseObject(lines, i + 1, valueIndent);
        obj[key] = nested.value;
        i = nested.end;
      }
    } else {
      obj[key] = parseScalar(rest.trim());
      i++;
    }
  }

  return { value: obj, end: i };
}

function parseArray(lines: string[], start: number, minIndent: number): { value: unknown[]; end: number } {
  const arr: unknown[] = [];
  let i = start;

  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === "" || line.trim().startsWith("#")) { i++; continue; }

    const lineIndent = line.search(/\S/);
    if (lineIndent < minIndent) break;

    const trimmed = line.trim();
    if (trimmed.startsWith("- ")) {
      const value = trimmed.slice(2).trim();
      if (value === "" || value.includes(":")) {
        // Complex array item — parse as object
        const nested = parseObject(lines, i + 1, lineIndent + 2);
        if (value.includes(":")) {
          const [k, v] = value.split(/:\s*(.*)/, 2);
          const obj = { [k]: parseScalar(v ?? "") };
          Object.assign(obj, nested.value);
          arr.push(obj);
        } else {
          arr.push(nested.value);
        }
        i = nested.end;
      } else {
        arr.push(parseScalar(value));
        i++;
      }
    } else if (trimmed === "-") {
      const nested = parseObject(lines, i + 1, lineIndent + 2);
      arr.push(nested.value);
      i = nested.end;
    } else {
      break;
    }
  }

  return { value: arr, end: i };
}

function parseScalar(s: string): string | number | boolean {
  if (s === "true") return true;
  if (s === "false") return false;
  if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
  // Strip quotes
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
  }
  return s;
}

function findNextNonEmpty(lines: string[], start: number): { trimmed: string; indent: number } | null {
  for (let i = start; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (trimmed !== "" && !trimmed.startsWith("#")) {
      return { trimmed, indent: lines[i].search(/\S/) };
    }
  }
  return null;
}
