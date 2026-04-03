# governance-sdk-platform

PostgreSQL storage layer for [`governance-sdk`](https://www.npmjs.com/package/governance-sdk) -- auto-migrating schema, typed queries for org settings and policy tiers.

[![License: MIT](https://img.shields.io/badge/license-MIT-green)]()

## What it does

Provides persistent storage for governance state that the core SDK evaluates in-memory:

- **Auto-migrating schema** -- tables created and upgraded automatically on first connection
- **Org settings** -- plan, preferences, kill switch state, scoring/detection config
- **Policy tiers** -- org-default rules, level-scoped rules, and agent-specific overrides
- **Saved policies** -- versioned policy definitions with level and agent assignments
- **Typed throughout** -- full TypeScript types for all stored structures

## Install

```bash
npm install governance-sdk-platform
```

Requires a PostgreSQL client as a peer dependency (`pg >= 8.0.0`).

## Quick Start

```typescript
import { createPlatformStorage } from 'governance-sdk-platform';
import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

// Create storage -- auto-migrates schema on first call
const platform = await createPlatformStorage({ pool });
console.log(`Applied ${platform.migrationsApplied} migrations`);

// Load org settings (returns defaults if no row exists)
const settings = await platform.loadOrgSettings('org_123');
// => { clerkOrgId, plan, settings: { autoRegisterAgents, killSwitch, ... }, ... }

// Save org preferences
await platform.saveOrgSettings('org_123', {
  settings: {
    killSwitch: { reason: 'Security incident', killedAt: new Date().toISOString(), scope: 'fleet' },
  },
});

// Load policy tiers for enforcement
const tiers = await platform.loadPolicyTiers('org_123');
// => { plan, policyRules, levelPolicies, agentOverrides, settings }

// List all saved policies
const policies = await platform.listSavedPolicies('org_123');
```

## API

### `createPlatformStorage(config)`

Creates a platform storage instance. Auto-migrates the schema on first call (idempotent).

```typescript
interface PlatformStorageConfig {
  pool: PgPoolLike;       // Any pg.Pool-compatible client
  autoMigrate?: boolean;  // Default: true
}
```

Returns a `PlatformStorage` object with:

| Method | Description |
|--------|-------------|
| `loadOrgSettings(orgId)` | Load org settings (returns defaults if no row) |
| `saveOrgSettings(orgId, update)` | Upsert org preferences |
| `loadPolicyTiers(orgId)` | Load resolved policy tiers for enforcement |
| `listSavedPolicies(orgId)` | List all saved policies for an org |
| `migrationsApplied` | Number of migrations applied on init |

### `runMigrations(pool)`

Run migrations manually (useful if `autoMigrate: false`).

```typescript
import { runMigrations } from 'governance-sdk-platform';

const applied = await runMigrations(pool);
```

## Schema

The migrator creates and maintains these tables:

| Table | Purpose |
|-------|---------|
| `org_settings` | Per-org plan, preferences, scoring/detection config |
| `saved_policies` | Versioned policy definitions with rules, level/agent assignments |
| `_platform_migrations` | Migration tracking (internal) |

## Works with any pg-compatible client

`PgPoolLike` accepts anything with a `.query()` method -- `pg.Pool`, `@neondatabase/serverless`, connection poolers, etc.

```typescript
import { Pool } from '@neondatabase/serverless';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const platform = await createPlatformStorage({ pool });
```

## Part of the Governance SDK

| Package | Purpose |
|---------|---------|
| [`governance-sdk`](https://www.npmjs.com/package/governance-sdk) | Core SDK -- policy engine, scoring, injection detection, 20 framework adapters |
| `governance-sdk-platform` | **This package** -- PostgreSQL storage layer |

## License

[MIT](../../LICENSE)
