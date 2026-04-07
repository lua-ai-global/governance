/**
 * Tests for the scanner-plugin architecture.
 *
 * These tests exercise the extensibility surface — the ScannerPlugin
 * interface, the FileResolver contract, and scanRepoContentsWithPlugins'
 * dispatch / budget / cycle behavior — using inline fake plugins. No
 * framework-specific logic is tested here; that lives in consumer
 * packages (e.g. governance-web) which ship their own plugins.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { scanRepoContentsWithPlugins } from "../repo-patterns";
import type {
  ScannerPlugin,
  ResolvedSource,
  ExpandToolsContext,
} from "./types";

/** A minimal plugin factory for tests. */
function makePlugin(overrides: Partial<ScannerPlugin> = {}): ScannerPlugin {
  return {
    name: "fake",
    ownsImport: () => false,
    expandTools: async () => [],
    ...overrides,
  };
}

describe("scanRepoContentsWithPlugins", () => {
  it("falls through to scanRepoContents when no plugins are active", async () => {
    const files = new Map([
      ["src/index.ts", `import Foo from "@any/thing";`],
    ]);
    const plugin = makePlugin({
      detectFramework: () => false, // plugin opts out
      ownsImport: () => true,
      expandTools: async () => ["should-not-appear"],
    });

    const result = await scanRepoContentsWithPlugins(files, {
      plugins: [plugin],
      resolveFile: async () => null,
    });

    assert.equal(result.tools.includes("should-not-appear"), false);
  });

  it("delegates to the first plugin that claims an import", async () => {
    const files = new Map([
      ["src/index.ts", `import x from "@pkg/thing";`],
    ]);
    const calls: string[] = [];

    const pluginA = makePlugin({
      name: "a",
      ownsImport: () => false,
      expandTools: async () => {
        calls.push("a");
        return [];
      },
    });
    const pluginB = makePlugin({
      name: "b",
      ownsImport: (imp) => imp.specifier === "@pkg/thing",
      expandTools: async () => {
        calls.push("b");
        return ["tool-from-b"];
      },
    });
    const pluginC = makePlugin({
      name: "c",
      ownsImport: () => true, // would also claim, but B is first
      expandTools: async () => {
        calls.push("c");
        return ["tool-from-c"];
      },
    });

    const result = await scanRepoContentsWithPlugins(files, {
      plugins: [pluginA, pluginB, pluginC],
      resolveFile: async (spec) => ({ path: spec, content: "" }),
    });

    assert.deepEqual(calls, ["b"]);
    assert.ok(result.tools.includes("tool-from-b"));
    assert.equal(result.tools.includes("tool-from-c"), false);
  });

  it("passes ExpandToolsContext with resolver for recursive walks", async () => {
    const files = new Map([
      ["src/index.ts", `import container from "@pkg/container";`],
    ]);

    const plugin = makePlugin({
      ownsImport: (imp) => imp.specifier === "@pkg/container",
      expandTools: async (source, ctx: ExpandToolsContext) => {
        // Plugin recurses one level via ctx.resolve
        const child = await ctx.resolve("./child", ctx.fromPath);
        const tools: string[] = [];
        if (source.includes("TOP")) tools.push("top-tool");
        if (child?.content.includes("CHILD")) tools.push("child-tool");
        return tools;
      },
    });

    const result = await scanRepoContentsWithPlugins(files, {
      plugins: [plugin],
      resolveFile: async (spec, fromPath) => {
        if (spec === "@pkg/container") {
          return { path: "resolved/container.ts", content: "TOP" };
        }
        if (spec === "./child" && fromPath === "resolved/container.ts") {
          return { path: "resolved/child.ts", content: "CHILD" };
        }
        return null;
      },
    });

    assert.ok(result.tools.includes("top-tool"));
    assert.ok(result.tools.includes("child-tool"));
  });

  it("deduplicates specifiers across files", async () => {
    const files = new Map([
      ["src/a.ts", `import x from "@pkg/shared";`],
      ["src/b.ts", `import y from "@pkg/shared";`],
    ]);

    let resolveCalls = 0;
    await scanRepoContentsWithPlugins(files, {
      plugins: [
        makePlugin({
          ownsImport: () => true,
          expandTools: async () => [],
        }),
      ],
      resolveFile: async (spec) => {
        resolveCalls++;
        return { path: spec, content: "" };
      },
    });

    assert.equal(resolveCalls, 1);
  });

  it("deduplicates resolved paths when different specifiers alias the same file", async () => {
    const files = new Map([
      ["src/a.ts", `import x from "@pkg/a";`],
      ["src/b.ts", `import y from "@pkg/b";`],
    ]);

    let expandCalls = 0;
    await scanRepoContentsWithPlugins(files, {
      plugins: [
        makePlugin({
          ownsImport: () => true,
          expandTools: async () => {
            expandCalls++;
            return [];
          },
        }),
      ],
      // Both specifiers resolve to the SAME file path — e.g. a symlinked
      // index. The scanner should only expand once.
      resolveFile: async () => ({ path: "shared/index.ts", content: "" }),
    });

    assert.equal(expandCalls, 1);
  });

  it("respects maxResolves across plugin calls", async () => {
    const imports = Array.from(
      { length: 10 },
      (_, i) => `import s${i} from "@pkg/s${i}";`,
    ).join("\n");
    const files = new Map([["src/index.ts", imports]]);

    let resolveCount = 0;
    await scanRepoContentsWithPlugins(files, {
      maxResolves: 4,
      plugins: [
        makePlugin({
          ownsImport: () => true,
          expandTools: async () => [],
        }),
      ],
      resolveFile: async (spec) => {
        resolveCount++;
        return { path: spec, content: "" };
      },
    });

    assert.equal(resolveCount, 4);
  });

  it("survives plugin throwing during expandTools", async () => {
    const files = new Map([
      ["src/a.ts", `import x from "@pkg/boom";`],
      ["src/b.ts", `import y from "@pkg/ok";`],
    ]);

    const result = await scanRepoContentsWithPlugins(files, {
      plugins: [
        makePlugin({
          ownsImport: () => true,
          expandTools: async (source) => {
            if (source === "BOOM") throw new Error("plugin error");
            return ["ok-tool"];
          },
        }),
      ],
      resolveFile: async (spec) => ({
        path: spec,
        content: spec.endsWith("boom") ? "BOOM" : "OK",
      }),
    });

    // The good plugin still contributes its tools
    assert.ok(result.tools.includes("ok-tool"));
  });

  it("survives resolver throwing", async () => {
    const files = new Map([
      ["src/a.ts", `import x from "@pkg/boom";`],
      ["src/b.ts", `import y from "@pkg/ok";`],
    ]);

    const result = await scanRepoContentsWithPlugins(files, {
      plugins: [
        makePlugin({
          ownsImport: () => true,
          expandTools: async () => ["ok-tool"],
        }),
      ],
      resolveFile: async (spec) => {
        if (spec === "@pkg/boom") throw new Error("network");
        return { path: spec, content: "" };
      },
    });

    assert.ok(result.tools.includes("ok-tool"));
  });

  it("merges expanded tools with tools found by the generic scanner", async () => {
    // Inline tool definitions are found by scanRepoContents
    const files = new Map([
      ["src/index.ts", `
        import container from "@pkg/container";
        const local = createTool("local_tool", {});
      `],
    ]);

    const result = await scanRepoContentsWithPlugins(files, {
      plugins: [
        makePlugin({
          ownsImport: (imp) => imp.specifier.startsWith("@pkg/"),
          expandTools: async () => ["expanded_tool"],
        }),
      ],
      resolveFile: async (spec) => ({ path: spec, content: "" }),
    });

    assert.ok(result.tools.includes("local_tool"));
    assert.ok(result.tools.includes("expanded_tool"));
  });
});
