#!/usr/bin/env node
/**
 * sync-readme.mjs — Sync packages/governance/README.md from the repo-root README.
 *
 * Why: npm publishes the package-local README (the one inside packages/governance/),
 * not the repo-root one. Without sync, npm users see a stale doc. This script
 * runs in `prepublishOnly` so every release ships an in-sync README, and is
 * also enforced in CI to catch drift on PRs.
 *
 * Transforms repo-relative links into absolute GitHub URLs so they resolve
 * correctly when read on npmjs.com (where there's no monorepo context).
 *
 * Idempotent — running twice is a no-op.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const REPO = "lua-ai-global/governance";
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(ROOT, "README.md");
const DST = join(ROOT, "packages", "governance", "README.md");

const root = readFileSync(SRC, "utf8");

// Map repo-relative links → absolute GitHub URLs. Order matters: more
// specific patterns first so they don't get clobbered by broader ones.
const transforms = [
  // Directory references (use /tree/main/)
  [/\]\(\.\/packages\/governance\)/g, `](https://github.com/${REPO}/tree/main/packages/governance)`],
  [/\]\(\.\/packages\/governance-platform\)/g, `](https://github.com/${REPO}/tree/main/packages/governance-platform)`],
  // File references inside packages (use /blob/main/)
  [/\]\(\.\/packages\/([^)]+)\)/g, `](https://github.com/${REPO}/blob/main/packages/$1)`],
  // Top-level files
  [/\]\(\.\/LICENSE\)/g, `](https://github.com/${REPO}/blob/main/LICENSE)`],
  [/\]\(\.\/CONTRIBUTING\.md\)/g, `](https://github.com/${REPO}/blob/main/CONTRIBUTING.md)`],
  [/\]\(\.\/SECURITY\.md\)/g, `](https://github.com/${REPO}/blob/main/SECURITY.md)`],
  [/\]\(\.\/CODE_OF_CONDUCT\.md\)/g, `](https://github.com/${REPO}/blob/main/CODE_OF_CONDUCT.md)`],
];

let synced = root;
for (const [pattern, replacement] of transforms) {
  synced = synced.replace(pattern, replacement);
}

// Sanity check: any remaining `](./` link is suspicious — flag but don't fail.
const stragglers = synced.match(/\]\(\.\/[^)]+\)/g);
if (stragglers) {
  console.warn(`[sync-readme] WARNING: ${stragglers.length} relative link(s) remain unconverted:`);
  for (const s of stragglers) console.warn(`  ${s}`);
  console.warn("[sync-readme] Add a transform rule in scripts/sync-readme.mjs if these should be absolute.");
}

writeFileSync(DST, synced);
console.log(`[sync-readme] Wrote ${synced.length} bytes to packages/governance/README.md`);
