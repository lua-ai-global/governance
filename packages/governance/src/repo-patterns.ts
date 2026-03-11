/**
 * Repository scanning patterns — detects agent capabilities from source code.
 *
 * Pure pattern matching. No I/O, no network, no dependencies.
 * Feed it file contents, get capability detection results.
 */

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

/** Extract tool names from source code. */
function extractTools(fileContents: Map<string, string>, framework: string | null): string[] {
  const tools = new Set<string>();
  const patterns = framework === "lua"
    ? [LUA_TOOL_NAME_PATTERN, ...GENERIC_TOOL_PATTERNS]
    : GENERIC_TOOL_PATTERNS;

  for (const [, content] of fileContents) {
    for (const pattern of patterns) {
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
 * Feed this a Map of filePath → fileContent.
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
