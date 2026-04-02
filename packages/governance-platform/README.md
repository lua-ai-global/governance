# governance-sdk-platform

PostgreSQL storage layer for [`governance-sdk`](https://github.com/lua-ai-global/governance) -- auto-migrating schema, typed queries for org settings and policy tiers.

## What it does

Provides persistent storage for governance state that the core SDK evaluates in-memory:

- **Auto-migrating schema** -- tables created and upgraded automatically on first connection
- **Org settings storage** -- per-org policy rules, level policies, agent overrides
- **Policy tier queries** -- typed read/write for base rules, level-scoped rules, and agent-specific overrides
- **Typed throughout** -- full TypeScript types for all stored structures (re-exported from the core SDK)

## Install

```bash
npm install governance-sdk-platform
```

## Usage

```typescript
import { createPlatformStorage, migrate } from 'governance-sdk-platform';
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
| `governance-sdk` | Core SDK -- policy engine, scoring, injection detection |
| `governance-sdk-platform` | **This package** -- PostgreSQL storage layer |

## License

[MIT](../../LICENSE)
