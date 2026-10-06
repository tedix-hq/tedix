# @tedix/db

**Shared database layer** for Drizzle schemas, types, and queries.

## Overview

This package is the **database layer** for Tedix. It provides Drizzle schemas,
query functions, and database types. It is certified against the exactly pinned
Drizzle v1 prerelease `drizzle-orm@1.0.0-rc.4` and matching
`drizzle-kit@1.0.0-rc.4`; upgrade them together and rerun the D1, relation,
migration, and package gates.

```
┌─────────────────────────────────────────────────────────────┐
│  packages/db (Database Layer)                                │
│  SOURCE OF TRUTH: Drizzle schemas, DB types, relations      │
│  ├── Schema definitions (Drizzle ORM)                       │
│  ├── Query functions (CRUD operations)                      │
│  ├── Inferred types (typeof table.$inferSelect)            │
│  └── Database client factory                                │
│  CONSUMERS:                                                  │
│  ├── apps/api — Primary consumer (client + query helpers)   │
│  └── approved Worker storage owners                         │
└──────────────────────────┬──────────────────────────────────┘
                           │ imports
                           ▼
┌─────────────────────────────────────────────────────────────┐
│  packages/api-contract (API Layer - PUBLIC)                  │
│  SOURCE OF TRUTH: API schemas, shared types, contracts      │
│  CONSUMERS: All apps (api, os, mcp, widget, landing)        │
└─────────────────────────────────────────────────────────────┘
```

Key principles:

- `apps/api` is the primary consumer. Application code calls direct query leaf
  modules and does not build shared-D1 statements inline.
- Split domains use `@tedix/db/queries/<domain>/<capability>`; there are no
  query barrels or aggregation facades.
- Query modules return persistence rows or computed database results. The
  owning application normalizes them to API contracts.
- Other Worker access is deliberately narrow and enforced by repository
  boundary checks: [import restrictions](../../vite.config.ts)
  govern module access, while the [DB access checker](../../scripts/lint-db-access.ts)
  and [storage-owner manifest](../../scripts/db-access-exceptions.json)
  govern statement and raw-D1 ownership.
- Wrangler consumes Drizzle's timestamped migration directories directly; the
  append-only integrity manifest pins every applied path and SQL digest.
- Table inventories are read from `src/schema/`; this README does not duplicate
  a list that will drift.
- Canonical Tedix principals map to external identity providers through exact
  issuer/subject tuples in `principal_identities`; provider subjects are never
  used as authority without that binding.

## Usage

### Creating a Client

```typescript
import { createDbClient } from "@tedix/db/client";

export default {
	async fetch(request, env) {
		const db = createDbClient(env.DB);
		// Use db...
	},
};
```

Small Workers that only call Core API query leaves use the relation-free
factory so importing a narrow query does not initialize the full Relations v2
graph:

```typescript
import { createDbQueryClient } from "@tedix/db/query-client";
import { getDocsSiteBySlug } from "@tedix/db/queries/docs-sites/sites";

const db = createDbQueryClient(env.DB);
const site = await getDocsSiteBySlug(db, "handbook");
```

Applications use these package factories; they do not call `drizzle()`
directly.

### Querying Data

```typescript
import { getAppById } from "@tedix/db/queries/app-records";
import { getItemsByApp } from "@tedix/db/queries/items";

// The application authorizes appId before calling these query helpers.
const app = await getAppById(db, appId);

// List items for an app
const items = await getItemsByApp(db, appId, {
	limit: 20,
	offset: 0,
});
```

### Inserting Data

The caller derives and authorizes `authorizedOrganizationId` before creating
an app.

```typescript
import { createApp } from "@tedix/db/queries/app-records";

await createApp(db, {
	organizationId: authorizedOrganizationId,
	name: "Example App",
	slug: "example-app",
	primaryDomain: "example.com",
	discoveryStatus: "pending",
	metadata: {
		capabilities: {
			vertical: "ecommerce",
			checkout: { enabled: true, methods: ["redirect"] },
			cart: { enabled: true, persistCart: true },
		},
	},
});
```

## Development

### Versioned D1 migrations

Schema changes use Drizzle generation and Wrangler's D1 migration ledger. The
repository keeps every `migration.sql` and its `snapshot.json` under
`drizzle/<timestamp>_<slug>/`; Wrangler's `migrations_pattern` reads that layout
directly. Commit both files. The snapshots are Drizzle Kit's state ledger, not
an artifact: each carries an `id` and `prevIds`, and `generate` runs
`drizzle-kit check` across the whole set to find branch points, merging
commutative branches and reporting a conflicting fork with its fork point. A
missing snapshot makes the next generated migration record the wrong parent and
silently disables that detection. They are cheap to keep — about 0.5 MB packed
in git, because near-identical JSON deltas well — and `.gitattributes` marks
them generated so they stay out of diffs and reviews.

A few intermediate snapshots are labeled reconstructions of SQL-replay states
rather than original generated files. Their IDs link the neighbouring
snapshots; the corresponding SQL and integrity hashes are unchanged.

Run these commands from `packages/db`:

```bash
# Generate an unrecorded draft, then review SQL and snapshot
bun run db:migrate:generate -- --name add_attempt_count
# Complete authorized review/annotations before the first immutable hash
bun scripts/migration-integrity.ts --write
bun run db:schema:check
bun run db:migrate:check

# Custom generation follows the same review-before-record workflow
bun run db:migrate:generate -- --custom --name custom_change
bun scripts/migration-integrity.ts --write

# Inspect the configured production database (read-only)
bun run db:migrate:list

# Compare the declared schema to live D1 without applying changes
bun run db:drift:check

# Open Drizzle Studio for visual database management
bun run db:studio
```

Own-account activation follows the
[installation manifest lifecycle](../../docs/public/installation-manifests.md#backup-restore-and-upgrade).
See the [database operating rules](AGENTS.md#validation) for migration review
and immutability requirements.
Generation validates recorded history without adopting drafts, including when
Drizzle reports `no_changes`. The explicit integrity `--write` command runs the
existing SQL safety checks and requires every snapshot before recording hashes.
Missing or corrupt recorded history refuses generation. Once recorded, SQL is
immutable; subsequent corrections require another migration.
`db:migrate:check` rejects inconsistent Drizzle history, changed applied SQL,
stale snapshots, unreviewed destructive DDL, and any migration chain that fails
on an isolated D1 or violates integrity/foreign keys.
The schema snapshot check passes only when pinned Drizzle Kit RC4 returns the
machine-readable `no_changes` status; an exit-zero `ok` response means the
dry-run found SQL changes and fails the gate. Drizzle commands run through the
package-installed binary, never a download-on-demand `bunx` fallback.
A destructive migration requires maintainer review plus a data-preservation
and rollback plan; review is not a safety waiver.
The managed release procedure captures a Time Travel bookmark before writes and
targets the production database with the production environment's D1-scoped
credential, runs `PRAGMA optimize` after changes, and requires the exact live
ledger with no unreviewed schema drift. See the
[live drift checker](scripts/check-live-drift.ts)
for the accepted schema differences and verdicts.

## Environment Variables

Required for live D1 inspection, Studio, and authorized migration operations.
Generation and schema checks run locally without credentials. The live scripts
(`db:migrate`, `db:migrate:list`, `db:drift:check`, `db:studio`) read these
from the shell environment; export them (or prefix the command) before running:

```bash
CLOUDFLARE_ACCOUNT_ID=your-account-id      # Wrangler-backed scripts
CLOUDFLARE_API_TOKEN=your-d1-scoped-token  # Wrangler-backed scripts
CLOUDFLARE_D1_DATABASE_ID=your-database-id # db:studio (drizzle-kit d1-http)
CLOUDFLARE_D1_API_TOKEN=your-api-token     # db:studio; also accepted as the
                                           # token for the Wrangler scripts
```

Use the `d1_databases[0].database_id` from this package's `wrangler.jsonc` and
a token scoped to D1 on that account. Nothing here reads a secret manager;
supply the values from whichever store your installation uses.

## Architecture

This package is designed for Cloudflare D1 (SQLite) and provides:

- **Type-safe schema** using Drizzle ORM with `snake_case` column naming
- **JSON fields** for flexible metadata (app capabilities, product attributes)
- **Optimized queries** with proper indexing
- **Geographic utilities** for location-based features
- **d1-http driver** for remote schema management via Cloudflare API

### Package Exports

```typescript
import { createDbClient } from "@tedix/db/client"; // Database client factory
import { createDbQueryClient } from "@tedix/db/query-client"; // Relation-free factory
import { apps } from "@tedix/db/schema/apps"; // Direct schema leaf
import { getAppById } from "@tedix/db/queries/app-records"; // Query functions
import { startWorkItemAttempt } from "@tedix/db/queries/work-items/attempts"; // Split domain leaf
import type { App, NewApp } from "@tedix/db/schema/apps"; // Inferred types

// For Zod validation schemas, import from api-contract (direct paths, no barrel):
import { AppCapabilitiesSchema } from "@tedix/api-contract/schemas/app"; // Zod validation
```

### Directory Structure

```
packages/db/src/
├── client.ts              # Drizzle D1 and session client factories
├── schema/                # Drizzle table definitions
│   ├── index.ts           # Whole-schema manifest for initialization
│   ├── relations.ts       # Relations v2 composition
│   ├── relations/         # Cohesive defineRelationsPart() modules
│   ├── apps.ts            # App entity
│   └── <domain>.ts        # Tables, indexes, inferred row types
├── queries/
│   ├── app-records.ts     # App CRUD: one direct leaf
│   ├── apps.ts            # Hostname and App Store lookups
│   ├── catalog/           # Split domain, no index.ts or facade
│   │   ├── get-app.ts
│   │   └── mcp-tools.ts
│   └── work-items/
│       ├── resources.ts   # Resource pools
│       └── scheduler.ts   # Ranked scheduling
├── test/                  # D1 facade and schema-derived fixtures
└── utils/                 # Batch, projection, JSON, and result helpers
```

### Query Function Patterns

Database query functions are stateless and take the narrowest canonical client
first: `DbClient` for Relations v2 leaves or `DbQueryClient` for Core API-only
leaves. Required input objects use a `Params` suffix; optional pagination,
ordering, or feature switches use `Options`. Only `build*Statement()` returns
an unexecuted statement for batch composition.

Use verb-first names: `get` for one row, `list` for a deterministic collection,
`find` for criteria, and explicit mutation verbs such as `create`, `update`,
`claim`, `reserve`, or `settle`. Computed return objects use a `Result` suffix.

### Type System

**Single Source of Truth Hierarchy:**

1. Drizzle schemas define physical rows and inserts.
2. Persistence types are inferred with `$inferSelect` and `$inferInsert`; table
   shapes are never copied by hand.
3. Query projections and computed results are named beside their query owner.
4. API schemas and transport types live in `@tedix/api-contract`; applications
   normalize persistence results at their boundary.
5. DB-shaped validators use `drizzle-orm/zod`, while API validation remains in
   `@tedix/api-contract`.

### JSON Field Handling

JSON columns declared with `text(..., { mode: "json" }).$type<T>()` are decoded
by Drizzle. Keep their type aligned with the API contract; do not parse them in
routers.

```typescript
const metadata = app.metadata; // typed and decoded from the schema definition
```

### Tenant scope

Applications authorize tenant-owned data access before calling query helpers.
Use an organization-scoped query when the operation requires that predicate,
such as `getAppByIdForOrganization`; an ID-only helper such as `getAppById`
does not authorize access on its own. Global catalog/configuration rows and
immutable ledgers have their own documented ownership rules; do not add a fake
`organizationId` merely for uniformity.

```typescript
export const yourTable = sqliteTable("your_table", {
	id: text("id").primaryKey(),
	organizationId: text("organization_id")
		.notNull()
		.references(() => organizations.id, { onDelete: "cascade" }),
	// ...
});
```

> **See also:** the public
> [Cloudflare architecture](../../docs/public/cloudflare-architecture.md) for
> the D1 control-plane boundary.

## Integration

### Who Can Import from `@tedix/db`

| Consumer              | Access                                       | Notes                                                                                                                                |
| --------------------- | -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `apps/api`            | **Client + direct query modules**            | Primary API; routers/services do not own Drizzle builders                                                                            |
| `apps/docs`           | **Relation-free client + Docs query leaves** | Build/control plane maps persistence rows and orchestrates R2                                                                        |
| `apps/docs-runtime`   | **Relation-free client + site lookup leaf**  | Public edge resolves the active immutable build before serving R2                                                                    |
| `apps/tedi-runtime`   | **Narrow runtime D1 query leaf**             | `queries/tedi-runtime-bootstrap` keeps Drizzle out of the Agent Worker, including email dispatch                                     |
| `apps/mcp`            | **Narrow carve-out**                         | Reviewed tenant matching, MCP task ledger/workflow, and inline payment/receipt/audit enforcement; general app/tool reads use the API |
| Other allowed Workers | **Checked paths only**                       | See the import restrictions and storage-owner manifest linked above                                                                  |

### Who Should NOT Import from `@tedix/db`

These apps should use `@tedix/api-contract` for types and oRPC for data:

- `apps/os`
- `apps/mcp-ui`

### Import Examples

```typescript
// ✅ CORRECT: apps/api — primary consumer
import { createDbClient } from "@tedix/db/client";
import { getAppById, listApps } from "@tedix/db/queries/app-records";

// ✅ CORRECT: docs-runtime — narrow Core API client and serving projection
import { createDbQueryClient } from "@tedix/db/query-client";
import { getRuntimeDocsSiteBySlug } from "@tedix/db/queries/docs-sites/sites";

// ✅ CORRECT: OS/widget — use api-contract (direct paths, no barrel)
import { AppSchema, VerticalSchema } from "@tedix/api-contract/schemas/app";

// ❌ WRONG: OS/widget should NOT import from @tedix/db
import { apps } from "@tedix/db/schema"; // Use oRPC client instead
```

**App data flow:**

- `apps/api` - Uses direct `@tedix/db/queries/<domain>` modules for database access
- `apps/docs` - Uses direct Docs query leaves and maps DB rows to its application contracts
- `apps/docs-runtime` - Uses the narrow site lookup leaf before serving immutable R2 content
- `apps/os` - Uses `@tedix/api-contract` types via oRPC
- `apps/mcp` - Uses `@tedix/api-contract` + API service binding for app/tool data; DB access is limited to reviewed tenant matching, task ledger/workflow, and payment/receipt/audit enforcement
- `apps/mcp-ui` - Uses `@tedix/api-contract` types via oRPC

## License

AGPL-3.0-only. See the [repository license](../../LICENSE).

### App Tools + CSP

Configuration-driven MCP + widget settings live in D1:

- `app_tools` — Tool definitions, schemas, and widget routing (`widgetKey`)
- `app_tool_csp_domains` — Per-tool CSP allowlist (app-level CSP is in `mcpConfig.widgetCSP`)
