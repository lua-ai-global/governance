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

/** Secondary deps that confirm an agent (not framework-specific) */
const AGENT_SIGNAL_DEPS = [
  "governance-sdk",
  "@langchain/openai",
  "@langchain/anthropic",
  "llamaindex",
  "zod",
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
      };

      const allDeps = [
        ...Object.keys(pkg.dependencies ?? {}),
        ...Object.keys(pkg.devDependencies ?? {}),
      ];

      // Check for agent framework deps
      let framework: string | null = null;
      const agentDeps: string[] = [];

      for (const dep of allDeps) {
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

      // Must have at least one agent-related dependency
      if (agentDeps.length === 0) continue;

      // Derive path — strip "/package.json" to get directory
      const dir = pkgPath === "package.json"
        ? "."
        : pkgPath.replace(/\/package\.json$/, "");

      const name = pkg.name ?? dir.split("/").pop() ?? dir;

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
