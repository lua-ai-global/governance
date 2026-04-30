import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  scanMultiModal,
  registerModalityScanner,
  unregisterModalityScanner,
  clearModalityScanners,
  hasModalityScanner,
  getModalityScanner,
  isFailClosed,
  type ContentBlock,
  type ModalityScanner,
} from "./multi-modal.js";

describe("scanMultiModal", () => {
  beforeEach(() => clearModalityScanners());
  afterEach(() => clearModalityScanners());

  // ─── Defaults ─────────────────────────────────────────────────

  test("default enabled is text-only — image/pdf/audio blocks are skipped", async () => {
    const blocks: ContentBlock[] = [
      { modality: "text", text: "hello" },
      { modality: "image", data: { url: "https://x" } },
      { modality: "pdf", data: { bytes: new Uint8Array() } },
      { modality: "audio", data: { wav: new Uint8Array() } },
    ];

    const result = await scanMultiModal(blocks);

    assert.equal(result.text, "hello");
    assert.deepEqual(result.modalitiesScanned, ["text"]);
    assert.equal(result.modalitiesSkipped.length, 3);
    assert.equal(result.blocked.length, 0);
    for (const skip of result.modalitiesSkipped) {
      assert.equal(skip.reason, "not_enabled");
    }
  });

  test("text-only payload joins with double-newline", async () => {
    const result = await scanMultiModal([
      { modality: "text", text: "first" },
      { modality: "text", text: "second" },
    ]);
    assert.equal(result.text, "first\n\nsecond");
    assert.deepEqual(result.modalitiesScanned, ["text"]);
  });

  test("empty text blocks are dropped", async () => {
    const result = await scanMultiModal([
      { modality: "text", text: "" },
      { modality: "text", text: "real content" },
    ]);
    assert.equal(result.text, "real content");
  });

  // ─── Opt-in ───────────────────────────────────────────────────

  test("registered image scanner runs when image modality is enabled", async () => {
    registerModalityScanner("image", {
      extractText: async (block) =>
        `OCR(${(block as { url: string }).url})`,
    });

    const result = await scanMultiModal(
      [
        { modality: "text", text: "user prompt" },
        { modality: "image", data: { url: "image-1.png" } },
      ],
      { enabled: ["text", "image"] },
    );

    assert.equal(result.text, "user prompt\n\nOCR(image-1.png)");
    assert.deepEqual(
      result.modalitiesScanned.sort(),
      ["image", "text"],
    );
    assert.equal(result.blocked.length, 0);
  });

  test("Set-based enabled is equivalent to array-based", async () => {
    registerModalityScanner("pdf", {
      extractText: async () => "pdf-text",
    });

    const arrayResult = await scanMultiModal(
      [{ modality: "pdf", data: {} }],
      { enabled: ["pdf"] },
    );
    const setResult = await scanMultiModal(
      [{ modality: "pdf", data: {} }],
      { enabled: new Set(["pdf"]) },
    );

    assert.equal(arrayResult.text, setResult.text);
    assert.equal(arrayResult.text, "pdf-text");
  });

  // ─── Failure modes ────────────────────────────────────────────

  test("enabled modality with no scanner ends up in blocked[]", async () => {
    const result = await scanMultiModal(
      [{ modality: "image", data: {} }],
      { enabled: ["text", "image"] },
    );

    assert.equal(result.modalitiesScanned.length, 0);
    assert.equal(result.blocked.length, 1);
    assert.equal(result.blocked[0].modality, "image");
    assert.equal(result.blocked[0].reason, "no_scanner");
  });

  test("scanner that throws ends up in blocked[] with extract_error", async () => {
    registerModalityScanner("image", {
      extractText: async () => {
        throw new Error("boom");
      },
    });

    const result = await scanMultiModal(
      [{ modality: "image", data: {} }],
      { enabled: ["image"] },
    );

    assert.equal(result.blocked.length, 1);
    assert.equal(result.blocked[0].reason, "extract_error");
    assert.equal(result.blocked[0].detail, "boom");
  });

  test("scanner that synchronously throws ends up in blocked[] with extract_error", async () => {
    registerModalityScanner("image", {
      extractText: ((() => {
        throw new Error("sync boom");
      }) as unknown) as ModalityScanner["extractText"],
    });

    const result = await scanMultiModal(
      [{ modality: "image", data: {} }],
      { enabled: ["image"] },
    );

    assert.equal(result.blocked.length, 1);
    assert.equal(result.blocked[0].reason, "extract_error");
    assert.equal(result.blocked[0].detail, "sync boom");
  });

  test("scanner that returns null ends up in blocked[] with extract_empty", async () => {
    registerModalityScanner("image", {
      extractText: async () => null,
    });

    const result = await scanMultiModal(
      [{ modality: "image", data: {} }],
      { enabled: ["image"] },
    );

    assert.equal(result.blocked.length, 1);
    assert.equal(result.blocked[0].reason, "extract_empty");
  });

  test("scanner returning non-string ends up in blocked[] with extract_error", async () => {
    registerModalityScanner("image", {
      // Force a non-string return value through the type system to test
      // runtime defence against badly-implemented scanners.
      extractText: (async () => 42) as unknown as ModalityScanner["extractText"],
    });

    const result = await scanMultiModal(
      [{ modality: "image", data: {} }],
      { enabled: ["image"] },
    );

    assert.equal(result.blocked.length, 1);
    assert.equal(result.blocked[0].reason, "extract_error");
    assert.match(result.blocked[0].detail ?? "", /non-string/);
  });

  test("scanner that hangs is reaped by timeoutMs", async () => {
    registerModalityScanner("image", {
      extractText: () =>
        new Promise<string>(() => {
          // never resolves
        }),
    });

    const result = await scanMultiModal(
      [{ modality: "image", data: {} }],
      { enabled: ["image"], timeoutMs: 50 },
    );

    assert.equal(result.blocked.length, 1);
    assert.equal(result.blocked[0].reason, "extract_timeout");
  });

  // ─── isFailClosed ─────────────────────────────────────────────

  test("isFailClosed is false on a clean result", () => {
    const ok = isFailClosed({
      text: "x",
      modalitiesScanned: ["text"],
      modalitiesSkipped: [],
      blocked: [],
      durationMs: 0,
    });
    assert.equal(ok, false);
  });

  test("isFailClosed honors onMissingScanner=block", () => {
    const result = {
      text: "",
      modalitiesScanned: [],
      modalitiesSkipped: [],
      blocked: [{ modality: "image" as const, reason: "no_scanner" as const }],
      durationMs: 0,
    };
    assert.equal(isFailClosed(result, { onMissingScanner: "skip" }), false);
    assert.equal(isFailClosed(result, { onMissingScanner: "block" }), true);
  });

  test("isFailClosed honors onExtractError=block for non-no_scanner reasons", () => {
    const errorResult = {
      text: "",
      modalitiesScanned: [],
      modalitiesSkipped: [],
      blocked: [
        { modality: "pdf" as const, reason: "extract_error" as const },
      ],
      durationMs: 0,
    };
    const timeoutResult = {
      text: "",
      modalitiesScanned: [],
      modalitiesSkipped: [],
      blocked: [
        { modality: "audio" as const, reason: "extract_timeout" as const },
      ],
      durationMs: 0,
    };
    assert.equal(isFailClosed(errorResult, { onExtractError: "skip" }), false);
    assert.equal(isFailClosed(errorResult, { onExtractError: "block" }), true);
    assert.equal(isFailClosed(timeoutResult, { onExtractError: "block" }), true);
  });

  test("isFailClosed: error and missing reasons are gated independently", () => {
    const mixed = {
      text: "",
      modalitiesScanned: [],
      modalitiesSkipped: [],
      blocked: [
        { modality: "image" as const, reason: "no_scanner" as const },
        { modality: "pdf" as const, reason: "extract_error" as const },
      ],
      durationMs: 0,
    };
    // Only error gated → still fail-closed (the pdf row triggers it)
    assert.equal(
      isFailClosed(mixed, { onMissingScanner: "skip", onExtractError: "block" }),
      true,
    );
    // Only missing gated → still fail-closed (the image row triggers it)
    assert.equal(
      isFailClosed(mixed, { onMissingScanner: "block", onExtractError: "skip" }),
      true,
    );
  });
});

describe("modality scanner registry", () => {
  beforeEach(() => clearModalityScanners());

  test("hasModalityScanner reflects registration", () => {
    assert.equal(hasModalityScanner("image"), false);
    registerModalityScanner("image", { extractText: async () => "ok" });
    assert.equal(hasModalityScanner("image"), true);
  });

  test("getModalityScanner returns the registered instance", () => {
    const scanner: ModalityScanner = { extractText: async () => "ok" };
    registerModalityScanner("pdf", scanner);
    assert.equal(getModalityScanner("pdf"), scanner);
    assert.equal(getModalityScanner("image"), null);
  });

  test("unregisterModalityScanner removes a single registration", () => {
    registerModalityScanner("image", { extractText: async () => "i" });
    registerModalityScanner("pdf", { extractText: async () => "p" });

    unregisterModalityScanner("image");

    assert.equal(hasModalityScanner("image"), false);
    assert.equal(hasModalityScanner("pdf"), true);
  });

  test("registering twice replaces the prior scanner", async () => {
    registerModalityScanner("image", { extractText: async () => "first" });
    registerModalityScanner("image", { extractText: async () => "second" });

    const result = await scanMultiModal(
      [{ modality: "image", data: {} }],
      { enabled: ["image"] },
    );
    assert.equal(result.text, "second");
  });

  test("clearModalityScanners empties the registry", () => {
    registerModalityScanner("image", { extractText: async () => "ok" });
    registerModalityScanner("pdf", { extractText: async () => "ok" });

    clearModalityScanners();

    assert.equal(hasModalityScanner("image"), false);
    assert.equal(hasModalityScanner("pdf"), false);
  });
});
