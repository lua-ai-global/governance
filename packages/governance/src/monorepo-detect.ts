/**
 * Monorepo agent detection — finds agent packages in a monorepo.
 *
 * Given a list of file paths and a way to read package.json files,
 * detects which directories contain agent framework dependencies.
 *
 * Pure logic. No I/O — caller provides file contents.
 */

/** Detected agent root in a monorepo */
export interface AgentRoot {
  /** Relative path to the package directory (e.g. "packages/sales-bot") */
  path: string;
  /** Package name from package.json */
  name: string;
  /** Detected framework from dependencies */
  framework: string | null;
  /** Key dependencies that indicate this is an agent */
  agentDeps: string[];
}

/** Dependencies that indicate a package is an AI agent */
const AGENT_DEP_PATTERNS: Array<{ pattern: RegExp; framework: string }> = [
  { pattern: /^lua-cli$/, framework: "lua" },
  { pattern: /^@mastra\/core$/, framework: "mastra" },
  { pattern: /^langchain$|^@langchain\//, framework: "langchain" },
  { pattern: /^crewai$/, framework: "crewai" },
  { pattern: /^autogen$/, framework: "autogen" },
  { pattern: /^@vercel\/ai$|^ai$/, framework: "vercel-ai" },
  { pattern: /^@modelcontextprotocol\//, framework: "mcp" },
  { pattern: /^@aws-sdk\/client-bedrock/, framework: "bedrock" },
  { pattern: /^@genkit-ai\//, framework: "genkit" },
  { pattern: /^@anthropic-ai\/sdk$/, framework: "anthropic" },
  { pattern: /^openai$/, framework: "openai" },
];

/**
 * Secondary deps that confirm an agent (not framework-specific).
 *
 * These should be deps that ONLY appear in actual agents — not generic
 * libraries. zod was previously here but it's in every TypeScript
 * project, so it produced false positives for any package that ships
 * with schema validation.
 */
const AGENT_SIGNAL_DEPS = [
  "governance-sdk",
  "@langchain/openai",
  "@langchain/anthropic",
  "llamaindex",
];

/**
 * Find all package.json paths in a file listing.
 * Excludes node_modules, .next, dist, etc.
 */
export function findPackageJsonPaths(allFiles: string[]): string[] {
  return allFiles.filter((f) => {
    if (!f.endsWith("package.json")) return false;
    if (/node_modules|\.next|dist\/|\.turbo|\.cache/.test(f)) return false;
    return true;
  });
}

/**
 * Detect agent roots from package.json contents.
 * Call this with a map of package.json path → content.
 *
 * A package is only counted as an agent root when its framework
 * dependency (e.g. `lua-cli`, `@mastra/core`) appears in `dependencies`
 * — not in `peerDependencies` or `devDependencies` alone. Support
 * libraries that *plug into* a framework (skill packages, tool kits,
 * shared utilities) declare the framework as a peer dep so they don't
 * pin a specific version, while actual agents ship with it as a runtime
 * dep. This single distinction filters out the "we found 18 agents in
 * a monorepo that really only has 7" class of false positives.
 */
export function detectAgentRoots(
  packageJsonContents: Map<string, string>,
): AgentRoot[] {
  const roots: AgentRoot[] = [];

  for (const [pkgPath, content] of packageJsonContents) {
    try {
      const pkg = JSON.parse(content) as {
        name?: string;
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
        peerDependencies?: Record<string, string>;
      };

      // Only runtime `dependencies` are considered for the agent
      // signal. peer/dev deps indicate a library, not an agent.
      const runtimeDeps = Object.keys(pkg.dependencies ?? {});

      let framework: string | null = null;
      const agentDeps: string[] = [];

      for (const dep of runtimeDeps) {
        for (const pattern of AGENT_DEP_PATTERNS) {
          if (pattern.pattern.test(dep)) {
            if (!framework) framework = pattern.framework;
            agentDeps.push(dep);
          }
        }
        if (AGENT_SIGNAL_DEPS.includes(dep)) {
          agentDeps.push(dep);
        }
      }

      // Must have at least one runtime agent-related dependency
      if (agentDeps.length === 0) continue;

      // Derive path — strip "/package.json" to get directory
      const dir = pkgPath === "package.json"
        ? "."
        : pkgPath.replace(/\/package\.json$/, "");

      // Display name: prefer the unscoped portion of `@scope/name` so
      // monorepo siblings render as "the-watcher" not "@lua-agents/the-watcher".
      // Then strip a trailing `-agent` suffix because scaffolding tools
      // like `lua init` append it to every package name and it adds no
      // information ("luna-agent" → "luna"). Falls back to the directory
      // basename when no name is set.
      const rawName = pkg.name ?? dir.split("/").pop() ?? dir;
      const unscoped = rawName.startsWith("@") && rawName.includes("/")
        ? rawName.slice(rawName.indexOf("/") + 1)
        : rawName;
      const name = unscoped.replace(/-agent$/, "") || unscoped;

      roots.push({ path: dir, name, framework, agentDeps });
    } catch {
      // Invalid JSON — skip
    }
  }

  // Sort: deeper paths first (more specific), then alphabetically
  roots.sort((a, b) => {
    const depthA = a.path.split("/").length;
    const depthB = b.path.split("/").length;
    if (depthA !== depthB) return depthB - depthA;
    return a.path.localeCompare(b.path);
  });

  // Remove roots that are parents of other roots (avoid scanning a monorepo root
  // when its child packages are the actual agents)
  const filtered: AgentRoot[] = [];
  for (const root of roots) {
    const isParent = roots.some(
      (other) => other !== root && other.path.startsWith(root.path + "/")
    );
    // Keep root-level only if it's the only one
    if (root.path === "." && roots.length > 1) continue;
    if (!isParent) filtered.push(root);
  }

  return filtered;
}
