/**
 * Repository scanning patterns — detects agent capabilities from source code.
 *
 * Pure pattern matching. No I/O, no network, no dependencies.
 * Feed it file contents, get capability detection results.
 */

import { extractToolImports, parseImports, toolNamesFromImport } from "./import-lexer";
import type { ScannerPlugin, FileResolver } from "./scanner-plugins/types.js";

/** Detection result for a single capability */
export interface CapabilityDetection {
  capability: "hasAuth" | "hasGuardrails" | "hasObservability" | "hasAuditLog";
  detected: boolean;
  confidence: number; // 0-1
  evidence: string[];
}

/** Full repo scan result */
export interface RepoScanResult {
  detections: CapabilityDetection[];
  framework: string | null;
  tools: string[];
  channels: string[];
  dependencies: string[];
  scannedFiles: number;
  /**
   * Framework-specific metadata extracted by a scanner plugin (e.g. the
   * Lua plugin pulling `agent.agentId` out of `lua.skill.yaml`). Always
   * undefined for plain `scanRepoContents` calls; populated by
   * `scanRepoContentsWithPlugins` when a plugin's `extractMetadata`
   * returns a value.
   *
   * The most important convention key is `externalId` — when present,
   * callers should use it as the agent's canonical id at registration
   * time so the dashboard record matches the runtime's enforce calls.
   */
  metadata?: Record<string, unknown>;
}

interface PatternDef {
  pattern: RegExp;
  weight: number;
  label: string;
}

// ── Auth patterns ───────────────────────────────────────────────

const AUTH_PATTERNS: PatternDef[] = [
  { pattern: /(?:@clerk|@auth0|next-auth|@supabase\/auth|passport|lucia-auth|better-auth)/, weight: 0.9, label: "Auth library import" },
  { pattern: /(?:withAuth|requireAuth|authenticate|isAuthenticated|verifyToken|getSession)\s*\(/, weight: 0.8, label: "Auth middleware call" },
  { pattern: /(?:Bearer|Authorization|JWT|oauth|OIDC|SSO)\b/i, weight: 0.5, label: "Auth protocol reference" },
  { pattern: /(?:signIn|signUp|signOut|login|logout|createUser)\s*[=(]/, weight: 0.6, label: "Auth flow function" },
  { pattern: /(?:middleware|auth)\.(ts|js|tsx)/, weight: 0.4, label: "Auth middleware file" },
  { pattern: /(?:RBAC|ACL|role|permission).*(?:check|verify|require)/i, weight: 0.7, label: "Access control logic" },
  { pattern: /(?:apiKey|api_key|API_KEY|serviceKey|service_key)/, weight: 0.5, label: "API key pattern" },
];

// ── Guardrail patterns ──────────────────────────────────────────

const GUARDRAIL_PATTERNS: PatternDef[] = [
  { pattern: /(?:@lua\/governance|createGovernance|gov\.enforce)/, weight: 0.95, label: "Lua Governance SDK" },
  { pattern: /(?:guardrail|guard|safety|filter|sanitize|validate)(?:Input|Output|Response|Request)/i, weight: 0.7, label: "Guardrail function" },
  { pattern: /(?:zod|yup|joi|superstruct|valibot)/, weight: 0.5, label: "Schema validation library" },
  { pattern: /(?:z\.object|z\.string|z\.number|z\.array)\s*\(/, weight: 0.6, label: "Zod schema usage" },
  { pattern: /(?:contentFilter|toxicity|moderation|safety)(?:Check|Filter|Guard)/i, weight: 0.8, label: "Content safety filter" },
  { pattern: /(?:rateLimit|rateLimiter|throttle)\s*\(/, weight: 0.6, label: "Rate limiting" },
  { pattern: /(?:injection|xss|sql|csrf).*(?:detect|prevent|guard|filter)/i, weight: 0.7, label: "Injection prevention" },
  { pattern: /(?:maxTokens|max_tokens|token_limit|tokenBudget)/, weight: 0.5, label: "Token budget control" },
];

// ── Observability patterns ──────────────────────────────────────

const OBSERVABILITY_PATTERNS: PatternDef[] = [
  { pattern: /(?:@opentelemetry|opentelemetry|otel)/, weight: 0.9, label: "OpenTelemetry" },
  { pattern: /(?:@sentry|sentry|Sentry\.init)/, weight: 0.8, label: "Sentry" },
  { pattern: /(?:@datadog|dd-trace|datadog)/, weight: 0.8, label: "Datadog" },
  { pattern: /(?:pino|winston|bunyan|loglevel|consola)\b/, weight: 0.6, label: "Structured logging" },
  { pattern: /(?:trace|span|tracer|instrument)(?:\.start|\.end|\s*\()/, weight: 0.7, label: "Tracing instrumentation" },
  { pattern: /(?:prometheus|grafana|newrelic|axiom|betterstack)/, weight: 0.7, label: "Monitoring platform" },
  { pattern: /(?:langfuse|langsmith|helicone|braintrust)/, weight: 0.8, label: "AI observability" },
  { pattern: /(?:metrics|histogram|counter|gauge)\.(?:record|inc|observe)/, weight: 0.6, label: "Metrics recording" },
];

// ── Audit log patterns ──────────────────────────────────────────

const AUDIT_PATTERNS: PatternDef[] = [
  { pattern: /(?:audit|auditLog|audit_log|createAuditEvent)/, weight: 0.9, label: "Audit log reference" },
  { pattern: /(?:gov\.audit|audit\.log|auditTrail)\s*[.(]/, weight: 0.95, label: "Audit logging call" },
  { pattern: /(?:eventType|event_type).*(?:created|updated|deleted|accessed)/i, weight: 0.6, label: "Event type tracking" },
  { pattern: /(?:immutable|tamper|hash.*chain|integrity).*(?:log|event|record)/i, weight: 0.7, label: "Tamper-evident logging" },
  { pattern: /(?:GDPR|SOC\s*2|HIPAA|compliance).*(?:log|audit|record)/i, weight: 0.6, label: "Compliance logging" },
];

// ── Framework detection ─────────────────────────────────────────
// Order matters — first match wins. Lua before Mastra (Lua uses Mastra under the hood).

const FRAMEWORK_PATTERNS: Array<{ pattern: RegExp; framework: string }> = [
  { pattern: /["']lua-cli["']|LuaAgent|LuaTool|LuaSkill/, framework: "lua" },
  { pattern: /["']@mastra\/core["']|["']mastra["']/, framework: "mastra" },
  { pattern: /["']langchain["']|["']@langchain\//, framework: "langchain" },
  { pattern: /["']crewai["']/, framework: "crewai" },
  { pattern: /["']autogen["']/, framework: "autogen" },
  { pattern: /["']openai["'].*(?:agent|assistant)/i, framework: "openai" },
  { pattern: /["']@vercel\/ai["']|["']ai["']/, framework: "vercel-ai" },
  { pattern: /["']@modelcontextprotocol\//, framework: "mcp" },
  { pattern: /["']@aws-sdk\/client-bedrock["']/, framework: "bedrock" },
  { pattern: /["']@genkit-ai\//, framework: "genkit" },
  { pattern: /["']@anthropic-ai\/sdk["']/, framework: "anthropic" },
];

// ── Tool detection ──────────────────────────────────────────────

const GENERIC_TOOL_PATTERNS: RegExp[] = [
  // Generic: createTool("name"), defineTool("name"), tool("name")
  /(?:createTool|defineTool|tool)\s*\(\s*["'`]([^"'`]+)["'`]/g,
  // MCP: server.tool("name")
  /server\.tool\s*\(\s*["'`]([^"'`]+)["'`]/g,
  // Mastra/generic: createTool({ id: "name" }) or new Tool({ id: "name" })
  /(?:createTool|new\s+Tool)\s*\(\s*\{[^}]*id\s*:\s*["'`]([^"'`]+)["'`]/g,
  // Vercel AI: tools.name = ...
  /tools\.([a-z][a-z0-9_]+)\s*=/g,
];

// Lua agents: class FooTool implements LuaTool { name = "foo_bar" }
// name is always within a few lines of `implements LuaTool`
const LUA_TOOL_NAME_PATTERN = /implements\s+LuaTool\s*\{[\s\n]*name\s*=\s*["'`]([^"'`]+)["'`]/g;

// ── Channel detection ───────────────────────────────────────────

const CHANNEL_PATTERNS: Array<{ pattern: RegExp; channel: string }> = [
  // Lua agent channels — detected from preprocessors, channel refs, env vars
  { pattern: /Lua\.request\.channel\s*===?\s*["']slack["']|SLACK_BOT_TOKEN|SLACK_.*CHANNEL/i, channel: "slack" },
  { pattern: /Lua\.request\.channel\s*===?\s*["']email["']|emailIngestion|email.*[Pp]reProcessor/, channel: "email" },
  { pattern: /Lua\.request\.channel\s*===?\s*["']whatsapp["']|WHATSAPP_.*TOKEN/, channel: "whatsapp" },
  // Generic SDK/library patterns
  { pattern: /(?:@slack\/web-api|@slack\/bolt|SlackApp|WebClient)\b/, channel: "slack" },
  { pattern: /(?:nodemailer|@sendgrid|ses\.send|resend|postmark)\b/i, channel: "email" },
  { pattern: /(?:twilio.*whatsapp|whatsapp.*api)/i, channel: "whatsapp" },
  { pattern: /(?:twilio.*sms|sendSms|messagebird)/i, channel: "sms" },
  { pattern: /(?:discord\.js|@discordjs|DiscordClient)/i, channel: "discord" },
  { pattern: /(?:telegraf|node-telegram|Telegraf)\b/, channel: "telegram" },
  { pattern: /(?:@microsoft\/teams|botframework)\b/, channel: "teams" },
  { pattern: /(?:webhook|webhookUrl|sendWebhook|notifyWebhook)/i, channel: "webhook" },
  { pattern: /(?:express\(\)|fastify\(|new\s+Hono|new\s+Elysia)/, channel: "api" },
];

// ── Public API ──────────────────────────────────────────────────

/** Score a capability against file contents. Returns 0-1 confidence. */
function scoreCapability(
  fileContents: Map<string, string>,
  patterns: PatternDef[],
): { confidence: number; evidence: string[] } {
  const evidence: string[] = [];
  let totalWeight = 0;

  for (const [filePath, content] of fileContents) {
    for (const p of patterns) {
      if (p.pattern.test(content)) {
        evidence.push(`${p.label} in ${filePath}`);
        totalWeight += p.weight;
      }
    }
  }

  // Normalize: 2+ strong signals = high confidence
  const confidence = Math.min(1, totalWeight / 2);
  return { confidence, evidence };
}

/** Detect framework from package.json or source files. */
function detectFramework(fileContents: Map<string, string>): string | null {
  for (const [, content] of fileContents) {
    for (const f of FRAMEWORK_PATTERNS) {
      if (f.pattern.test(content)) return f.framework;
    }
  }
  return null;
}

/**
 * Extract tool names from source code using definition-based patterns
 * only. Looks for inline tool declarations like `createTool("name")`,
 * `implements LuaTool`, and Mastra/Vercel factory calls. Does NOT walk
 * imports — that's the job of import-based extraction or scanner
 * plugins, which can be added on top of this base pass.
 */
function extractInlineTools(
  fileContents: Map<string, string>,
  framework: string | null,
): string[] {
  const tools = new Set<string>();
  const definitionPatterns = framework === "lua"
    ? [LUA_TOOL_NAME_PATTERN, ...GENERIC_TOOL_PATTERNS]
    : GENERIC_TOOL_PATTERNS;

  for (const [, content] of fileContents) {
    for (const pattern of definitionPatterns) {
      pattern.lastIndex = 0;
      let match;
      while ((match = pattern.exec(content)) !== null) {
        const name = match[1];
        if (isValidToolName(name)) tools.add(name);
      }
    }
  }
  return [...tools];
}

/**
 * Extract tool names from source code.
 *
 * Combines two strategies:
 *   1. Definition matching — inline tool declarations (see extractInlineTools)
 *   2. Import matching — framework-agnostic import lexer that finds tools
 *      brought in from shared packages (e.g. `import dealSkill from
 *      "@lua-agents/crm/skills/dealSkill"`). This is a fallback for repos
 *      that don't have a scanner plugin — it's a heuristic and will pick
 *      up skill *containers* as if they were tools. Scanner plugins give
 *      precise results, so prefer `scanRepoContentsWithPlugins` when a
 *      plugin is available for the repo's framework.
 *
 * Both strategies run on every scan regardless of framework — a repo may
 * mix inline definitions with imported tool packages, and we want both.
 */
function extractTools(fileContents: Map<string, string>, framework: string | null): string[] {
  const tools = new Set<string>(extractInlineTools(fileContents, framework));

  for (const [, content] of fileContents) {
    // Strategy 2: imported tools from shared packages
    for (const imp of extractToolImports(content)) {
      for (const name of toolNamesFromImport(imp)) {
        if (isValidToolName(name)) tools.add(name);
      }
    }
  }
  return [...tools];
}

/** Filter obvious false positives from tool name extraction. */
function isValidToolName(name: string): boolean {
  if (name.length < 2 || name.length > 64) return false;
  // Common JS identifiers that aren't tool names
  if (/^(id|name|type|key|value|data|error|result|input|output|config|options|default)$/.test(name)) return false;
  return true;
}

/** Detect communication channels from source code. */
function extractChannels(fileContents: Map<string, string>): string[] {
  const channels = new Set<string>();
  for (const [, content] of fileContents) {
    for (const { pattern, channel } of CHANNEL_PATTERNS) {
      if (pattern.test(content)) {
        channels.add(channel);
      }
    }
  }
  return [...channels];
}

/** Extract dependencies from package.json content. */
function extractDeps(packageJson: string): string[] {
  try {
    const pkg = JSON.parse(packageJson);
    return [
      ...Object.keys(pkg.dependencies ?? {}),
      ...Object.keys(pkg.devDependencies ?? {}),
    ];
  } catch {
    return [];
  }
}

/**
 * Scan file contents for agent capabilities.
 *
 * Feed this a Map of filePath → fileContent. Returns a synchronous
 * scan result using only the in-memory file contents.
 *
 * For framework-aware skill/tool container expansion (e.g. Lua skills
 * that bundle multiple tools), use `scanRepoContentsWithPlugins` instead
 * and pass the relevant scanner plugins plus an async file resolver.
 */
export function scanRepoContents(fileContents: Map<string, string>): RepoScanResult {
  const auth = scoreCapability(fileContents, AUTH_PATTERNS);
  const guardrails = scoreCapability(fileContents, GUARDRAIL_PATTERNS);
  const observability = scoreCapability(fileContents, OBSERVABILITY_PATTERNS);
  const auditLog = scoreCapability(fileContents, AUDIT_PATTERNS);

  const pkgContent = fileContents.get("package.json") ?? "";
  const deps = extractDeps(pkgContent);
  const framework = detectFramework(fileContents);

  return {
    detections: [
      { capability: "hasAuth", detected: auth.confidence >= 0.4, confidence: auth.confidence, evidence: auth.evidence },
      { capability: "hasGuardrails", detected: guardrails.confidence >= 0.4, confidence: guardrails.confidence, evidence: guardrails.evidence },
      { capability: "hasObservability", detected: observability.confidence >= 0.4, confidence: observability.confidence, evidence: observability.evidence },
      { capability: "hasAuditLog", detected: auditLog.confidence >= 0.4, confidence: auditLog.confidence, evidence: auditLog.evidence },
    ],
    framework,
    tools: extractTools(fileContents, framework),
    channels: extractChannels(fileContents),
    dependencies: deps,
    scannedFiles: fileContents.size,
  };
}

/** Options for plugin-aware scanning. */
export interface ScanWithPluginsOptions {
  /** Framework-specific scanner plugins. Applied in order. */
  plugins: ScannerPlugin[];
  /**
   * Caller-provided file resolver. Given an import specifier, return
   * the source code of the resolved module, or null if unreachable.
   * The resolver is responsible for any I/O — the SDK stays zero-I/O.
   */
  resolveFile: FileResolver;
  /**
   * Max number of unique specifiers to resolve per scan. Guards against
   * accidental recursion into enormous dependency graphs. Default: 200.
   */
  maxResolves?: number;
}

/**
 * Plugin-aware scan. Performs the same capability detection as
 * `scanRepoContents` and then expands any framework-specific tool
 * containers (e.g. a skill package that bundles several tools) into
 * their constituent tool names by handing the import off to a matching
 * plugin along with a shared caller-provided file resolver.
 *
 * Only the first plugin that claims an import is used for expansion —
 * plugins are treated as ordered by caller preference. A plugin's
 * `detectFramework` hook (when present) gates whether its expansion
 * runs at all for the current repo.
 *
 * The scanner maintains a single `visited` set and `remainingBudget`
 * across the whole scan, so plugins that walk relative imports won't
 * double-resolve the same file and won't run unbounded I/O.
 */
export async function scanRepoContentsWithPlugins(
  fileContents: Map<string, string>,
  options: ScanWithPluginsOptions,
): Promise<RepoScanResult> {
  const base = scanRepoContents(fileContents);

  const activePlugins = options.plugins.filter(
    (p) => !p.detectFramework || p.detectFramework(fileContents),
  );
  if (activePlugins.length === 0) return base;

  // When a plugin is active, it knows the framework's tool semantics
  // better than the generic import-based heuristic. Start from only the
  // inline-definition tools (precise) and let the plugin add the rest
  // via expansion. The generic import fallback would otherwise pollute
  // the result with skill *container* names and type imports.
  const tools = new Set<string>(extractInlineTools(fileContents, base.framework));

  const maxResolves = options.maxResolves ?? 200;
  const visited = new Set<string>();
  const remainingBudget = { value: maxResolves };
  const resolvedSpecifiers = new Set<string>();

  for (const [, content] of fileContents) {
    for (const imp of parseImports(content)) {
      if (remainingBudget.value <= 0) break;
      if (resolvedSpecifiers.has(imp.specifier)) continue;
      const plugin = activePlugins.find((p) => p.ownsImport(imp));
      if (!plugin) continue;

      resolvedSpecifiers.add(imp.specifier);
      remainingBudget.value -= 1;

      let resolved: Awaited<ReturnType<FileResolver>>;
      try {
        resolved = await options.resolveFile(imp.specifier);
      } catch {
        resolved = null;
      }
      if (!resolved) continue;
      if (visited.has(resolved.path)) continue;
      visited.add(resolved.path);

      let expanded: string[];
      try {
        expanded = await plugin.expandTools(resolved.content, {
          fromPath: resolved.path,
          resolve: options.resolveFile,
          visited,
          remainingBudget,
        });
      } catch {
        expanded = [];
      }

      for (const name of expanded) {
        if (isValidToolName(name)) tools.add(name);
      }
    }
  }

  // Collect framework-specific metadata from active plugins. Plugins are
  // merged in registration order — later plugins overwrite earlier keys
  // for the same field, but in practice only one plugin should claim a
  // given repo (gated by detectFramework) so collisions are rare.
  let metadata: Record<string, unknown> | undefined;
  for (const plugin of activePlugins) {
    if (!plugin.extractMetadata) continue;
    let extracted: Record<string, unknown> | null;
    try {
      extracted = await plugin.extractMetadata(fileContents);
    } catch {
      extracted = null;
    }
    if (extracted) {
      metadata = { ...(metadata ?? {}), ...extracted };
    }
  }

  return {
    ...base,
    tools: [...tools],
    ...(metadata ? { metadata } : {}),
  };
}

/** Files worth scanning — skip node_modules, dist, tests, assets. */
export const SCAN_GLOBS = [
  "package.json",
  "src/**/*.ts",
  "src/**/*.tsx",
  "src/**/*.js",
  "lib/**/*.ts",
  "app/**/*.ts",
  "app/**/*.tsx",
  "middleware.ts",
  "middleware.js",
];

/** Files to skip even if they match globs. */
export const SCAN_IGNORE = [
  /node_modules/,
  /\.next/,
  /dist\//,
  /\.test\./,
  /\.spec\./,
  /\.d\.ts$/,
  /__tests__/,
  /coverage\//,
];
