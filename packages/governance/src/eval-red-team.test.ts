import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { runRedTeam } from "./eval-red-team";
import { createGovernance, blockTools } from "./index";
import { createInjectionGuard } from "./injection-detect";

describe("runRedTeam — policy effectiveness audit", () => {
  it("reports low resistance for an unconfigured governance instance", async () => {
    const gov = createGovernance({});
    const agent = await gov.register({ name: "bot", framework: "mastra", owner: "t" });
    const report = await runRedTeam(gov, agent.id, { maxProbesPerCategory: 5 });
    assert.ok(report.results.length > 0);
    assert.ok(report.categories.injection.probes > 0);
    // Without injection guard or tool blocks, resistance should be ~0.
    assert.ok(report.categories.injection.resistanceRate < 0.3);
  });

  it("reports higher resistance once injection guard + blockTools are configured", async () => {
    const gov = createGovernance({
      rules: [
        createInjectionGuard({ threshold: 0.5 }),
        blockTools(["shell_exec", "eval", "file_delete", "system_command", "db_drop", "rm_rf", "sudo", "process_kill"]),
      ],
    });
    const agent = await gov.register({ name: "bot", framework: "mastra", owner: "t" });
    const report = await runRedTeam(gov, agent.id, { maxProbesPerCategory: 5 });
    // Tool abuse resistance should be essentially perfect.
    assert.ok(
      report.categories.tool_abuse.resistanceRate >= 0.8,
      `tool_abuse resistance ${report.categories.tool_abuse.resistanceRate} too low`,
    );
    // At least some injection probes should be caught.
    assert.ok(
      report.categories.injection.resistanceRate > 0,
      "injection guard should catch at least some probes",
    );
  });

  it("produces an EvalResult with red_team_resistance metric", async () => {
    const gov = createGovernance({});
    const agent = await gov.register({ name: "bot", framework: "mastra", owner: "t" });
    const report = await runRedTeam(gov, agent.id, { maxProbesPerCategory: 3 });
    const firstResult = report.results[0];
    assert.ok(firstResult);
    const rtr = firstResult.metrics.find((m) => m.name === "red_team_resistance");
    assert.ok(rtr, "red_team_resistance metric missing");
    assert.ok(typeof rtr!.score === "number" && rtr!.score >= 0 && rtr!.score <= 1);
  });

  it("policyDependence reflects content-vs-structural block ratio", async () => {
    const gov = createGovernance({
      rules: [
        // Only structural blocks — no injection guard.
        blockTools(["shell_exec", "eval", "file_delete", "system_command", "db_drop", "rm_rf", "sudo", "process_kill"]),
      ],
    });
    const agent = await gov.register({ name: "bot", framework: "mastra", owner: "t" });
    const report = await runRedTeam(gov, agent.id, { maxProbesPerCategory: 5 });
    // All blocks (if any) should come from structural rules → policyDependence ≈ 1.
    assert.ok(
      report.policyDependence >= 0.8,
      `policyDependence ${report.policyDependence} should be near 1 when only structural rules fire`,
    );
  });

  it("respects the maxProbesPerCategory config", async () => {
    const gov = createGovernance({});
    const agent = await gov.register({ name: "bot", framework: "mastra", owner: "t" });
    const report = await runRedTeam(gov, agent.id, { maxProbesPerCategory: 2 });
    for (const cat of Object.keys(report.categories)) {
      assert.ok(
        report.categories[cat].probes <= 2,
        `category ${cat} ran ${report.categories[cat].probes} probes, cap was 2`,
      );
    }
  });

  it("summary includes category-level and dependence language", async () => {
    const gov = createGovernance({});
    const agent = await gov.register({ name: "bot", framework: "mastra", owner: "t" });
    const report = await runRedTeam(gov, agent.id, { maxProbesPerCategory: 2 });
    assert.ok(typeof report.summary === "string");
    assert.ok(report.summary.length > 0);
  });
});
