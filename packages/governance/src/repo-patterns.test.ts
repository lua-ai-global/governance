import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { scanRepoContents } from "./repo-patterns";

describe("scanRepoContents", () => {
  it("detects auth from middleware imports", () => {
    const files = new Map([
      ["src/middleware.ts", `import { withAuth } from "@clerk/nextjs"; export default withAuth();`],
    ]);
    const result = scanRepoContents(files);
    const auth = result.detections.find((d) => d.capability === "hasAuth");
    assert.ok(auth);
    assert.equal(auth.detected, true);
    assert.ok(auth.confidence > 0.5);
    assert.ok(auth.evidence.length > 0);
  });

  it("detects Lua Governance SDK as guardrail", () => {
    const files = new Map([
      ["src/agent.ts", `import { createGovernance } from "@lua-ai-global/governance";\nconst gov = createGovernance({ rules: [] });`],
    ]);
    const result = scanRepoContents(files);
    const guard = result.detections.find((d) => d.capability === "hasGuardrails");
    assert.ok(guard);
    assert.equal(guard.detected, true);
    assert.ok(guard.confidence > 0.4);
  });

  it("detects OpenTelemetry as observability", () => {
    const files = new Map([
      ["src/tracing.ts", `import { trace } from "@opentelemetry/api";\nconst tracer = trace.getTracer("agent");`],
    ]);
    const result = scanRepoContents(files);
    const obs = result.detections.find((d) => d.capability === "hasObservability");
    assert.ok(obs);
    assert.equal(obs.detected, true);
  });

  it("detects audit logging", () => {
    const files = new Map([
      ["src/agent.ts", `await gov.audit.log({ agentId: "a1", eventType: "action", outcome: "allowed" });`],
    ]);
    const result = scanRepoContents(files);
    const audit = result.detections.find((d) => d.capability === "hasAuditLog");
    assert.ok(audit);
    assert.equal(audit.detected, true);
  });

  it("detects framework from package.json", () => {
    const files = new Map([
      ["package.json", JSON.stringify({ dependencies: { "@mastra/core": "^1.0.0" } })],
    ]);
    const result = scanRepoContents(files);
    assert.equal(result.framework, "mastra");
  });

  it("detects vercel-ai framework", () => {
    const files = new Map([
      ["package.json", JSON.stringify({ dependencies: { "ai": "^3.0.0", "@vercel/ai": "^1.0.0" } })],
    ]);
    const result = scanRepoContents(files);
    assert.equal(result.framework, "vercel-ai");
  });

  it("extracts tool names from createTool calls", () => {
    const files = new Map([
      ["src/tools.ts", `createTool("web_search", { ... });\ncreateTool("db_query", { ... });`],
    ]);
    const result = scanRepoContents(files);
    assert.ok(result.tools.includes("web_search"));
    assert.ok(result.tools.includes("db_query"));
  });

  it("extracts MCP server tools", () => {
    const files = new Map([
      ["src/server.ts", `server.tool("calculate", { ... });\nserver.tool("fetch_data", { ... });`],
    ]);
    const result = scanRepoContents(files);
    assert.ok(result.tools.includes("calculate"));
    assert.ok(result.tools.includes("fetch_data"));
  });

  it("extracts dependencies from package.json", () => {
    const files = new Map([
      ["package.json", JSON.stringify({
        dependencies: { "@mastra/core": "^1.0.0", "zod": "^3.0.0" },
        devDependencies: { "typescript": "^5.0.0" },
      })],
    ]);
    const result = scanRepoContents(files);
    assert.ok(result.dependencies.includes("@mastra/core"));
    assert.ok(result.dependencies.includes("zod"));
    assert.ok(result.dependencies.includes("typescript"));
  });

  it("returns low confidence when no signals found", () => {
    const files = new Map([
      ["src/index.ts", `console.log("hello world");`],
    ]);
    const result = scanRepoContents(files);
    for (const d of result.detections) {
      assert.equal(d.detected, false);
      assert.equal(d.confidence, 0);
    }
  });

  it("accumulates confidence from multiple files", () => {
    const files = new Map([
      ["src/auth.ts", `import { withAuth } from "next-auth";\nexport const requireAuth = withAuth();`],
      ["src/api.ts", `const token = req.headers["Authorization"];\nverifyToken(token);`],
      ["middleware.ts", `import { getSession } from "@auth0/nextjs-auth0";`],
    ]);
    const result = scanRepoContents(files);
    const auth = result.detections.find((d) => d.capability === "hasAuth");
    assert.ok(auth);
    assert.equal(auth.detected, true);
    assert.ok(auth.confidence > 0.8, `Expected high confidence, got ${auth.confidence}`);
  });

  it("detects zod as guardrail signal", () => {
    const files = new Map([
      ["src/schema.ts", `import { z } from "zod";\nconst input = z.object({ name: z.string() });`],
    ]);
    const result = scanRepoContents(files);
    const guard = result.detections.find((d) => d.capability === "hasGuardrails");
    assert.ok(guard);
    assert.ok(guard.confidence > 0);
  });

  it("detects Sentry as observability", () => {
    const files = new Map([
      ["src/instrument.ts", `import * as Sentry from "@sentry/node";\nSentry.init({ dsn: "..." });`],
    ]);
    const result = scanRepoContents(files);
    const obs = result.detections.find((d) => d.capability === "hasObservability");
    assert.ok(obs);
    assert.equal(obs.detected, true);
  });

  it("tracks scannedFiles count", () => {
    const files = new Map([
      ["src/a.ts", "code"],
      ["src/b.ts", "code"],
      ["src/c.ts", "code"],
    ]);
    const result = scanRepoContents(files);
    assert.equal(result.scannedFiles, 3);
  });

  it("handles empty file map", () => {
    const result = scanRepoContents(new Map());
    assert.equal(result.scannedFiles, 0);
    assert.equal(result.framework, null);
    assert.equal(result.tools.length, 0);
  });
});
