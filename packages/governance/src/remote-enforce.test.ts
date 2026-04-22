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

  test("throws on invalid URL format", () => {
    assert.throws(
      () => validateRemoteConfig("not-a-url", "key-123"),
      /Invalid serverUrl/,
    );
  });

  test("throws on non-http protocol (file://)", () => {
    assert.throws(
      () => validateRemoteConfig("file:///etc/passwd", "key-123"),
      /only http: and https: are allowed/,
    );
  });

  test("throws on non-http protocol (ftp://)", () => {
    assert.throws(
      () => validateRemoteConfig("ftp://example.com", "key-123"),
      /only http: and https: are allowed/,
    );
  });

  test("allows http:// URLs (for localhost dev)", () => {
    assert.doesNotThrow(() => validateRemoteConfig("http://localhost:4000", "key-123"));
  });

  test("allows https:// URLs", () => {
    assert.doesNotThrow(() => validateRemoteConfig("https://api.example.com", "key-123"));
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

  test("falls back on 500 after retries (fail-open)", async () => {
    setupFetchMock(500, "Internal Server Error", false);

    const remote = createRemoteEnforcer({ ...config, maxRetries: 0 });
    const decision = await remote.enforce({ agentId: "a1", action: "tool_call" });
    assert.equal(decision.blocked, false);
    assert.ok(decision.reason.includes("unreachable"));
  });

  test("blocks on 500 with fallbackMode block", async () => {
    setupFetchMock(500, "Internal Server Error", false);

    const remote = createRemoteEnforcer({ ...config, maxRetries: 0, fallbackMode: "block" });
    const decision = await remote.enforce({ agentId: "a1", action: "tool_call" });
    assert.equal(decision.blocked, true);
    assert.ok(decision.reason.includes("blocking"));
  });

  test("falls back on network failure (fail-open)", async () => {
    mockFetch = mock.fn(() => Promise.reject(new TypeError("fetch failed")));
    (globalThis as Record<string, unknown>).fetch = mockFetch;

    const remote = createRemoteEnforcer({ ...config, maxRetries: 0 });
    const decision = await remote.enforce({ agentId: "a1", action: "tool_call" });
    assert.equal(decision.blocked, false);
    assert.ok(decision.reason.includes("unreachable"));
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

describe("remote register (POST /api/v1/agents)", () => {
  const config = { serverUrl: "https://api.example.com", apiKey: "test-key" };

  test("POSTs to /api/v1/agents and returns authoritative score + level", async () => {
    setupFetchMock(201, {
      id: "agent-abc",
      name: "my-agent",
      compositeScore: 72,
      governanceLevel: 3,
      status: "approved",
    });
    const remote = createRemoteEnforcer(config);
    const result = await remote.register({
      name: "my-agent",
      framework: "mastra",
      owner: "team-a",
    });

    assert.equal(mockFetch.mock.calls.length, 1);
    const url = mockFetch.mock.calls[0].arguments[0];
    assert.equal(url, "https://api.example.com/api/v1/agents");
    assert.equal(result.id, "agent-abc");
    assert.equal(result.score, 72);
    assert.equal(result.level, 3);
    assert.equal(result.status, "approved");
    assert.equal(result.assessment.agentName, "my-agent");
  });

  test("falls back to synthetic receipt when cloud is unreachable", async () => {
    setupFetchMock(500, {});
    const remote = createRemoteEnforcer(config);
    const result = await remote.register({
      name: "my-agent",
      framework: "mastra",
      owner: "team-a",
    });

    // Non-200 — we fall through so register never throws on the caller.
    assert.equal(result.id, "my-agent");
    assert.equal(result.status, "registered");
    assert.equal(result.level, 0);
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

  test("register POSTs to /api/v1/agents when serverUrl is set", async () => {
    setupFetchMock(201, {
      id: "agent-xyz",
      name: "test",
      compositeScore: 55,
      governanceLevel: 2,
      status: "approved",
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

    // Register now fetches authoritative score/level from the API rather
    // than returning a synthetic level: 0 placeholder.
    assert.equal(result.id, "agent-xyz");
    assert.equal(result.level, 2);
    assert.equal(mockFetch.mock.calls.length, 1);
    assert.equal(
      mockFetch.mock.calls[0].arguments[0],
      "https://api.example.com/api/v1/agents",
    );
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

// ─── Status tracking after non-retryable (4xx) errors (0.12 fix) ──

describe("remote status after 4xx errors", () => {
  test("non-retryable 4xx leaves connected=true because API answered us", async () => {
    // Succeed first so lastConnected becomes true.
    setupFetchMock(200, {
      decision: {
        blocked: false, outcome: "allow", reason: "ok", ruleId: null,
        evaluatedAt: new Date().toISOString(), rulesEvaluated: 0,
      },
    });
    const enforcer = createRemoteEnforcer({
      serverUrl: "https://api.example.com",
      apiKey: "key-123",
    });
    await enforcer.enforce({ agentId: "a", agentName: "a", agentLevel: 1, action: "tool_call" });
    assert.equal(enforcer.status().connected, true);

    // Now a 4xx. Must throw (non-retryable) but must NOT flip connected to
    // false — the API answered us; only network-level failure counts as
    // disconnection.
    setupFetchMock(401, "Unauthorized");
    await assert.rejects(
      () => enforcer.enforce({ agentId: "a", agentName: "a", agentLevel: 1, action: "tool_call" }),
      RemoteEnforcementError,
    );
    assert.equal(
      enforcer.status().connected,
      true,
      "4xx is an API-layer error; the connection is still healthy",
    );
  });

  test("network failure correctly flips connected to false then back to true on recovery", async () => {
    const enforcer = createRemoteEnforcer({
      serverUrl: "https://api.example.com",
      apiKey: "key-123",
      maxRetries: 0,
    });

    // Offline.
    (globalThis as Record<string, unknown>).fetch = mock.fn(() =>
      Promise.reject(new Error("ECONNREFUSED")),
    );
    await enforcer.enforce({ agentId: "a", agentName: "a", agentLevel: 1, action: "tool_call" });
    assert.equal(enforcer.status().connected, false);

    // Recovery.
    setupFetchMock(200, {
      decision: {
        blocked: false, outcome: "allow", reason: "ok", ruleId: null,
        evaluatedAt: new Date().toISOString(), rulesEvaluated: 0,
      },
    });
    await enforcer.enforce({ agentId: "a", agentName: "a", agentLevel: 1, action: "tool_call" });
    assert.equal(enforcer.status().connected, true);
  });
});
