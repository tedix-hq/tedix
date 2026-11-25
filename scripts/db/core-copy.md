# Paced core copy

`core-copy.ts` supplies `copyPages`, `keysetSource`, `archiveSource`,
`saveCheckpoint`, `loadCheckpoint`, and `verifyCopy`. It has no production
connection, credentials, environment lookup, or automatic database discovery.
Readers, the Postgres query callback, and archive transport are injected.
Rehearse with a local SQLite capture, PGlite, and archive fixtures:

```sh
bun run --cwd packages/db test:run src/copy/core-copy.test.ts
bun run --cwd packages/db type-check
bun run type-check:scripts
```

## Copy and resume

Declare each table's physical name, primary/unique key columns, and the
columns to copy. Omit generated columns. Column kinds are `value` (unchanged),
`json` (SQLite JSON text to JSONB), `boolean` (0/1 to boolean), `epoch` (epoch
seconds to timestamptz), and `timestamp` (a timestamp with an explicit UTC/offset
to timestamptz). Use `value` for text timestamp columns. The destination schema,
constraints, and triggers must already exist; this tool does not create them.

For example, from a local harness with an open SQLite `sqlite` and PGlite `pg`:

```ts
import {
	copyPages,
	keysetSource,
	loadCheckpoint,
	saveCheckpoint,
	verifyCopy,
	type CopyTable,
} from "./scripts/db/core-copy";

const table: CopyTable = {
	table: "example_records",
	keys: ["id"],
	columns: { id: "value", metadata: "json", updated_at: "timestamp" },
};
const source = keysetSource({
	id: "local-capture-v1",
	table: table.table,
	highWater: 1200,
	read: async (sql, params) => sqlite.prepare(sql).all(...params),
});
const query = (sql, params) => pg.query(sql, params);
const checkpoint = "/tmp/example-copy.json";
// On resume, use: const state = await loadCheckpoint(checkpoint).
const state = undefined;
const result = await copyPages({
	table,
	source,
	query,
	state,
	pageSize: 250,
	pauseMs: 1000,
	save: (next) => saveCheckpoint(checkpoint, next),
});
await verifyCopy(table, query, result);
```

Use a separate checkpoint per table and pass, with one writer per checkpoint
and target table. The source ID identifies an immutable capture or frozen
window. Supply its rowid high water explicitly; an indexed descending rowid
lookup on the local capture can obtain it. The tool never counts or hashes D1
again. It reads sequential pages of at most 500 rows, with a configurable pause
before every source read, including after resume.

Each target page is one atomic SQL upsert using one JSON parameter, rather than
per-row statements. JSON recordsets keep bind counts constant. Composite keys
are supported. A checksum of normalized source rows is compared with the
upsert's returned rows before checkpointing. Checkpoints hold keys, page hashes,
and the source cursor; source payloads are not retained. The file helper replaces
the checkpoint atomically. Resume verifies previously saved pages on the target
before skipping them and rejects changed table, source/window, or page size.
An uncheckpointed upsert can be replayed. The plan and keys remain sensitive
operator state; keep checkpoint files outside source control.

`verifyCopy` joins each saved key set to the target in one query and compares
its hash with the saved page hash. It detects missing or changed copied rows,
without reopening D1 or R2. It does not prove there are no extra target rows.
Verify each pass before starting a delta that intentionally changes earlier
rows; earlier receipts describe the earlier pass.

## Hot windows and delta

For hot rows add `hot: { column: "created_at", from: cutoff }`. The cutoff uses
the column's stored representation. History outside this window comes from
archive objects, not an unbounded history scan on D1.

For updates add `delta: { column: "updated_at", after, through }`. The order is
`(updated_at, rowid)`, retaining every row when timestamps tie. The lower time
is inclusive with starting rowid zero; the upper time is inclusive. To continue
a known lower tuple, also set `afterRowid`. Preserve the source timestamp's type,
precision, and sortable representation; do not mix timestamp formats. For an
append-only table, omit `delta` and set `afterRowid` to the previous high water.
Rowid-only delta cannot detect updates to old rows or deletions.

A rowid high water is not a snapshot. Use immutable captures for rehearsal and
a separately authorized writer freeze for a final cutover pass. Delta requires
reliable, monotonic `updated_at` writes; deleted rows need a separate tombstone
or reconciliation procedure. This tool does not activate a cutover. Before any
separately authorized remote reader is supplied, review `EXPLAIN QUERY PLAN`
and its rows-scanned budget for the exact window and index. A small LIMIT alone
does not bound scanned rows. This lane opens no remote D1 connection.

## EU history

`archiveSource` accepts only an HTTPS EU R2 jurisdiction endpoint. Supply
`nextKey(prefix, after)` (one lexically next key, or null) and `get(key)`
(compressed bytes). Both can use local fixture objects. The prefix is
`d1-archive/v1/<table>/<encoded-organization>/`. Use a read-only transport;
the module never writes or deletes archive objects.

Archive chunks retain `__rowid`; only the declared columns enter Postgres.
Resume records both object key and row offset, or marks a finished object so
it can list forward without reading it again. Gzip expansion is bounded to
16 MiB per object. When the key contains the retention SHA-256 suffix, the
compressed bytes must match it. Objects and listing must remain immutable for
the pass. No day-prefix pruning is applied: a chunk can span multiple days.
Organization fields are checked when present; indirect ownership uses the
archive's organization prefix, as recorded by retention.

Import history into its declared history destination, with a key that retains
any distinct versions needed by that table. Overlapping chunks with conflicting
versions of the same key cannot satisfy both page receipts; verification fails
rather than proving a lossy import. Do not mix history and hot/core writers
against the same keys during verification.
