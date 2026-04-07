/**
 * Zero-dependency ES module import lexer.
 *
 * Extracts structured import information from a TypeScript/JavaScript
 * source string. Handles the import forms that matter for scanning:
 *
 *   import Foo from "pkg"                       // default
 *   import * as Foo from "pkg"                  // namespace
 *   import { a, b as c } from "pkg"             // named
 *   import Foo, { a, b } from "pkg"             // default + named
 *   import Foo, * as NS from "pkg"              // default + namespace
 *   import "pkg"                                // side-effect
 *   export { a, b } from "pkg"                  // re-export (treated as import)
 *   export * from "pkg"                         // namespace re-export
 *
 * Bare dynamic imports (`import(...)`) and non-string specifiers are ignored
 * because tool imports in real code are always static strings.
 *
 * The lexer is line-tolerant: imports may span multiple lines. It skips
 * over block comments, line comments, and string literals so it doesn't
 * confuse a string like `"import Foo from"` inside code for an import.
 *
 * Limitations we accept as part of keeping this small:
 *   - We don't validate the JS grammar, just find import statements
 *   - Nested braces inside a type-only import clause work by luck — real
 *     TS syntax doesn't put braces inside import clauses so this is fine
 *   - Template literal specifiers (`import x from \`pkg\``) are intentionally
 *     ignored: tools are never imported via runtime template strings
 */

export type ImportKind = "default" | "namespace" | "named" | "side-effect";

export interface ParsedImport {
  /** The raw module specifier from the quoted string (e.g. "@lua-agents/crm/skills/dealSkill"). */
  specifier: string;
  /** Default import name if present (`import Foo from ...`). */
  defaultName?: string;
  /** Namespace import name if present (`import * as NS from ...`). */
  namespaceName?: string;
  /** Named imports with optional local aliases. */
  named: Array<{ imported: string; local: string }>;
  /** Convenience: the broad kind for quick filtering. */
  kind: ImportKind;
}

/**
 * Parse all import (and re-export-from) statements in a source string.
 * Malformed imports are skipped silently — a scanner that crashes on bad
 * code is worse than one that gives an incomplete answer.
 */
export function parseImports(source: string): ParsedImport[] {
  const cleaned = stripCommentsAndStrings(source);
  const results: ParsedImport[] = [];

  // Walk the source looking for `import` or `export` at statement-start
  // positions (beginning of file, or preceded by `;`, `{`, `}`, or newline).
  // For each hit, consume forward until the statement terminator: either
  // a `;` outside braces, or the end of input. This is more reliable than
  // regex backtracking on non-greedy quantifiers, which fail on long lines.
  let i = 0;
  const n = cleaned.length;
  while (i < n) {
    if (!isStatementStart(cleaned, i)) {
      i++;
      continue;
    }
    const keyword = matchKeyword(cleaned, i);
    if (!keyword) {
      i++;
      continue;
    }
    const stmtEnd = findStatementEnd(cleaned, i + keyword.length);
    const stmt = cleaned.slice(i, stmtEnd).trim();
    const parsed = parseStatement(stmt);
    if (parsed) results.push(parsed);
    i = stmtEnd + 1;
  }

  return results;
}

function isStatementStart(src: string, i: number): boolean {
  if (i === 0) return true;
  // Scan backward through whitespace; the previous non-whitespace char
  // must be a statement terminator or opener.
  let j = i - 1;
  while (j >= 0 && (src[j] === " " || src[j] === "\t")) j--;
  if (j < 0) return true;
  const c = src[j];
  return c === "\n" || c === ";" || c === "{" || c === "}";
}

function matchKeyword(src: string, i: number): string | null {
  // Must be `import` or `export` followed by whitespace or a quote
  if (src.startsWith("import", i)) {
    const next = src[i + "import".length];
    if (next === undefined || /\s|["']/.test(next)) return "import";
  }
  if (src.startsWith("export", i)) {
    const next = src[i + "export".length];
    if (next !== undefined && /\s/.test(next)) {
      // Only track the re-export-from form; skip declaration exports
      // like `export function foo()` or `export const x = ...` — they
      // don't contain an `import` specifier.
      const rest = src.slice(i + "export".length);
      if (/^\s*(?:\*|\{)/.test(rest)) return "export";
    }
  }
  return null;
}

function findStatementEnd(src: string, from: number): number {
  let depth = 0;
  for (let i = from; i < src.length; i++) {
    const c = src[i];
    if (c === "{") depth++;
    else if (c === "}") depth--;
    else if (c === ";" && depth === 0) return i;
    else if (c === "\n" && depth === 0) {
      // An import statement can span multiple lines only inside braces;
      // if we see a newline at depth 0 AND the previous significant char
      // suggests the statement is complete (`"` or `)` etc.), stop.
      // Otherwise keep going — multi-line `import\n  Foo\n  from "pkg"`
      // is legal.
      const prev = prevSignificant(src, i);
      if (prev === '"' || prev === "'") return i;
    }
  }
  return src.length;
}

function prevSignificant(src: string, i: number): string {
  let j = i - 1;
  while (j >= 0 && /\s/.test(src[j])) j--;
  return j >= 0 ? src[j] : "";
}

/** Find all tool-shaped imports in a file — convenience for callers. */
export function extractToolImports(source: string): ParsedImport[] {
  return parseImports(source).filter(isToolImport);
}

/**
 * Heuristic: does this import look like it brings in an agent tool/skill?
 *
 * Three signals:
 *   1. The specifier path contains `/tools/` or `/skills/` (common layout)
 *   2. The specifier ends with `Skill`, `Tool`, `skill`, `tool` after the
 *      last slash (e.g. `.../skills/dealSkill`)
 *   3. One of the imported names matches `*Skill` or `*Tool` (but not in
 *      the denylist of common false positives like `Toolbar`, `Tooltip`)
 *
 * Returning true doesn't mean every imported name is a tool — callers
 * should use `toolNamesFromImport` to pick out just the tool-shaped names.
 */
export function isToolImport(imp: ParsedImport): boolean {
  const spec = imp.specifier;
  if (/\/(skills|tools)(\/|$)/.test(spec)) return true;

  const lastSegment = spec.split("/").pop() ?? "";
  if (/(?:Skill|Tool)s?$/.test(lastSegment)) return true;

  const names = collectNames(imp);
  return names.some(isToolName);
}

/** Extract the tool-shaped names from a parsed import. */
export function toolNamesFromImport(imp: ParsedImport): string[] {
  const names = collectNames(imp);
  const shaped = names.filter(isToolName);
  if (shaped.length > 0) return shaped;
  // For path-based matches (e.g. `.../skills/dealSkill`), fall back to
  // the specifier tail when no imported name is itself tool-shaped. This
  // covers both bare side-effect imports and cases where the user
  // imported with a generic local name.
  if (/\/(skills|tools)(\/|$)/.test(imp.specifier)) {
    const last = imp.specifier.split("/").pop() ?? "";
    const bare = stripExtension(last);
    if (bare) return [bare];
  }
  return [];
}

// ── Internals ──────────────────────────────────────────────────

const TOOL_NAME_DENY = new Set([
  "Toolbar",
  "ToolBar",
  "Tooltip",
  "ToolTip",
  "ToolStrip",
  "Toolkit",
  "ToolKit",
]);

function isToolName(name: string): boolean {
  if (name.length < 3 || name.length > 64) return false;
  if (TOOL_NAME_DENY.has(name)) return false;
  return /(?:Skill|Tool)s?$/.test(name);
}

function collectNames(imp: ParsedImport): string[] {
  const out: string[] = [];
  if (imp.defaultName) out.push(imp.defaultName);
  if (imp.namespaceName) out.push(imp.namespaceName);
  for (const n of imp.named) out.push(n.imported);
  return out;
}

function stripExtension(name: string): string {
  return name.replace(/\.(ts|tsx|js|jsx|mjs|cjs)$/, "");
}

/**
 * Replace string literals and comments with equal-length whitespace so that
 * positions in the cleaned source still match the original. Keeps newlines
 * intact so the statement matcher's anchors still work. We only need to
 * neutralize content that could contain fake `import` tokens.
 */
function stripCommentsAndStrings(source: string): string {
  const out: string[] = [];
  let i = 0;
  const n = source.length;

  while (i < n) {
    const c = source[i];
    const c2 = source[i + 1] ?? "";

    // Line comment
    if (c === "/" && c2 === "/") {
      out.push("//");
      i += 2;
      while (i < n && source[i] !== "\n") {
        out.push(" ");
        i++;
      }
      continue;
    }
    // Block comment
    if (c === "/" && c2 === "*") {
      out.push("/*");
      i += 2;
      while (i < n && !(source[i] === "*" && source[i + 1] === "/")) {
        out.push(source[i] === "\n" ? "\n" : " ");
        i++;
      }
      if (i < n) {
        out.push("*/");
        i += 2;
      }
      continue;
    }
    // Template literal (could span lines; flatten contents)
    if (c === "`") {
      out.push("`");
      i++;
      while (i < n && source[i] !== "`") {
        // Skip escaped chars
        if (source[i] === "\\" && i + 1 < n) {
          out.push("  ");
          i += 2;
          continue;
        }
        out.push(source[i] === "\n" ? "\n" : " ");
        i++;
      }
      if (i < n) {
        out.push("`");
        i++;
      }
      continue;
    }
    // Quoted strings — keep them only if they look like they could be
    // an import specifier (i.e., they come right after `from` or an
    // `import` keyword). Easiest: keep string contents verbatim; the
    // statement regex only matches `from "..."` anyway and won't get
    // confused because we already consumed comments.
    if (c === '"' || c === "'") {
      const quote = c;
      out.push(quote);
      i++;
      while (i < n && source[i] !== quote) {
        if (source[i] === "\\" && i + 1 < n) {
          out.push(source[i], source[i + 1]);
          i += 2;
          continue;
        }
        if (source[i] === "\n") break; // unterminated — bail
        out.push(source[i]);
        i++;
      }
      if (i < n && source[i] === quote) {
        out.push(quote);
        i++;
      }
      continue;
    }

    out.push(c);
    i++;
  }

  return out.join("");
}

function parseStatement(stmt: string): ParsedImport | null {
  // Normalize whitespace so the sub-patterns don't need \s* in too many places
  const s = stmt.replace(/\s+/g, " ").trim();

  // Re-export forms: `export { a, b } from "pkg"` or `export * from "pkg"`
  const reexportNamed = /^export\s+\{([^}]*)\}\s+from\s+["']([^"']+)["']/.exec(s);
  if (reexportNamed) {
    return {
      specifier: reexportNamed[2],
      named: parseNamedClause(reexportNamed[1]),
      kind: "named",
    };
  }
  const reexportStar = /^export\s+\*\s+(?:as\s+(\w+)\s+)?from\s+["']([^"']+)["']/.exec(s);
  if (reexportStar) {
    return {
      specifier: reexportStar[2],
      namespaceName: reexportStar[1],
      named: [],
      kind: "namespace",
    };
  }

  // Import forms
  if (!s.startsWith("import")) return null;

  // Side-effect: `import "pkg"`
  const sideEffect = /^import\s+["']([^"']+)["']/.exec(s);
  if (sideEffect) {
    return {
      specifier: sideEffect[1],
      named: [],
      kind: "side-effect",
    };
  }

  // Capture the clause between `import` and `from "..."`
  const fromMatch = /from\s+["']([^"']+)["']/.exec(s);
  if (!fromMatch) return null;
  const specifier = fromMatch[1];
  const clause = s
    .slice("import".length, fromMatch.index)
    .replace(/^\s*type\s+/, " ") // drop leading `type ` (type-only import)
    .trim();

  let defaultName: string | undefined;
  let namespaceName: string | undefined;
  let named: Array<{ imported: string; local: string }> = [];

  // Split on `, ` outside of braces. We only have two possible segments:
  //   default   + (namespace | named)
  // So a single comma split is safe *if* the braces come second.
  const parts = splitTopLevel(clause);
  for (const part of parts) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith("*")) {
      const nsMatch = /^\*\s+as\s+(\w+)$/.exec(trimmed);
      if (nsMatch) namespaceName = nsMatch[1];
      continue;
    }
    if (trimmed.startsWith("{")) {
      const inner = trimmed.slice(1, trimmed.lastIndexOf("}")).trim();
      named = parseNamedClause(inner);
      continue;
    }
    // Drop leading `type ` for type-only imports — we treat them the same
    const stripped = trimmed.replace(/^type\s+/, "");
    if (/^\w+$/.test(stripped)) defaultName = stripped;
  }

  const kind: ImportKind = defaultName
    ? "default"
    : namespaceName
      ? "namespace"
      : named.length > 0
        ? "named"
        : "side-effect";

  return { specifier, defaultName, namespaceName, named, kind };
}

/** Split an import clause on commas that are not inside `{}`. */
function splitTopLevel(clause: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < clause.length; i++) {
    const c = clause[i];
    if (c === "{") depth++;
    else if (c === "}") depth--;
    else if (c === "," && depth === 0) {
      out.push(clause.slice(start, i));
      start = i + 1;
    }
  }
  out.push(clause.slice(start));
  return out;
}

function parseNamedClause(inner: string): Array<{ imported: string; local: string }> {
  const out: Array<{ imported: string; local: string }> = [];
  for (const raw of inner.split(",")) {
    const part = raw.trim().replace(/^type\s+/, "");
    if (!part) continue;
    const aliasMatch = /^(\w+)\s+as\s+(\w+)$/.exec(part);
    if (aliasMatch) {
      out.push({ imported: aliasMatch[1], local: aliasMatch[2] });
      continue;
    }
    if (/^\w+$/.test(part)) {
      out.push({ imported: part, local: part });
    }
  }
  return out;
}
