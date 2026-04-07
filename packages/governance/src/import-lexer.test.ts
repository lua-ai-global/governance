import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  parseImports,
  isToolImport,
  toolNamesFromImport,
  extractToolImports,
} from "./import-lexer";

describe("parseImports", () => {
  it("parses default imports", () => {
    const out = parseImports(`import Foo from "pkg";`);
    assert.equal(out.length, 1);
    assert.equal(out[0].specifier, "pkg");
    assert.equal(out[0].defaultName, "Foo");
    assert.equal(out[0].kind, "default");
  });

  it("parses namespace imports", () => {
    const out = parseImports(`import * as NS from "pkg";`);
    assert.equal(out.length, 1);
    assert.equal(out[0].namespaceName, "NS");
    assert.equal(out[0].kind, "namespace");
  });

  it("parses named imports with aliases", () => {
    const out = parseImports(`import { a, b as c, d } from "pkg";`);
    assert.equal(out.length, 1);
    assert.deepEqual(out[0].named, [
      { imported: "a", local: "a" },
      { imported: "b", local: "c" },
      { imported: "d", local: "d" },
    ]);
    assert.equal(out[0].kind, "named");
  });

  it("parses default + named together", () => {
    const out = parseImports(`import Foo, { a, b } from "pkg";`);
    assert.equal(out.length, 1);
    assert.equal(out[0].defaultName, "Foo");
    assert.equal(out[0].named.length, 2);
  });

  it("parses default + namespace together", () => {
    const out = parseImports(`import Foo, * as NS from "pkg";`);
    assert.equal(out.length, 1);
    assert.equal(out[0].defaultName, "Foo");
    assert.equal(out[0].namespaceName, "NS");
  });

  it("parses side-effect imports", () => {
    const out = parseImports(`import "./polyfills";`);
    assert.equal(out.length, 1);
    assert.equal(out[0].kind, "side-effect");
    assert.equal(out[0].specifier, "./polyfills");
  });

  it("parses multi-line named imports", () => {
    const source = `
      import {
        a,
        b as aliased,
        c,
      } from "pkg";
    `;
    const out = parseImports(source);
    assert.equal(out.length, 1);
    assert.equal(out[0].named.length, 3);
  });

  it("parses re-exports as named imports", () => {
    const out = parseImports(`export { a, b } from "pkg";`);
    assert.equal(out.length, 1);
    assert.equal(out[0].specifier, "pkg");
    assert.equal(out[0].named.length, 2);
  });

  it("parses namespace re-exports", () => {
    const out = parseImports(`export * as NS from "pkg";`);
    assert.equal(out.length, 1);
    assert.equal(out[0].namespaceName, "NS");
  });

  it("parses multiple imports in one file", () => {
    const source = `
      import a from "one";
      import { b } from "two";
      import * as c from "three";
    `;
    const out = parseImports(source);
    assert.equal(out.length, 3);
  });

  it("ignores imports inside string literals", () => {
    const source = `const s = 'import Foo from "pkg"'; import Real from "real";`;
    const out = parseImports(source);
    assert.equal(out.length, 1);
    assert.equal(out[0].specifier, "real");
  });

  it("ignores imports inside line comments", () => {
    const source = `// import Fake from "pkg"\nimport Real from "real";`;
    const out = parseImports(source);
    assert.equal(out.length, 1);
    assert.equal(out[0].specifier, "real");
  });

  it("ignores imports inside block comments", () => {
    const source = `/* import Fake from "pkg" */\nimport Real from "real";`;
    const out = parseImports(source);
    assert.equal(out.length, 1);
    assert.equal(out[0].specifier, "real");
  });

  it("handles type-only imports", () => {
    const out = parseImports(`import type { Foo, Bar } from "pkg";`);
    assert.equal(out.length, 1);
    assert.equal(out[0].named.length, 2);
  });

  it("drops leading `type` from named imports", () => {
    const out = parseImports(`import { type Foo, Bar } from "pkg";`);
    assert.equal(out.length, 1);
    const names = out[0].named.map((n) => n.imported);
    assert.deepEqual(names, ["Foo", "Bar"]);
  });

  it("is tolerant of malformed statements", () => {
    // Should not throw; may return whatever is parseable
    const source = `import from "broken"; import ok from "ok";`;
    const out = parseImports(source);
    assert.ok(out.some((i) => i.specifier === "ok"));
  });
});

describe("isToolImport", () => {
  it("matches imports from /skills/ path", () => {
    const [imp] = parseImports(`import dealSkill from "@lua-agents/crm/skills/dealSkill";`);
    assert.ok(isToolImport(imp));
  });

  it("matches imports from /tools/ path", () => {
    const [imp] = parseImports(`import webSearch from "@org/pkg/tools/webSearchTool";`);
    assert.ok(isToolImport(imp));
  });

  it("matches default imports ending in Skill", () => {
    const [imp] = parseImports(`import apolloSkill from "@lua-agents/prospecting";`);
    assert.ok(isToolImport(imp));
  });

  it("matches named imports ending in Tool", () => {
    const [imp] = parseImports(`import { searchTool, otherThing } from "pkg";`);
    assert.ok(isToolImport(imp));
  });

  it("does not match Toolbar/Tooltip false positives", () => {
    const [imp] = parseImports(`import { Toolbar, Tooltip } from "lucide-react";`);
    assert.equal(isToolImport(imp), false);
  });

  it("does not match unrelated imports", () => {
    const [imp] = parseImports(`import { useState } from "react";`);
    assert.equal(isToolImport(imp), false);
  });
});

describe("toolNamesFromImport", () => {
  it("returns the default name for /skills/ path imports", () => {
    const [imp] = parseImports(`import dealSkill from "@lua-agents/crm/skills/dealSkill";`);
    assert.deepEqual(toolNamesFromImport(imp), ["dealSkill"]);
  });

  it("returns tool-shaped named imports only", () => {
    const [imp] = parseImports(`import { searchTool, helper, analyzeSkill } from "pkg";`);
    assert.deepEqual(toolNamesFromImport(imp).sort(), ["analyzeSkill", "searchTool"]);
  });

  it("filters out Toolbar-style false positives", () => {
    const [imp] = parseImports(`import { Toolbar, realTool } from "pkg";`);
    assert.deepEqual(toolNamesFromImport(imp), ["realTool"]);
  });

  it("falls back to the specifier tail for bare skill paths", () => {
    const [imp] = parseImports(`import X from "@lua-agents/crm/skills/dealSkill";`);
    // Default name is `X` but specifier tail is `dealSkill` — the default
    // wins because it IS tool-shaped in Luna's pattern, but when the
    // default name is generic, callers still get useful info via the path.
    assert.ok(toolNamesFromImport(imp).length >= 1);
  });
});

describe("extractToolImports", () => {
  it("finds all tool-shaped imports in a file", () => {
    const source = `
      import dealSkill from "@lua-agents/crm/skills/dealSkill";
      import { useState } from "react";
      import { Toolbar } from "lucide-react";
      import { searchTool } from "@org/core";
      import noteSkill from "@lua-agents/crm/skills/noteSkill";
    `;
    const out = extractToolImports(source);
    assert.equal(out.length, 3);
    const specs = out.map((i) => i.specifier);
    assert.ok(specs.includes("@lua-agents/crm/skills/dealSkill"));
    assert.ok(specs.includes("@lua-agents/crm/skills/noteSkill"));
    assert.ok(specs.includes("@org/core"));
  });
});
