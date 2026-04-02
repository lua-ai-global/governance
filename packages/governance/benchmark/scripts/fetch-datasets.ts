#!/usr/bin/env npx tsx
/**
 * Fetch ALL accessible injection detection datasets from HuggingFace.
 *
 * Features:
 * - Saves incrementally (each source written as soon as it completes)
 * - Resumes from where it left off (skips sources that already have data)
 * - Parallel fetching (3 sources at a time)
 * - Retry with backoff on 429s
 * - Only uses properly licensed datasets (MIT, Apache 2.0, CC-BY-SA)
 */

import { writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const DATA_DIR = join(import.meta.dirname, "..", "data");
mkdirSync(DATA_DIR, { recursive: true });

function loadHfToken(): string | undefined {
  if (process.env.HF_TOKEN) return process.env.HF_TOKEN;
  try {
    const envPath = join(import.meta.dirname, "..", "..", "..", "..", "..", "governance-cloud", ".env");
    const lines = readFileSync(envPath, "utf-8").split("\n");
    for (const line of lines) {
      if (line.startsWith("HF_TOKEN=")) return line.slice(9).trim();
    }
  } catch {}
  return undefined;
}

const HF_TOKEN = loadHfToken();

interface RawSample { text: string; label: "injection" | "benign"; source: string; category?: string; }

// ─── Fetch with retry ───────────────────────────────────────

async function fetchHF(repo: string, config: string, split: string, max: number = 50000): Promise<unknown[]> {
  const PAGE = 100;
  const rows: unknown[] = [];
  let offset = 0;
  const headers: Record<string, string> = { "User-Agent": "lua-governance-benchmark/1.0" };
  if (HF_TOKEN) headers["Authorization"] = `Bearer ${HF_TOKEN}`;

  process.stdout.write(`    ${repo}/${split} `);

  while (rows.length < max) {
    const url = `https://datasets-server.huggingface.co/rows?dataset=${encodeURIComponent(repo)}&config=${encodeURIComponent(config)}&split=${encodeURIComponent(split)}&offset=${offset}&length=${PAGE}`;

    let retries = 3;
    while (retries > 0) {
      try {
        const res = await fetch(url, { headers });
        if (res.status === 429) {
          retries--;
          if (retries === 0) { process.stdout.write("[429×3] "); break; }
          process.stdout.write("w");
          await new Promise((r) => setTimeout(r, 5000 + Math.random() * 5000));
          continue;
        }
        if (!res.ok) { process.stdout.write(`[${res.status}] `); retries = 0; break; }
        const data = await res.json() as { rows?: Array<{ row: Record<string, unknown> }> };
        const page = (data.rows ?? []).map((r) => r.row);
        if (page.length === 0) { retries = 0; break; }
        rows.push(...page);
        offset += page.length;
        process.stdout.write(".");
        if (page.length < PAGE) { retries = 0; break; }
        // Tiny delay between pages
        await new Promise((r) => setTimeout(r, 200));
        break; // success, exit retry loop
      } catch {
        retries--;
        if (retries === 0) break;
        await new Promise((r) => setTimeout(r, 3000));
      }
    }
    if (retries === 0) break;
  }
  console.log(` ${rows.length}`);
  return rows;
}

function outputPath(source: string): string {
  return join(DATA_DIR, `raw-${source.replace(/\//g, "_")}.jsonl`);
}

function alreadyFetched(source: string): number {
  const path = outputPath(source);
  if (!existsSync(path)) return 0;
  const lines = readFileSync(path, "utf-8").trim().split("\n").filter(Boolean);
  return lines.length;
}

function saveSamples(samples: RawSample[], source: string): void {
  if (samples.length === 0) return;
  const path = outputPath(source);
  writeFileSync(path, samples.map((s) => JSON.stringify(s)).join("\n") + "\n");
  console.log(`    ✓ Saved ${samples.length} → ${path.split("/").pop()}`);
}

// ─── Source definitions ─────────────────────────────────────

interface Source { name: string; source: string; license: string; fn: () => Promise<RawSample[]>; }

const SOURCES: Source[] = [
  // ─── ATTACK DATASETS (MIT / Apache 2.0) ─────────────────
  { name: "deepset", source: "deepset/prompt-injections", license: "Apache-2.0", fn: async () => {
    const s: RawSample[] = [];
    for (const split of ["train", "test"]) {
      for (const r of await fetchHF("deepset/prompt-injections", "default", split) as Array<{ text: string; label: number }>) {
        if (r.text?.length > 5) s.push({ text: r.text.trim(), label: r.label === 1 ? "injection" : "benign", source: "deepset/prompt-injections" });
      }
    }
    return s;
  }},
  { name: "jackhhao", source: "jackhhao/jailbreak-classification", license: "Apache-2.0", fn: async () => {
    const s: RawSample[] = [];
    for (const r of await fetchHF("jackhhao/jailbreak-classification", "default", "train") as Array<{ prompt?: string; text?: string; type?: string }>) {
      const text = r.prompt ?? r.text ?? "";
      if (text.length < 10) continue;
      s.push({ text: text.trim().slice(0, 2000), label: r.type === "jailbreak" ? "injection" : "benign", source: "jackhhao/jailbreak-classification" });
    }
    return s;
  }},
  { name: "neuralchemy", source: "neuralchemy/Prompt-injection-dataset", license: "Apache-2.0", fn: async () => {
    const s: RawSample[] = [];
    for (const split of ["train", "validation", "test"]) {
      for (const r of await fetchHF("neuralchemy/Prompt-injection-dataset", "core", split, 5000) as Array<{ text: string; label: number; category?: string }>) {
        if (r.text?.length > 5) s.push({ text: r.text.trim().slice(0, 2000), label: r.label === 1 ? "injection" : "benign", source: "neuralchemy/Prompt-injection-dataset", category: r.category });
      }
    }
    return s;
  }},
  { name: "lakera", source: "Lakera/mosscap_prompt_injection", license: "MIT", fn: async () => {
    const s: RawSample[] = [];
    for (const split of ["train", "test"]) {
      for (const r of await fetchHF("Lakera/mosscap_prompt_injection", "default", split, 5000) as Array<{ text: string; label: number }>) {
        if (r.text?.length > 5) s.push({ text: r.text.trim().slice(0, 2000), label: r.label === 1 ? "injection" : "benign", source: "Lakera/mosscap_prompt_injection" });
      }
    }
    return s;
  }},
  { name: "spml", source: "reshabhs/SPML", license: "MIT", fn: async () => {
    const s: RawSample[] = [];
    for (const r of await fetchHF("reshabhs/SPML_Chatbot_Prompt_Injection", "default", "train", 5000) as Array<{ "User Prompt"?: string; "Prompt injection"?: number }>) {
      const text = r["User Prompt"] ?? "";
      if (text.length < 10) continue;
      s.push({ text: text.trim().slice(0, 2000), label: r["Prompt injection"] === 1 ? "injection" : "benign", source: "reshabhs/SPML" });
    }
    return s;
  }},
  { name: "walledai", source: "walledai/JailbreakHub", license: "MIT", fn: async () => {
    const s: RawSample[] = [];
    for (const r of await fetchHF("walledai/JailbreakHub", "default", "train", 2000) as Array<{ prompt?: string }>) {
      const text = r.prompt ?? "";
      if (text.length < 10) continue;
      s.push({ text: text.trim().slice(0, 2000), label: "injection", source: "walledai/JailbreakHub" });
    }
    return s;
  }},
  { name: "semantic-router", source: "llm-semantic-router/jailbreak-detection-dataset", license: "Apache-2.0", fn: async () => {
    const s: RawSample[] = [];
    for (const split of ["train", "validation", "test"]) {
      for (const r of await fetchHF("llm-semantic-router/jailbreak-detection-dataset", "default", split, 3000) as Array<{ text: string; label: number }>) {
        if (r.text?.length > 5) s.push({ text: r.text.trim().slice(0, 2000), label: r.label === 1 ? "injection" : "benign", source: "llm-semantic-router/jailbreak-detection-dataset" });
      }
    }
    return s;
  }},
  { name: "trustai", source: "TrustAIRLab/in-the-wild-jailbreak-prompts", license: "MIT", fn: async () => {
    const s: RawSample[] = [];
    for (const r of await fetchHF("TrustAIRLab/in-the-wild-jailbreak-prompts", "jailbreak_2023_12_25", "train", 2000) as Array<{ prompt?: string }>) {
      const text = r.prompt ?? "";
      if (text.length < 10) continue;
      s.push({ text: text.trim().slice(0, 2000), label: "injection", source: "TrustAIRLab/in-the-wild-jailbreak-prompts" });
    }
    for (const r of await fetchHF("TrustAIRLab/in-the-wild-jailbreak-prompts", "regular_2023_05_07", "train", 2000) as Array<{ prompt?: string }>) {
      const text = r.prompt ?? "";
      if (text.length < 10) continue;
      s.push({ text: text.trim().slice(0, 2000), label: "benign", source: "TrustAIRLab/in-the-wild-jailbreak-prompts" });
    }
    return s;
  }},
  { name: "jailbreakbench", source: "JailbreakBench/JBB-Behaviors", license: "MIT", fn: async () => {
    const s: RawSample[] = [];
    for (const r of await fetchHF("JailbreakBench/JBB-Behaviors", "behaviors", "harmful") as Array<{ Goal?: string; Behavior?: string; Category?: string }>) {
      const text = r.Goal ?? r.Behavior ?? "";
      if (text.length < 10) continue;
      s.push({ text: text.trim().slice(0, 2000), label: "injection", source: "JailbreakBench/JBB-Behaviors", category: r.Category });
    }
    for (const r of await fetchHF("JailbreakBench/JBB-Behaviors", "behaviors", "benign") as Array<{ Goal?: string; Behavior?: string }>) {
      const text = r.Goal ?? r.Behavior ?? "";
      if (text.length < 10) continue;
      s.push({ text: text.trim().slice(0, 2000), label: "benign", source: "JailbreakBench/JBB-Behaviors" });
    }
    return s;
  }},

  // ─── BENIGN CONVERSATION DATASETS ───────────────────────
  { name: "dolly", source: "databricks/databricks-dolly-15k", license: "CC-BY-SA-3.0", fn: async () => {
    const s: RawSample[] = [];
    for (const r of await fetchHF("databricks/databricks-dolly-15k", "default", "train", 15000) as Array<{ instruction?: string; category?: string }>) {
      const text = r.instruction ?? "";
      if (text.length < 10) continue;
      s.push({ text: text.slice(0, 1000), label: "benign", source: "databricks/databricks-dolly-15k", category: r.category });
    }
    return s;
  }},
  { name: "oasst2", source: "OpenAssistant/oasst2", license: "Apache-2.0", fn: async () => {
    const s: RawSample[] = [];
    for (const split of ["train", "validation"]) {
      for (const r of await fetchHF("OpenAssistant/oasst2", "default", split, 10000) as Array<{ text?: string; role?: string; lang?: string }>) {
        if (r.role !== "prompter" || r.lang !== "en") continue;
        const text = r.text ?? "";
        if (text.length < 10) continue;
        s.push({ text: text.slice(0, 1000), label: "benign", source: "OpenAssistant/oasst2", category: "conversation" });
      }
    }
    return s;
  }},
];

// ─── Main: parallel with incremental save ───────────────────

async function main() {
  console.log("═══════════════════════════════════════════════");
  console.log("  Injection Benchmark — Fetch HF Datasets");
  console.log(`  Sources: ${SOURCES.length} | Auth: ${HF_TOKEN ? "YES" : "NO"}`);
  console.log("═══════════════════════════════════════════════\n");

  // Check what's already fetched
  const pending: Source[] = [];
  let existingTotal = 0;
  for (const src of SOURCES) {
    const existing = alreadyFetched(src.source);
    if (existing > 0) {
      console.log(`  ✓ ${src.name}: ${existing} already fetched (skipping)`);
      existingTotal += existing;
    } else {
      pending.push(src);
    }
  }

  if (pending.length === 0) {
    console.log(`\nAll ${SOURCES.length} sources already fetched (${existingTotal} total).`);
    return;
  }

  console.log(`\n  Fetching ${pending.length} remaining sources...\n`);

  // Run 2 at a time to avoid hammering HF
  const CONCURRENCY = 2;
  let newTotal = 0;

  for (let i = 0; i < pending.length; i += CONCURRENCY) {
    const batch = pending.slice(i, i + CONCURRENCY);
    const results = await Promise.allSettled(
      batch.map(async (src) => {
        console.log(`  [${src.name}] (${src.license})`);
        const samples = await src.fn();
        saveSamples(samples, src.source);
        return samples.length;
      })
    );

    for (const r of results) {
      if (r.status === "fulfilled") newTotal += r.value;
    }

    // Pause between batches
    if (i + CONCURRENCY < pending.length) {
      await new Promise((r) => setTimeout(r, 3000));
    }
  }

  console.log(`\n═══════════════════════════════════════════════`);
  console.log(`  New: ${newTotal} | Existing: ${existingTotal} | Total: ${newTotal + existingTotal}`);
  console.log("═══════════════════════════════════════════════");
}

main().catch(console.error);
