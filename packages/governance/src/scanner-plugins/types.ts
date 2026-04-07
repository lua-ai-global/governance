/**
 * Scanner plugin types.
 *
 * Scanner plugins are framework-specific extensions to the generic repo
 * scanner. The core scanner handles language-agnostic concerns (import
 * parsing, capability detection) and delegates framework-specific work
 * (what counts as a "tool", how to expand a "skill container" into its
 * child tools) to plugins.
 *
 * A plugin is pure data + pure functions. Any I/O (fetching remote files
 * to expand a skill) is done by the caller via a `FileResolver` callback,
 * keeping the SDK zero-I/O.
 *
 * @example
 * ```ts
 * import { scanRepoContents } from "governance-sdk";
 * import { luaScannerPlugin } from "governance-sdk/scanner-plugins/lua";
 *
 * const result = await scanRepoContents(fileContents, {
 *   plugins: [luaScannerPlugin],
 *   resolveFile: async (specifier) => {
 *     // caller fetches source for `@lua-agents/crm/skills/dealSkill`
 *     // from GitHub / disk / wherever and returns the source string.
 *     return fetchFromGithub(specifier);
 *   },
 * });
 * ```
 */

/**
 * Parsed representation of an ES module import.
 * Mirrors the shape produced by the SDK's internal import-lexer.
 */
export interface ScannerImport {
  specifier: string;
  defaultName?: string;
  namespaceName?: string;
  named: Array<{ imported: string; local: string }>;
  kind: "default" | "namespace" | "named" | "side-effect";
}

/**
 * Resolved source payload returned by a `FileResolver`.
 *
 * `path` is an opaque-to-the-SDK identifier for where the source was
 * loaded from. Plugins pass it back to the resolver as `fromPath` when
 * recursing into relative imports so the caller can interpret them.
 */
export interface ResolvedSource {
  path: string;
  content: string;
}

/**
 * Caller-provided async file resolver. Given a module specifier (e.g.
 * "@lua-agents/crm/skills/dealSkill" or "./tools/deal/createDealTool")
 * and an optional `fromPath` for relative resolution, return the source
 * code for the target or `null` if it can't be resolved.
 *
 * The resolver is free to fetch from anywhere — a local filesystem, a
 * GitHub API, an in-memory cache. The SDK never touches I/O directly.
 *
 * When called for a bare package specifier (e.g. `@lua-agents/crm/...`),
 * `fromPath` is undefined. When called for a relative specifier during
 * plugin recursion, `fromPath` is the path of the parent file whose
 * import triggered the lookup.
 */
export type FileResolver = (
  specifier: string,
  fromPath?: string,
) => Promise<ResolvedSource | null>;

/**
 * A scanner plugin tells the core scanner how to recognize and expand
 * framework-specific tool containers into their constituent tools.
 *
 * Each plugin implements two concerns:
 *
 *   1. **Ownership** — `ownsImport` returns true if this plugin knows
 *      how to handle a given import specifier. E.g. the Lua plugin
 *      claims imports from `@lua-agents/*`.
 *
 *   2. **Expansion** — `expandTools` takes a resolved source string and
 *      returns the concrete tool names it defines. For Lua this means
 *      finding `implements LuaTool { name = "..." }` classes inside a
 *      skill file and returning their names.
 *
 * A plugin may *also* expose a `detectFramework` function that inspects
 * scanned file contents to decide whether the current repo belongs to
 * this framework. This lets the core scanner pick the right plugin
 * automatically when multiple are registered.
 */
export interface ExpandToolsContext {
  /** Path of the resolved file whose source is being expanded. Used as
   *  `fromPath` when recursing into relative imports. */
  fromPath: string;
  /** The caller-provided resolver, so plugins can walk imports. */
  resolve: FileResolver;
  /** Shared set of already-resolved paths for cycle detection. */
  visited: Set<string>;
  /** Remaining budget for how many more files this expansion may read. */
  remainingBudget: { value: number };
}

export interface ScannerPlugin {
  /** Canonical framework name, e.g. "lua", "mastra". */
  name: string;

  /**
   * Return true if this plugin can expand the given import specifier
   * into its child tools. If false, the scanner will skip this import
   * for this plugin.
   */
  ownsImport(imp: ScannerImport): boolean;

  /**
   * Given the source of a resolved import, return the tool names it
   * defines (and optionally, any it recursively discovers via the
   * provided context). Plugins may use `ctx.resolve` to walk relative
   * imports inside skill containers so they can find tool files that
   * live beside the skill.
   *
   * Implementations must respect `ctx.visited` to avoid cycles and
   * `ctx.remainingBudget` to avoid runaway recursion.
   */
  expandTools(source: string, ctx: ExpandToolsContext): Promise<string[]>;

  /**
   * Optional: inspect the scanned files and decide whether this plugin
   * is applicable. When multiple plugins are registered, the first one
   * that returns true wins. When omitted, the plugin is always applied.
   */
  detectFramework?(fileContents: Map<string, string>): boolean;

  /**
   * Optional: extract framework-specific metadata from the scanned
   * files. Used to surface canonical identifiers, config values, or
   * any other structured data the framework's manifest carries that
   * the generic scanner can't see.
   *
   * The most important field by convention is `externalId` — when set,
   * callers (e.g. governance-web's connect-repo route) use it as the
   * agent's canonical id at registration time so the dashboard record
   * matches whatever id the runtime will pass to `enforce()`. For Lua
   * this is `agent.agentId` from `lua.skill.yaml`.
   *
   * Plugins may also surface other framework-known fields here. The
   * scanner doesn't interpret them — it just merges into the result.
   */
  extractMetadata?(
    fileContents: Map<string, string>,
  ): Promise<Record<string, unknown> | null> | Record<string, unknown> | null;
}
