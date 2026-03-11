/**
 * Adds .js extensions to relative imports in dist/ for Node.js ESM compatibility.
 * Cross-platform (works on macOS and Linux/Vercel).
 */

import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const DIST = new URL("../dist", import.meta.url).pathname;

async function walk(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...await walk(full));
    } else if (entry.name.endsWith(".js")) {
      files.push(full);
    }
  }
  return files;
}

const files = await walk(DIST);
let fixed = 0;

for (const file of files) {
  const content = await readFile(file, "utf-8");
  const updated = content
    .replace(/from "(\.\/[^"]+?)(?<!\.js)"/g, 'from "$1.js"')
    .replace(/import "(\.\/[^"]+?)(?<!\.js)"/g, 'import "$1.js"');

  if (updated !== content) {
    await writeFile(file, updated);
    fixed++;
  }
}

process.stdout.write(`Fixed ESM imports in ${fixed} files\n`);
