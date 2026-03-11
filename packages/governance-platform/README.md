# @lua-ai-global/governance-platform

PostgreSQL storage layer for [`@lua-ai-global/governance`](https://github.com/lua-ai-global/governance) -- auto-migrating schema, typed queries for org settings and policy tiers.

## What it does

Provides persistent storage for governance state that the core SDK evaluates in-memory:

- **Auto-migrating schema** -- tables created and upgraded automatically on first connection
- **Org settings storage** -- per-org policy rules, level policies, agent overrides
- **Policy tier queries** -- typed read/write for base rules, level-scoped rules, and agent-specific overrides
- **Typed throughout** -- full TypeScript types for all stored structures (re-exported from the core SDK)

## Install

```bash
npm install @lua-ai-global/governance-platform --registry=https://npm.pkg.github.com
```

Requires `.npmrc` configuration for GitHub Packages:

```
@lua-ai-global:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${NODE_AUTH_TOKEN}
```

## Usage

```typescript
import { createPlatformStorage, migrate } from '@lua-ai-global/governance-platform';
import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

// Auto-migrate schema
await migrate(pool);

// Query org policies
const storage = createPlatformStorage(pool);
const policies = await storage.getPolicies(orgId);
// => { rules: PolicyRule[], levelPolicies: Record<string, PolicyRule[]>, ... }
```

## Peer Dependencies

- `pg` >= 8.0.0 (optional -- bring your own PostgreSQL client)

## Part of the Governance SDK

This package is the storage companion to the core SDK. The core SDK handles policy evaluation, scoring, and enforcement locally. This package handles where that state lives in PostgreSQL.

| Package | Purpose |
|---------|---------|
| `@lua-ai-global/governance` | Core SDK -- policy engine, scoring, injection detection |
| `@lua-ai-global/governance-platform` | **This package** -- PostgreSQL storage layer |

## License

[MIT](../../LICENSE)
