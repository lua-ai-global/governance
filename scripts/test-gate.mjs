#!/usr/bin/env node
// Machine-wide gate for test runs. Usage: node scripts/test-gate.mjs <cmd> [args...]
//
// Outside CI it (1) waits for a free slot (LUA_TEST_SLOTS, default 2) shared by
// every repo/terminal on this machine, and (2) caps each Node worker's heap
// (LUA_TEST_HEAP_MB, default 2048) unless NODE_OPTIONS already sets one.
// Several agent terminals running suites at once then queue instead of stacking
// 7-13 workers each until the box swaps. In CI it is a plain pass-through.
import { spawn } from 'node:child_process';
import { closeSync, mkdirSync, openSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';

const [cmd, ...args] = process.argv.slice(2);
if (!cmd) { console.error('usage: test-gate <cmd> [args...]'); process.exit(2); }

const env = { ...process.env };
if (!env.CI) {
  const heap = env.LUA_TEST_HEAP_MB || '2048';
  if (!/max-old-space-size/.test(env.NODE_OPTIONS || '')) {
    env.NODE_OPTIONS = `${env.NODE_OPTIONS || ''} --max-old-space-size=${heap}`.trim();
  }
}

const slots = env.CI ? Infinity : Number(env.LUA_TEST_SLOTS || 2);
const dir = join(tmpdir(), `lua-test-gate-${userInfo().username}`);
const mine = join(dir, `${process.pid}.lock`);
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

function tryAcquire() {
  if (slots === Infinity) return true;
  mkdirSync(dir, { recursive: true });
  const held = [];
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    let pid = NaN, what = '';
    try { [pid, what] = readFileSync(p, 'utf8').split('\n'); pid = Number(pid); } catch { continue; }
    if (alive(pid)) held.push(what); else { try { unlinkSync(p); } catch {} }
  }
  if (held.length >= slots) return held;
  closeSync(openSync(mine, 'wx'));
  writeFileSync(mine, `${process.pid}\n${process.cwd()} $ ${[cmd, ...args].join(' ')}\n`);
  return true;
}

let waited = 0;
for (let r = tryAcquire(); r !== true; r = tryAcquire()) {
  if (waited === 0) console.error(`[test-gate] ${slots} slot(s) busy, waiting:\n  ${r.join('\n  ')}`);
  await new Promise((res) => setTimeout(res, 2000));
  waited += 2;
}
if (waited) console.error(`[test-gate] slot acquired after ${waited}s`);

const release = () => { if (slots !== Infinity) { try { unlinkSync(mine); } catch {} } };
const child = spawn(cmd, args, { stdio: 'inherit', env, shell: process.platform === 'win32' });
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => child.kill(sig));
child.on('exit', (code, sig) => { release(); process.exit(code ?? (sig ? 1 : 0)); });
process.on('exit', release);
