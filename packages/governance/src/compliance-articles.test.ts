import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  EU_AI_ACT_ARTICLES,
  getArticles,
  getDaysUntilDeadline,
} from "./compliance-articles";
import type { EuAiActArticle, ArticleRequirement } from "./compliance-articles";

describe("EU_AI_ACT_ARTICLES structure", () => {
  test("has exactly 6 articles", () => {
    assert.equal(EU_AI_ACT_ARTICLES.length, 6);
  });

  test("covers all required article numbers", () => {
    const articleNums = EU_AI_ACT_ARTICLES.map((a) => a.article);
    assert.deepEqual(articleNums, ["9", "11", "12", "14", "15", "50"]);
  });

  test("all articles have required fields", () => {
    for (const art of EU_AI_ACT_ARTICLES) {
      assert.ok(art.article, "Missing article number");
      assert.ok(art.title, `Art. ${art.article} missing title`);
      assert.ok(art.description, `Art. ${art.article} missing description`);
      assert.ok(art.deadline, `Art. ${art.article} missing deadline`);
      assert.ok(art.maxFine, `Art. ${art.article} missing maxFine`);
      assert.ok(art.requirements.length > 0, `Art. ${art.article} has no requirements`);
    }
  });

  test("all deadlines are 2026-08-02", () => {
    for (const art of EU_AI_ACT_ARTICLES) {
      assert.equal(art.deadline, "2026-08-02", `Art. ${art.article} has unexpected deadline`);
    }
  });

  test("all articles have fine information", () => {
    for (const art of EU_AI_ACT_ARTICLES) {
      assert.ok(art.maxFine.includes("EUR") || art.maxFine.includes("turnover"),
        `Art. ${art.article} fine missing EUR or turnover reference`);
    }
  });
});

describe("ArticleRequirement structure", () => {
  const allRequirements = EU_AI_ACT_ARTICLES.flatMap((a) => a.requirements);

  test("has at least 18 total requirements", () => {
    assert.ok(allRequirements.length >= 18, `Only ${allRequirements.length} requirements`);
  });

  test("all requirement IDs are unique", () => {
    const ids = allRequirements.map((r) => r.id);
    assert.equal(ids.length, new Set(ids).size, "Duplicate requirement IDs found");
  });

  test("all requirements have required fields", () => {
    for (const req of allRequirements) {
      assert.ok(req.id, "Missing requirement id");
      assert.ok(req.requirement, `${req.id} missing requirement description`);
      assert.ok(req.sdkFeature, `${req.id} missing sdkFeature`);
      assert.ok(req.checkDescription, `${req.id} missing checkDescription`);
      assert.equal(typeof req.automatable, "boolean", `${req.id} automatable must be boolean`);
    }
  });

  test("requirement IDs follow naming convention (artN-*)", () => {
    for (const req of allRequirements) {
      assert.match(req.id, /^art\d+-.+$/, `${req.id} does not match artN-* pattern`);
    }
  });

  test("most requirements are automatable", () => {
    const automatable = allRequirements.filter((r) => r.automatable).length;
    assert.ok(automatable > allRequirements.length / 2,
      `Only ${automatable}/${allRequirements.length} requirements are automatable`);
  });
});

describe("Article 9 — Risk Management", () => {
  const art9 = EU_AI_ACT_ARTICLES.find((a) => a.article === "9")!;

  test("has 4 requirements", () => {
    assert.equal(art9.requirements.length, 4);
  });

  test("covers risk identification", () => {
    assert.ok(art9.requirements.some((r) => r.id.includes("risk-identification")));
  });

  test("covers risk mitigation", () => {
    assert.ok(art9.requirements.some((r) => r.id.includes("risk-mitigation")));
  });

  test("covers testing", () => {
    const testReq = art9.requirements.find((r) => r.id.includes("testing"));
    assert.ok(testReq);
    assert.equal(testReq!.automatable, false, "Testing requirement should not be automatable");
  });
});

describe("Article 12 — Record-Keeping", () => {
  const art12 = EU_AI_ACT_ARTICLES.find((a) => a.article === "12")!;

  test("has 4 requirements", () => {
    assert.equal(art12.requirements.length, 4);
  });

  test("covers automatic logging", () => {
    assert.ok(art12.requirements.some((r) => r.id.includes("automatic-logging")));
  });

  test("covers integrity (hash chaining)", () => {
    const integrityReq = art12.requirements.find((r) => r.id.includes("integrity"));
    assert.ok(integrityReq);
    assert.ok(integrityReq!.sdkFeature.includes("HMAC"), "Integrity should reference HMAC");
  });

  test("retention is not automatable", () => {
    const retentionReq = art12.requirements.find((r) => r.id.includes("retention"));
    assert.ok(retentionReq);
    assert.equal(retentionReq!.automatable, false);
  });
});

describe("Article 15 — Accuracy, Robustness, Cybersecurity", () => {
  const art15 = EU_AI_ACT_ARTICLES.find((a) => a.article === "15")!;

  test("has 2 requirements", () => {
    assert.equal(art15.requirements.length, 2);
  });

  test("covers resilience", () => {
    assert.ok(art15.requirements.some((r) => r.id.includes("resilience")));
  });

  test("covers security", () => {
    assert.ok(art15.requirements.some((r) => r.id.includes("security")));
  });
});

describe("Article 50 — Transparency", () => {
  const art50 = EU_AI_ACT_ARTICLES.find((a) => a.article === "50")!;

  test("covers AI disclosure", () => {
    assert.ok(art50.requirements.some((r) => r.id.includes("disclosure")));
  });

  test("covers content marking", () => {
    assert.ok(art50.requirements.some((r) => r.id.includes("content-marking")));
  });
});

describe("getArticles()", () => {
  test("returns same data as EU_AI_ACT_ARTICLES", () => {
    assert.deepEqual(getArticles(), EU_AI_ACT_ARTICLES);
  });
});

describe("getDaysUntilDeadline()", () => {
  test("returns a positive number (deadline is 2026-08-02)", () => {
    const days = getDaysUntilDeadline();
    assert.ok(typeof days === "number");
    // As of March 2026, should be ~146 days
    assert.ok(days > 0, `Expected positive days, got ${days}`);
    assert.ok(days < 500, `Expected reasonable days count, got ${days}`);
  });
});
