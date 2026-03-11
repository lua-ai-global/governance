# @lua-ai-global/governance — SDK Monorepo

## WHAT THIS IS
Public SDK monorepo for AI Agent Governance for TypeScript. Two packages:
- `packages/governance/` — Core SDK (0 runtime deps, 33 exports, 945+ tests)
- `packages/governance-platform/` — Shared PostgreSQL storage layer

## STRUCTURE
```
packages/
  governance/          # Core SDK — policy enforcement, scoring, injection detection, 20 adapters
  governance-platform/ # Platform storage — auto-migrating schema, org settings, policy tiers
```

## ABSOLUTE RULES
- **Zero runtime dependencies** on governance SDK — NEVER add a `dependency`. Framework imports go in `peerDependencies` (optional).
- **No `any` types** — use proper TypeScript types throughout.
- **Run tests after EVERY change** — `npm test`. All must pass before committing.
- **<300 LOC per file** — split into modules if approaching limit.
- **Files: `kebab-case.ts`** — Functions/variables: `camelCase`.
- **Commit and push after completing each feature** — `git add <files> && git commit && git push origin main`

## COMMANDS
```bash
npm run build    # Build all packages
npm test         # Test all packages
npm run lint     # Type-check all packages
```

## PUBLISHING
Packages publish to GitHub Packages (`@lua-ai-global` scope) via CI on version tags:
```bash
git tag v0.2.0
git push origin v0.2.0
```

## GIT RULES
- Imperative mood, <72 chars commit messages
- ALWAYS push to `origin main` after committing
- Never commit generated files (dist/)
