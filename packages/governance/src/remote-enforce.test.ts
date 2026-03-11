import { test, describe, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import { createGovernance } from "./index";
import { createRemoteEnforcer, validateRemoteConfig, RemoteEnforcementError } from "./remote-enforce";

// ─── Mock fetch ─────────────────────────────────────────────────

let mockFetch: ReturnType<typeof mock.fn>;

function setupFetchMock(status: number, body: unknown, ok = status >= 200 && status < 300) {
  mockFetch = mock.fn(() =>
    Promise.resolve({
      ok,
      status,
      statusText: status === 200 ? "OK" : status === 401 ? "Unauthorized" : "Error",
      json: () => Promise.resolve(body),
      text: () => Promise.resolve(typeof body === "string" ? body : JSON.stringify(body)),
    }),
  );
  (globalThis as Record<string, unknown>).fetch = mockFetch;
}

// ─── validateRemoteConfig ───────────────────────────────────────

describe("validateRemoteConfig", () => {
  test("throws when serverUrl set but apiKey missing", () => {
    assert.throws(
      () => validateRemoteConfig("https://api.example.com", undefined),
      { message: "apiKey is required when serverUrl is configured" },
    );
  });

  test("throws when serverUrl set but apiKey is empty string", () => {
    assert.throws(
      () => validateRemoteConfig("https://api.example.com", ""),
      { message: "apiKey is required when serverUrl is configured" },
    );
  });

  test("does not throw when both serverUrl and apiKey are set", () => {
    assert.doesNotThrow(() =>
      validateRemoteConfig("https://api.example.com", "key-123"),
    );
  });

  test("does not throw when neither is set", () => {
    assert.doesNotThrow(() => validateRemoteConfig(undefined, undefined));
  });

  test("does not throw when only apiKey is set (no serverUrl)", () => {
    assert.doesNotThrow(() => validateRemoteConfig(undefined, "key-123"));
  });
});

// ─── createGovernance with serverUrl ────────────────────────────

describe("createGovernance with serverUrl", () => {
  test("throws if serverUrl without apiKey", () => {
    assert.throws(
      () => createGovernance({ serverUrl: "https://api.example.com" }),
      { message: "apiKey is required when serverUrl is configured" },
    );
  });

  test("creates instance when both serverUrl and apiKey provided", () => {
    setupFetchMock(200, {});
    const gov = createGovernance({
      serverUrl: "https://api.example.com",
      apiKey: "test-key",
    });
    assert.ok(gov.enforce);
    assert.ok(gov.register);
  });
});

// ─── Remote enforce ─────────────────────────────────────────────

describe("remote enforce", () => {
  const config = { serverUrl: "https://api.example.com", apiKey: "test-key" };

  test("POSTs to /api/v1/enforce with correct headers", async () => {
    const expectedDecision = {
      blocked: false,
      reason: "Allowed by remote",
      ruleId: null,
      outcome: "allow",
      evaluatedAt: new Date().toISOString(),
      rulesEvaluated: 3,
    };
    setupFetchMock(200, expectedDecision);

    const remote = createRemoteEnforcer(config);
    const result = await remote.enforce({
      agentId: "agent-1",
      action: "tool_call",
      tool: "web_search",
    });

    assert.equal(result.blocked, false);
    assert.equal(result.reason, "Allowed by remote");
    assert.equal(mockFetch.mock.calls.length, 1);

    const call = mockFetch.mock.calls[0];
    assert.equal(call.arguments[0], "https://api.example.com/api/v1/enforce");
    const options = call.arguments[1] as Record<string, unknown>;
    assert.equal(options.method, "POST");
    const headers = options.headers as Record<string, string>;
    assert.equal(headers["Authorization"], "Bearer test-key");
    assert.equal(headers["Content-Type"], "application/json");
  });

  test("sends enforcement context in request body", async () => {
    setupFetchMock(200, { blocked: true, reason: "Blocked", ruleId: "r1", outcome: "block", evaluatedAt: "", rulesEvaluated: 1 });

    const remote = createRemoteEnforcer(config);
    await remote.enforce({
      agentId: "agent-1",
      agentName: "my-agent",
      agentLevel: 2,
      action: "tool_call",
      tool: "shell_exec",
    });

    const call = mockFetch.mock.calls[0];
    const body = JSON.parse(call.arguments[1].body as string);
    assert.equal(body.agentId, "agent-1");
    assert.equal(body.agentName, "my-agent");
    assert.equal(body.agentLevel, 2);
    assert.equal(body.tool, "shell_exec");
  });

  test("returns blocked decision from remote", async () => {
    setupFetchMock(200, {
      blocked: true,
      reason: "Tool blocked by policy",
      ruleId: "block-tools",
      outcome: "block",
      evaluatedAt: "2026-03-10T00:00:00Z",
      rulesEvaluated: 5,
    });

    const remote = createRemoteEnforcer(config);
    const result = await remote.enforce({
      agentId: "agent-1",
      action: "tool_call",
      tool: "shell_exec",
    });

    assert.equal(result.blocked, true);
    assert.equal(result.ruleId, "block-tools");
    assert.equal(result.outcome, "block");
  });

  test("throws RemoteEnforcementError on 401", async () => {
    setupFetchMock(401, "Unauthorized", false);

    const remote = createRemoteEnforcer(config);
    await assert.rejects(
      () => remote.enforce({ agentId: "a1", action: "tool_call" }),
      (err: RemoteEnforcementError) => {
        assert.equal(err.name, "RemoteEnforcementError");
        assert.equal(err.statusCode, 401);
        assert.ok(err.message.includes("401"));
        return true;
      },
    );
  });

  test("throws RemoteEnforcementError on 403", async () => {
    setupFetchMock(403, "Forbidden", false);

    const remote = createRemoteEnforcer(config);
    await assert.rejects(
      () => remote.enforce({ agentId: "a1", action: "tool_call" }),
      (err: RemoteEnforcementError) => {
        assert.equal(err.statusCode, 403);
        return true;
      },
    );
  });

  test("throws RemoteEnforcementError on 429 rate limit", async () => {
    setupFetchMock(429, "Too Many Requests", false);

    const remote = createRemoteEnforcer(config);
    await assert.rejects(
      () => remote.enforce({ agentId: "a1", action: "tool_call" }),
      (err: RemoteEnforcementError) => {
        assert.equal(err.statusCode, 429);
        return true;
      },
    );
  });

  test("throws RemoteEnforcementError on 500", async () => {
    setupFetchMock(500, "Internal Server Error", false);

    const remote = createRemoteEnforcer(config);
    await assert.rejects(
      () => remote.enforce({ agentId: "a1", action: "tool_call" }),
      (err: RemoteEnforcementError) => {
        assert.equal(err.statusCode, 500);
        assert.ok(err.responseBody.includes("Internal Server Error"));
        return true;
      },
    );
  });

  test("throws on network failure", async () => {
    mockFetch = mock.fn(() => Promise.reject(new TypeError("fetch failed")));
    (globalThis as Record<string, unknown>).fetch = mockFetch;

    const remote = createRemoteEnforcer(config);
    await assert.rejects(
      () => remote.enforce({ agentId: "a1", action: "tool_call" }),
      { name: "TypeError", message: "fetch failed" },
    );
  });

  test("strips trailing slash from serverUrl", async () => {
    setupFetchMock(200, { blocked: false, reason: "", ruleId: null, outcome: "allow", evaluatedAt: "", rulesEvaluated: 0 });

    const remote = createRemoteEnforcer({
      serverUrl: "https://api.example.com/",
      apiKey: "key",
    });
    await remote.enforce({ agentId: "a1", action: "tool_call" });

    const url = mockFetch.mock.calls[0].arguments[0];
    assert.equal(url, "https://api.example.com/api/v1/enforce");
  });
});

// ─── Remote register ────────────────────────────────────────────

describe("remote register", () => {
  const config = { serverUrl: "https://api.example.com", apiKey: "test-key" };

  test("POSTs to /api/v1/agents with correct headers", async () => {
    const expected = {
      id: "remote-id-1",
      score: 85,
      level: 4,
      status: "approved",
      assessment: {
        agentId: "remote-id-1",
        agentName: "my-agent",
        compositeScore: 85,
        level: { level: 4, label: "Certified", autonomy: "Cross-team", minScore: 81, maxScore: 100 },
        dimensions: [],
        status: "approved",
        assessedAt: "2026-03-10T00:00:00Z",
        recommendations: [],
      },
    };
    setupFetchMock(200, expected);

    const remote = createRemoteEnforcer(config);
    const result = await remote.register({
      name: "my-agent",
      framework: "mastra",
      owner: "team-a",
    });

    assert.equal(result.id, "remote-id-1");
    assert.equal(result.score, 85);
    assert.equal(result.level, 4);
    assert.equal(result.status, "approved");

    const call = mockFetch.mock.calls[0];
    assert.equal(call.arguments[0], "https://api.example.com/api/v1/agents");
    const body = JSON.parse(call.arguments[1].body as string);
    assert.equal(body.name, "my-agent");
    assert.equal(body.framework, "mastra");
  });

  test("throws RemoteEnforcementError on 401", async () => {
    setupFetchMock(401, "Unauthorized", false);

    const remote = createRemoteEnforcer(config);
    await assert.rejects(
      () => remote.register({ name: "a", framework: "mastra", owner: "t" }),
      (err: RemoteEnforcementError) => {
        assert.equal(err.statusCode, 401);
        return true;
      },
    );
  });

  test("throws RemoteEnforcementError on 500", async () => {
    setupFetchMock(500, "Server error", false);

    const remote = createRemoteEnforcer(config);
    await assert.rejects(
      () => remote.register({ name: "a", framework: "mastra", owner: "t" }),
      (err: RemoteEnforcementError) => {
        assert.equal(err.statusCode, 500);
        return true;
      },
    );
  });

  test("sends full registration payload", async () => {
    setupFetchMock(200, { id: "x", score: 50, level: 2, status: "flagged", assessment: {} });

    const remote = createRemoteEnforcer(config);
    await remote.register({
      name: "complex-agent",
      framework: "langchain",
      owner: "ml-team",
      description: "ML research agent",
      version: "2.0.0",
      tools: ["web_search", "code_exec"],
      channels: ["slack"],
      hasAuth: true,
      hasGuardrails: true,
    });

    const body = JSON.parse(mockFetch.mock.calls[0].arguments[1].body as string);
    assert.equal(body.name, "complex-agent");
    assert.equal(body.framework, "langchain");
    assert.equal(body.description, "ML research agent");
    assert.deepEqual(body.tools, ["web_search", "code_exec"]);
    assert.equal(body.hasAuth, true);
  });
});

// ─── Integration: createGovernance with remote ──────────────────

describe("createGovernance remote integration", () => {
  test("enforce delegates to remote when serverUrl is set", async () => {
    setupFetchMock(200, {
      blocked: true,
      reason: "Remote block",
      ruleId: "remote-rule",
      outcome: "block",
      evaluatedAt: "2026-03-10T00:00:00Z",
      rulesEvaluated: 1,
    });

    const gov = createGovernance({
      serverUrl: "https://api.example.com",
      apiKey: "key-123",
      rules: [], // local rules should be ignored for enforce
    });

    const decision = await gov.enforce({
      agentId: "a1",
      action: "tool_call",
      tool: "shell_exec",
    });

    assert.equal(decision.blocked, true);
    assert.equal(decision.reason, "Remote block");
    assert.equal(mockFetch.mock.calls.length, 1);
  });

  test("register delegates to remote when serverUrl is set", async () => {
    setupFetchMock(200, {
      id: "remote-id",
      score: 90,
      level: 4,
      status: "approved",
      assessment: { agentId: "remote-id", agentName: "test", compositeScore: 90, level: {}, dimensions: [], status: "approved", assessedAt: "", recommendations: [] },
    });

    const gov = createGovernance({
      serverUrl: "https://api.example.com",
      apiKey: "key-123",
    });

    const result = await gov.register({
      name: "test",
      framework: "mastra",
      owner: "team",
    });

    assert.equal(result.id, "remote-id");
    assert.equal(result.score, 90);
  });

  test("local methods still work when serverUrl is set", async () => {
    setupFetchMock(200, {});
    const gov = createGovernance({
      serverUrl: "https://api.example.com",
      apiKey: "key-123",
    });

    // These should NOT go through remote
    assert.ok(gov.policies);
    assert.ok(gov.storage);
    assert.ok(gov.audit);
    assert.ok(gov.score);
    assert.ok(gov.scoreFleet);
  });
});
