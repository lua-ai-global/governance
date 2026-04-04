import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { MIGRATIONS } from "./migrations.js";

describe("platform exports", () => {
  test("createPlatformStorage is a function", async () => {
    const mod = await import("./index.js");
    assert.equal(typeof mod.createPlatformStorage, "function");
  });

  test("MIGRATIONS array is non-empty and ordered", () => {
    assert.ok(MIGRATIONS.length > 0, "should have at least one migration");
    for (let i = 1; i < MIGRATIONS.length; i++) {
      assert.ok(
        MIGRATIONS[i].id > MIGRATIONS[i - 1].id,
        `migration ${MIGRATIONS[i].id} should follow ${MIGRATIONS[i - 1].id}`,
      );
    }
  });

  test("each migration has required fields", () => {
    for (const m of MIGRATIONS) {
      assert.equal(typeof m.id, "number");
      assert.equal(typeof m.name, "string");
      assert.equal(typeof m.sql, "string");
      assert.ok(m.sql.length > 0, `migration ${m.id} sql should not be empty`);
    }
  });
});
