# AGENTS.md — Database Package Rules

These rules apply to `packages/db`. Read `packages/db/README.md`, then the
owning schema, query module and tests before changing persistence behavior.

## Ownership

- This package owns the shared platform D1 schema, Drizzle client factories,
  relations, query statements, persistence result types, and D1-parity tests.
- Applications own authentication, input validation, orchestration, and API
  contract normalization. Do not construct transport objects in query modules.
- Direct D1 access is allowed only for the exact checked owners in
  `scripts/db-access-exceptions.json`. Drizzle's bound `sql` template inside a
  query owner is not direct-D1 access.

## Layout And Imports

- A small domain uses `src/queries/<domain>.ts`.
- A domain with independent capabilities uses leaf files under
  `src/queries/<domain>/<capability>.ts`.
- Do not create `queries/index.ts`, a domain `index.ts`, or a sibling facade
  that re-exports query files. Consumers import the exact leaf subpath.
- Schema files are grouped by relational domain under `src/schema`. Every
  model must be exported through a Drizzle Kit schema input. A table needs a
  Relations v2 definition only when it is queried through `db.query.*`.
- Use direct schema imports in leaf modules. The whole-schema surface exists
  for Drizzle initialization and genuinely aggregate schema work.

## Query Contract

- Query functions that access D1 take the narrowest package client
  first: `DbClient` when they use Relations v2 (`db.query.*`), otherwise
  `DbQueryClient` for Core API builders. Applications must create either client
  with the matching `@tedix/db` factory; they do not initialize Drizzle locally.
  Keep tenant scope, ordering, pagination, chunking, and database result types
  inside the query owner.
- Prefer typed builders and Relations v2. Use bound `sql` expressions when the
  builder cannot express the operation clearly.
- Use `build<Action>Statement()` for an unexecuted statement intended for
  `db.batch()` composition.
- D1 batches are sequential, non-concurrent transactions. Every statement must
  be constructible before execution; application branching cannot occur
  between statements.

<!-- codex:rule slug=no-d1-transaction level=MUST owner=database state=advisory -->

- Never call `db.transaction()` on D1. Use a preconstructed batch, one
  conditional/CAS statement, constraint-conflict handling, or a serialized
  DO/Workflow coordinator as the operation requires.
- Every joined SQL output name must be unique. Direct RC.4 selects use array
  mode, but D1 batch results use object rows and collapse duplicate names before
  Drizzle maps them. Use `prefixedColumns()` or an explicit alias.
- Use `getColumns()`; `getTableColumns()` is deprecated in Drizzle v1.

## Types And Names

- SQL identifiers are snake_case; TypeScript table and column properties are
  camelCase. Preserve existing physical index names unless a real schema change
  requires migration; naming-only D1 migrations are not cleanup.
- Infer table rows and inserts from `$inferSelect` and `$inferInsert`. Do not
  hand-copy a table shape.
- Name raw table types `<Entity>Row` / `New<Entity>Row` when a transport type of
  the same entity exists. Query-specific projections use `<Operation>Result`.
- Name required query inputs `<Operation>Params`; reserve `Options` for optional
  behavior such as pagination, ordering, or feature switches.
- Persisted JSON uses an explicit domain/contract type. Truly open JSON uses
  `Record<string, JsonValue>`, never `Record<string, unknown>`.
- Use validators from `drizzle-orm/zod`; do not add the standalone
  `drizzle-zod` package.

## Validation

- Migration history is append-only. Wrangler reads
  `drizzle/*/migration.sql` directly and records that relative path in
  `tedix_drizzle_migrations`; never rename, reorder, remove, or edit an entry
  already recorded in `migration-integrity.json`.
- Generate with `db:migrate:generate`; do not hand-create a timestamp or invoke
  download-on-demand Drizzle/Wrangler binaries. `db:migrate:check` must pass the
  Drizzle history gate and the complete empty-D1 chain rehearsal.
- Live migrations are separate operator work, not local development. Use the
  authorized installation release procedure, capture its recovery point, and
  verify the target ledger and schema. Never infer a database target from an
  example or use a direct apply to bypass the release procedure.

Run the narrowest relevant set, then the package gates:

```sh
bun run --cwd packages/db type-check
bun run --cwd packages/db test:run
bun run lint:db-access
bun run lint:d1
bun run lint:exports
```

For schema changes also run `bun run db:migrate:generate -- --name <change>`,
review the generated SQL, and run `bun run db:migrate:check`.
