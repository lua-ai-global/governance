# governance — Testing standard

Node's built-in runner via `tsx --test`, zero test dependencies (matches the SDK's zero runtime
deps). Files: `src/**/*.test.ts` next to the unit.

- `npm test -w packages/<pkg>` runs through `scripts/test-gate.mjs` (machine-wide
  `LUA_TEST_SLOTS` semaphore shared with the other Lua repos + heap cap; pass-through in CI) with
  `--test-concurrency=4` — the runner otherwise forks CPU-1 processes.
- Check one change with one file: `npx tsx --test src/<file>.test.ts` from the package.
- The `src/**/*.test.ts` glob is expanded by npm's shell without globstar: it matches **one**
  directory level. Keep test files at `src/*.test.ts` or `src/<dir>/*.test.ts`, never deeper —
  a deeper file is silently skipped.
- Pure functions only: no I/O, no timers, no network in this repo's tests. If a test needs
  time, inject a clock.
- `.only`/`{ only: true }` never lands; `{ skip: "<reason>" }` carries its reason inline.
- One behaviour per `test()`; assert with `node:assert/strict`.
