/**
 * Score inflation adversarial tests.
 *
 * The 7-dimension scorer accepts self-reported booleans (`hasAuth`,
 * `hasGuardrails`, `hasObservability`, `hasAuditLog`). An agent CAN claim
 * all four are `true` with zero supporting code — if you don't cross-check
 * against the repo, you're scoring a checkbox questionnaire, not reality.
 *
 * These tests document the risk and show the cross-check pattern using
 * `scanRepoContents`, which reads actual source and reports per-capability
 * detection + confidence.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { assessAgent } from "./scorer";
import { scanRepoContents } from "./repo-patterns";

describe("scorer — score-inflation risk + repo-scan defence", () => {
  it("WARNING: self-reported booleans are accepted at face value (inflation risk)", () => {
    // An agent that lies about its capabilities scores just as highly as
    // one that actually has them, because the scorer trusts the caller.
    // This is a documented limitation of the default scoring path.
    const lying = assessAgent("fake", {
      name: "fake",
      framework: "mastra",
      owner: "you",
      description: "I swear I have all the controls",
      hasAuth: true,
      hasGuardrails: true,
      hasObservability: true,
      hasAuditLog: true,
    });
    const honest = assessAgent("real", {
      name: "real",
      framework: "mastra",
      owner: "you",
      description: "The same claims, but I actually have them",
      hasAuth: true,
      hasGuardrails: true,
      hasObservability: true,
      hasAuditLog: true,
    });
    // Scores are identical because input is identical.
    assert.equal(lying.compositeScore, honest.compositeScore);
  });

  it("repo-scan reveals the gap: empty repo returns low-confidence detections", () => {
    // When the caller feeds an empty file map, no imports match, so no
    // capability is detected above the 0.4 confidence threshold.
    const scan = scanRepoContents(new Map());
    for (const d of scan.detections) {
      assert.equal(d.detected, false, `empty repo should not detect ${d.capability}`);
      assert.ok(d.confidence < 0.4, `confidence ${d.confidence} for ${d.capability} should be < 0.4`);
    }
  });

  it("repo-scan confirms honest claims: real auth+guardrails imports are detected", () => {
    const files = new Map<string, string>([
      [
        "package.json",
        JSON.stringify({ dependencies: { "@clerk/nextjs": "^5.0.0", "@lua/governance": "^0.9.0" } }),
      ],
      [
        "middleware.ts",
        "import { clerkMiddleware } from '@clerk/nextjs/server';\nimport { createGovernance } from '@lua/governance';\nexport default clerkMiddleware();\n",
      ],
    ]);
    const scan = scanRepoContents(files);
    const auth = scan.detections.find((d) => d.capability === "hasAuth");
    const guardrails = scan.detections.find((d) => d.capability === "hasGuardrails");
    assert.ok(auth?.detected, "auth should be detected from @clerk imports");
    assert.ok(guardrails?.detected, "guardrails should be detected from @lua/governance");
  });

  it("a fraud detector: flag agents whose self-report disagrees with repo-scan", () => {
    // This is the cross-check pattern callers should run in CI. Claim
    // `hasAuth: true` without any auth imports in the repo = inflation.
    const selfReport = {
      hasAuth: true,
      hasGuardrails: true,
      hasObservability: true,
      hasAuditLog: true,
    };
    const scan = scanRepoContents(new Map()); // empty = no evidence

    const mismatches: string[] = [];
    for (const d of scan.detections) {
      if (selfReport[d.capability] && !d.detected) {
        mismatches.push(
          `agent claims ${d.capability}=true but repo scan shows detected=false (confidence ${d.confidence.toFixed(2)})`,
        );
      }
    }
    // All four should mismatch → inflation caught.
    assert.equal(mismatches.length, 4, `expected 4 mismatches, got: ${mismatches.join("; ")}`);
  });
});
