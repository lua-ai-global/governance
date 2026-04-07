import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { detectAgentRoots, findPackageJsonPaths } from "./monorepo-detect";

describe("findPackageJsonPaths", () => {
  it("returns only package.json files outside ignored dirs", () => {
    const files = [
      "package.json",
      "packages/foo/package.json",
      "node_modules/x/package.json",
      "dist/package.json",
      ".next/package.json",
      "src/index.ts",
    ];
    assert.deepEqual(
      findPackageJsonPaths(files).sort(),
      ["package.json", "packages/foo/package.json"],
    );
  });
});

describe("detectAgentRoots", () => {
  it("detects an agent with lua-cli in dependencies", () => {
    const pkgs = new Map([
      [
        "agents/luna/package.json",
        JSON.stringify({
          name: "luna-agent",
          dependencies: { "lua-cli": "^3.0.0" },
        }),
      ],
    ]);
    const roots = detectAgentRoots(pkgs);
    assert.equal(roots.length, 1);
    // `-agent` suffix is stripped because scaffolding tools append it
    // to every package name and it adds no information.
    assert.equal(roots[0].name, "luna");
    assert.equal(roots[0].framework, "lua");
  });

  it("strips trailing -agent suffix from display names", () => {
    const pkgs = new Map([
      [
        "agents/clio/package.json",
        JSON.stringify({
          name: "clio-agent",
          dependencies: { "lua-cli": "^3.0.0" },
        }),
      ],
    ]);
    assert.equal(detectAgentRoots(pkgs)[0].name, "clio");
  });

  it("does not strip -agent if it would leave an empty name", () => {
    const pkgs = new Map([
      [
        "agents/root/package.json",
        JSON.stringify({
          name: "-agent",
          dependencies: { "lua-cli": "^3.0.0" },
        }),
      ],
    ]);
    assert.equal(detectAgentRoots(pkgs)[0].name, "-agent");
  });

  it("does NOT count packages where the framework is only a peerDependency", () => {
    // Skill / tool libraries declare lua-cli as a peer dep so they
    // don't pin a version. They are NOT agents.
    const pkgs = new Map([
      [
        "packages/crm/package.json",
        JSON.stringify({
          name: "@lua-agents/crm",
          peerDependencies: { "lua-cli": ">=3.0.0" },
          devDependencies: { "lua-cli": "^3.7.3" },
          dependencies: { zod: "^3.0.0" },
        }),
      ],
    ]);
    const roots = detectAgentRoots(pkgs);
    assert.equal(roots.length, 0);
  });

  it("does NOT count packages where the framework is only a devDependency", () => {
    const pkgs = new Map([
      [
        "packages/test-utils/package.json",
        JSON.stringify({
          name: "@lua-agents/test-utils",
          devDependencies: { "lua-cli": "^3.0.0" },
        }),
      ],
    ]);
    assert.equal(detectAgentRoots(pkgs).length, 0);
  });

  it("strips the @scope/ prefix from display names", () => {
    const pkgs = new Map([
      [
        "agents/the-watcher/package.json",
        JSON.stringify({
          name: "@lua-agents/the-watcher",
          dependencies: { "lua-cli": "^3.0.0" },
        }),
      ],
    ]);
    const roots = detectAgentRoots(pkgs);
    assert.equal(roots[0].name, "the-watcher");
  });

  it("falls back to the directory basename when name is missing", () => {
    const pkgs = new Map([
      [
        "agents/iris/package.json",
        JSON.stringify({
          dependencies: { "lua-cli": "^3.0.0" },
        }),
      ],
    ]);
    const roots = detectAgentRoots(pkgs);
    assert.equal(roots[0].name, "iris");
  });

  it("filters real lua-agents-like monorepo down to just the agents", () => {
    const pkgs = new Map([
      // 7 actual agents
      ["agents/luna/package.json", JSON.stringify({ name: "luna-agent", dependencies: { "lua-cli": "^3.0.0" } })],
      ["agents/bob/package.json", JSON.stringify({ name: "bob-agent", dependencies: { "lua-cli": "^3.0.0" } })],
      ["agents/clio/package.json", JSON.stringify({ name: "clio-agent", dependencies: { "lua-cli": "^3.0.0" } })],
      ["agents/iris/package.json", JSON.stringify({ name: "iris-agent", dependencies: { "lua-cli": "^3.0.0" } })],
      ["agents/nova/package.json", JSON.stringify({ name: "nova-agent", dependencies: { "lua-cli": "^3.0.0" } })],
      ["agents/crm-test/package.json", JSON.stringify({ name: "crm-test-agent", dependencies: { "lua-cli": "^3.0.0" } })],
      ["agents/the-watcher/package.json", JSON.stringify({ name: "@lua-agents/the-watcher", dependencies: { "lua-cli": "^3.0.0" } })],
      // 4 skill/tool libraries — should NOT be counted
      ["packages/crm/package.json", JSON.stringify({ name: "@lua-agents/crm", peerDependencies: { "lua-cli": ">=3.0.0" }, dependencies: { zod: "^3.0.0" } })],
      ["packages/communication/package.json", JSON.stringify({ name: "@lua-agents/communication", peerDependencies: { "lua-cli": ">=3.0.0" } })],
      ["packages/research/package.json", JSON.stringify({ name: "@lua-agents/research", peerDependencies: { "lua-cli": ">=3.0.0" } })],
      ["packages/types/package.json", JSON.stringify({ name: "@lua-agents/types" })],
    ]);
    const roots = detectAgentRoots(pkgs);
    assert.equal(roots.length, 7);
    const names = roots.map((r) => r.name).sort();
    assert.deepEqual(names, [
      "bob",
      "clio",
      "crm-test",
      "iris",
      "luna",
      "nova",
      "the-watcher",
    ]);
  });

  it("ignores invalid JSON without throwing", () => {
    const pkgs = new Map([
      ["agents/broken/package.json", "{ not json"],
      ["agents/ok/package.json", JSON.stringify({ name: "ok", dependencies: { "lua-cli": "^3.0.0" } })],
    ]);
    const roots = detectAgentRoots(pkgs);
    assert.equal(roots.length, 1);
    assert.equal(roots[0].name, "ok");
  });

  it("removes parent roots when child packages are also detected", () => {
    const pkgs = new Map([
      ["package.json", JSON.stringify({ name: "monorepo", dependencies: { "lua-cli": "^3.0.0" } })],
      ["agents/luna/package.json", JSON.stringify({ name: "luna-agent", dependencies: { "lua-cli": "^3.0.0" } })],
    ]);
    const roots = detectAgentRoots(pkgs);
    // The root "." is dropped when child packages exist
    assert.ok(!roots.some((r) => r.path === "."));
    assert.ok(roots.some((r) => r.path === "agents/luna"));
  });
});
