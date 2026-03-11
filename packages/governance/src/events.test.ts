import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createGovernanceEmitter } from "./events";
import type { GovernanceEvent, GovernanceEventType } from "./events";

// ─── Basic Functionality ────────────────────────────────────────

describe("GovernanceEmitter", () => {
  test("creates emitter with all methods", () => {
    const emitter = createGovernanceEmitter();
    assert.ok(emitter.on);
    assert.ok(emitter.onAny);
    assert.ok(emitter.off);
    assert.ok(emitter.offAny);
    assert.ok(emitter.emit);
    assert.ok(emitter.listenerCount);
    assert.ok(emitter.removeAllListeners);
  });

  test("on/emit delivers events to type-specific handlers", () => {
    const emitter = createGovernanceEmitter();
    const received: GovernanceEvent[] = [];

    emitter.on("enforcement", (e) => received.push(e));

    emitter.emit({
      type: "enforcement",
      timestamp: new Date().toISOString(),
      agentId: "a1",
      detail: { blocked: true },
    });

    assert.equal(received.length, 1);
    assert.equal(received[0].type, "enforcement");
    assert.equal(received[0].agentId, "a1");
  });

  test("does not deliver to wrong type handler", () => {
    const emitter = createGovernanceEmitter();
    const received: GovernanceEvent[] = [];

    emitter.on("enforcement", (e) => received.push(e));

    emitter.emit({
      type: "registration",
      timestamp: new Date().toISOString(),
      detail: {},
    });

    assert.equal(received.length, 0);
  });

  test("onAny receives all event types", () => {
    const emitter = createGovernanceEmitter();
    const received: GovernanceEvent[] = [];

    emitter.onAny((e) => received.push(e));

    const types: GovernanceEventType[] = [
      "enforcement", "registration", "kill", "revive",
      "score_change", "policy_added", "audit",
    ];

    for (const type of types) {
      emitter.emit({
        type,
        timestamp: new Date().toISOString(),
        detail: {},
      });
    }

    assert.equal(received.length, types.length);
  });

  test("multiple handlers on same type", () => {
    const emitter = createGovernanceEmitter();
    let count = 0;

    emitter.on("enforcement", () => count++);
    emitter.on("enforcement", () => count++);
    emitter.on("enforcement", () => count++);

    emitter.emit({
      type: "enforcement",
      timestamp: new Date().toISOString(),
      detail: {},
    });

    assert.equal(count, 3);
  });

  test("off removes specific handler", () => {
    const emitter = createGovernanceEmitter();
    const received: string[] = [];

    const handler1 = () => received.push("handler1");
    const handler2 = () => received.push("handler2");

    emitter.on("enforcement", handler1);
    emitter.on("enforcement", handler2);

    emitter.off("enforcement", handler1);

    emitter.emit({
      type: "enforcement",
      timestamp: new Date().toISOString(),
      detail: {},
    });

    assert.equal(received.length, 1);
    assert.equal(received[0], "handler2");
  });

  test("offAny removes wildcard handler", () => {
    const emitter = createGovernanceEmitter();
    let count = 0;

    const handler = () => count++;
    emitter.onAny(handler);
    emitter.offAny(handler);

    emitter.emit({
      type: "enforcement",
      timestamp: new Date().toISOString(),
      detail: {},
    });

    assert.equal(count, 0);
  });

  test("removeAllListeners clears everything", () => {
    const emitter = createGovernanceEmitter();
    let count = 0;

    emitter.on("enforcement", () => count++);
    emitter.on("registration", () => count++);
    emitter.onAny(() => count++);

    emitter.removeAllListeners();

    emitter.emit({
      type: "enforcement",
      timestamp: new Date().toISOString(),
      detail: {},
    });

    assert.equal(count, 0);
  });

  test("listenerCount for specific type", () => {
    const emitter = createGovernanceEmitter();

    assert.equal(emitter.listenerCount("enforcement"), 0);

    emitter.on("enforcement", () => {});
    emitter.on("enforcement", () => {});

    assert.equal(emitter.listenerCount("enforcement"), 2);
  });

  test("listenerCount includes onAny handlers", () => {
    const emitter = createGovernanceEmitter();

    emitter.on("enforcement", () => {});
    emitter.onAny(() => {});

    // Type-specific count includes type handlers + any handlers
    assert.equal(emitter.listenerCount("enforcement"), 2);
  });

  test("listenerCount without type returns total", () => {
    const emitter = createGovernanceEmitter();

    emitter.on("enforcement", () => {});
    emitter.on("registration", () => {});
    emitter.onAny(() => {});

    assert.equal(emitter.listenerCount(), 3);
  });

  test("emit with no listeners is no-op", () => {
    const emitter = createGovernanceEmitter();

    // Should not throw
    emitter.emit({
      type: "enforcement",
      timestamp: new Date().toISOString(),
      detail: {},
    });
  });

  test("off with non-existent handler is no-op", () => {
    const emitter = createGovernanceEmitter();

    // Should not throw
    emitter.off("enforcement", () => {});
  });

  test("off on type with no listeners is no-op", () => {
    const emitter = createGovernanceEmitter();

    // Should not throw
    emitter.off("kill", () => {});
  });

  test("events carry full detail object", () => {
    const emitter = createGovernanceEmitter();
    let receivedDetail: Record<string, unknown> = {};

    emitter.on("enforcement", (e) => {
      receivedDetail = e.detail;
    });

    emitter.emit({
      type: "enforcement",
      timestamp: "2026-03-09T00:00:00Z",
      agentId: "agent-123",
      detail: {
        blocked: true,
        reason: "Tool blocked",
        ruleId: "block-shell",
        tool: "shell_exec",
      },
    });

    assert.equal(receivedDetail.blocked, true);
    assert.equal(receivedDetail.reason, "Tool blocked");
    assert.equal(receivedDetail.tool, "shell_exec");
  });

  test("type handlers and onAny both fire for same event", () => {
    const emitter = createGovernanceEmitter();
    const received: string[] = [];

    emitter.on("kill", () => received.push("typed"));
    emitter.onAny(() => received.push("any"));

    emitter.emit({
      type: "kill",
      timestamp: new Date().toISOString(),
      agentId: "a1",
      detail: { reason: "emergency" },
    });

    assert.equal(received.length, 2);
    assert.ok(received.includes("typed"));
    assert.ok(received.includes("any"));
  });

  test("same handler added twice only fires once", () => {
    const emitter = createGovernanceEmitter();
    let count = 0;

    const handler = () => count++;

    emitter.on("enforcement", handler);
    emitter.on("enforcement", handler); // Same reference

    emitter.emit({
      type: "enforcement",
      timestamp: new Date().toISOString(),
      detail: {},
    });

    // Set-based storage means same handler is only stored once
    assert.equal(count, 1);
  });
});
