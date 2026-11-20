# Organization log store

Design note, 20 November 2026, for Work c5642d65 (epic c4272c01). Status:
revised after the ledger owner's review (hot window, cutover states, late
writes, explicit append queue, archive check before delete, cadence).

Each organization gets one log store: a SQLite Durable Object in the EU
jurisdiction that holds the organization's history. Gateway change records go
there first, then MCP telemetry audit events. Writers append to it directly;
readers read from it; the main database stops holding these rows. Rows with
no organization go to one platform store. The interim tier (rotating `LOGS_DB`
databases plus the EU R2 archive, see
[append-only data targets](append-only-data-targets.md)) stays for the tables
not covered here.

## Why a Durable Object per organization

- One writer per organization. Assigning the sequence and the chain hash is a
  local step inside one object, so two appends can never interleave and no
  database-wide sealer is needed.
- Size scales with organizations, not with the platform. One object holds
  at most 10 GB, so each store keeps a hot window and the EU archive keeps
  the rest (see Size).
- It follows the workspace store, which already runs in the EU jurisdiction
  with migrate-on-wake and a chained change ledger (22dd9c25).

## Where it runs

- Class `OrganizationLogStore` (a `DurableObject` with SQLite storage) in
  `apps/workspace-do`, next to `WorkspaceDO`. That Worker already has
  `DO_JURISDICTION=eu`, the EU `R2_BUCKET`, and the `InternalEntrypoint`
  that api and mcp already reach through `WORKSPACE_RUNTIME`.
- Addressed with `durableObjectStubByName(env.ORGANIZATION_LOG, env, "org:" + organizationId)`.
  The platform store is the name `platform`.
- Callers go through new `InternalEntrypoint` methods (for example
  `appendChangeRecord`, `listChangeRecords`, `listChangeRecordCheckpoints`),
  as the workspace methods do. No new service binding on api or mcp.

### Config change (through the ops overlay, landed by the Lead)

`apps/workspace-do/wrangler.jsonc`, top level and `env.production`:

```jsonc
"durable_objects": { "bindings": [
  // existing WORKSPACE, TEDI_AGENT, COLLAB_ROOM ...
  { "class_name": "OrganizationLogStore", "name": "ORGANIZATION_LOG" }
] },
"migrations": [
  { "tag": "v1", "new_sqlite_classes": ["WorkspaceDO"] },
  { "tag": "v2", "new_sqlite_classes": ["OrganizationLogStore"] }
]
```

Secrets on the workspace-do Worker: `CHANGE_RECORD_SIGNING_KEY` and
`CHANGE_RECORD_SIGNING_KEY_ID`, the same values the api Worker has, so the
store's checkpoints are signed with the key verifiers already hold. The key
id stays unchanged. Note for the owner: the signing key then lives on a
second Worker. api and mcp need no config change.

## What the store holds

Tables in the object, created by migrate-on-wake:

- `change_records`: `sequence` (integer, primary key, not autoincrement),
  `id` (unique), `recorded_at`, `resource`, `actor_id`, `subject_id`,
  `record` (JSON body, unchanged from today), `record_digest`, `chain_hash`.
  Indexes and the reads that use them: the primary key for `afterSequence`
  pages and checkpoint ranges; `(recorded_at, sequence)` for time-range
  reads and counts; `(subject_id, sequence)` for the `subjectId` filter;
  `(resource, sequence)` and `(actor_id, sequence)` for those filters; `id`
  for single reads and idempotent appends.
- `change_record_checkpoints`: the same columns as
  `gateway_change_record_checkpoints`, including `evidence_bundle_key`.
- `pending_change_records`: appends that arrive before the store has taken
  over the organization's chain (see the cutover below).
- Later, `audit_events` with the main table's columns.

### Append (one record)

1. The api validates the input as today (`GatewayChangeRecordInputSchema`)
   and calls `appendChangeRecord(organizationId, input)`.
2. The store runs read tail, hash, insert as one step behind an explicit
   queue: each append waits for the previous one to finish. Inside the step
   it reads the last sequence and chain hash, computes
   `recordDigest(readerView(record))` and
   `chainHash(previous, last + 1, digest)` (both are async Web Crypto
   calls), then inserts. It does not rely on the object's input gates,
   which do not hold across those awaits. So the chain never forks
   (requirement 7). One test runs two appends concurrently.
3. An append whose `id` exists returns the stored record (same idempotency
   as `appendGatewayChangeRecord`).

The digest is computed over the same reader view the sealer uses today
(`GatewayChangeRecordSchema`), so a record's digest is the same in main and in
the store (requirement 1).

### Checkpoints

A checkpoint closes every 500 records or 5 minutes, whichever comes first:
the same in-toto statement, DSSE envelope and key as today (`sealRun`'s
checkpoint half). The alarm is armed only while records without a
checkpoint exist, so an idle organization costs nothing and no empty
checkpoint is written. `previousCheckpointDigest` and
`previousChainHash` continue from the organization's last checkpoint in
main, so `verifyChain` checks a range across the move with no reset
(requirement 2).

### Evidence bundles and the day manifest

After each checkpoint, the store writes the evidence bundle (format and key
from 7d508f244: `change-record-evidence/v1/<org>/<last sequence>-<checkpoint>.json`)
to the EU R2 bucket and records the key. Once a day it writes
`change-record-evidence/v1/<org>/days/<YYYY-MM-DD>.json`: the day's
checkpoints in order, each with its bundle key, the SHA-256 of the bundle
object and its checkpoint digest. Verifying one exported day offline means
downloading the manifest and its bundles and running `verifyChain` over
them with the public key (requirements 4, 9; Work 9967af3a). R2 objects are
never deleted.

### Reads

The api's ledger procedures (`listGatewayChangeRecords` range export and
count, `listGatewayChangeRecordCheckpoints`, `appendChangeRecord`,
`listChangeRecords`, `getChangeRecord`) call the store and return the same
shapes. Range, `afterSequence` cursor, limit, resource, actor and
`subjectId` filters work on the store's indexes. Results for rows written
before and after the move are identical because the rows are byte-identical
copies (requirement 3).

## Size

Measured on 20 Nov 2026: a record body averages about 780 bytes of JSON
(max about 920). With the two hashes, the row and five indexes, about
1.2 KB per stored row. The tedix organization wrote 54k records on 19 Nov
and about 2.5k per hour on 20 Nov (60k a day); every other organization
writes under 1k a day. If Work reads and heartbeats come back (f4e6d30c),
plan for 100k a day: about 120 MB a day, so one object would fill in about
80 days.

Decision: a **30-day hot window** in each store, the EU archive for the rest.

- A record older than 30 days is removed from the store only when its
  checkpoint's bundle and that day's manifest exist in the EU bucket and
  the day verifies from the archive alone (the bundles plus the public
  key). At 100k a day the store then holds about 3.6 GB.
- Range reads that reach before the hot window return the rows still in the
  store plus `archivedBefore: <timestamp>` and the day manifest keys for the
  older part, so a caller knows the range is archived and where. Reading
  archived rows back through the API is a later step.
- Checkpoints stay in the store forever (a few hundred bytes each), so the
  chain from the archive into the store stays checkable.

Numbered segment objects with a continuing chain were the alternative. The
archive is needed anyway as the permanent copy, and a hot window keeps one
object per organization and one read path.

## Cutover, one organization at a time

Only organizations named in the `organization_log_cutover_allowlist` table
move; the row `*` allows all and an empty table moves none, so switching the
cutover on for one organization or for all is a data change.

Each store has a state: `passthrough`, `cutover` or `live`. There is no long
dual-running, and only one organization is in `cutover` at a time.

1. **Passthrough.** The deploy points the api's ledger writes (gateway
   appends through `audit.appendChangeRecord` and the machine records) at
   the store. Before its cutover starts, a store forwards each append to
   the existing main append path and stores nothing, so every organization
   keeps working as today.
2. **Cutover starts** for one organization. Its store now keeps appends in
   `pending_change_records` with no sequence. Pending rows are counted in
   range counts, but left out of `afterSequence` reads until they are
   chained. An alert fires if any pending row is older than 15 minutes.
3. **Copy and verify.** The main sealer seals the organization's remaining
   rows. A backfill job copies its sealed rows and checkpoints from main
   into the store, in sequence order and in pages, with their stored
   `sequence`, digest and chain hash unchanged. The store runs `verifyChain`
   over every copied page against the copied checkpoints and compares the
   count per checkpoint range with main (requirement 5). It writes bundles
   and day manifests for every copied checkpoint that has none yet.
4. **Catch late writes.** After the copy, the job queries main for this
   organization's rows above the last copied sequence or still unsealed. A
   write that reached main after the copy started is moved into pending (in
   sequence order) and deleted from main. This repeats until the query
   returns nothing twice in a row.
5. **Take over.** The store drops any pending append whose `id` is already
   among the copied rows (a retry that landed in both places), sets its
   tail to the last copied chain hash and sequence, chains the remaining
   pending appends in arrival order, and becomes `live`. Reads switch to
   the store.
6. **Delete from main.** Only when all of the following hold: step 3
   passed; bundles and manifests for the whole copied range exist in the EU
   bucket; one offline verification from the bucket alone has passed for
   the organization; and the late-write query from step 4 still returns
   nothing. Then a job deletes the organization's rows and checkpoints from
   main. When every organization is live, the main tables, the main sealer
   and the old readers are removed. No fallback path remains.

`recorded_at` does not always rise with `sequence` across the cutover (a
late write chained after pending appends keeps its own time). Verifiers
order by `sequence`, as `verifyChain` already requires.

The empty `gateway_change_records` table in `LOGS_DB` (logs migration 0017,
policy off) stays unused and is dropped with the old path.

## Audit events

MCP telemetry audit events (the actions `insertAuditEvent` already sends to
`LOGS_DB`) move the same way, after the ledger: they have one writer path
(`audit.createEvent`) and no batch partners. Audit rows composed into a
main-database batch with a business write stay in main for their keep window,
because moving them would split one atomic write in two; the interim
`move_to_logs_db` policy keeps moving them out. Readers of telemetry
(audit search, by resource, daily export) merge the store with main as the
`log-store` readers do today, until the main rows have aged out.

## Platform store

Rows with no organization (platform call costs with `org_id` null, platform
cron receipts) go to the `platform` store, never into an organization's
chain (requirement 8). Not built in the first version; it uses the same
class with its own chain if it is ever signed. Until then those rows stay
in the main database and its interim moves; they do not count as moved.

## What stays the same

- Records keep only hashes of arguments and results (requirement 6).
- The record contract (`ChangeRecord` schema version 2), the chain layout,
  the checkpoint statement, the DSSE envelope and the bundle format.
- Workspace ledgers stay in each workspace store.

## Order of work

1. This note, reviewed by the ledger owner.
2. Config: the binding, migration tag and secrets above, landed in the ops
   overlay by the Lead before any code that needs them.
3. Store class, append, checkpoints, bundles and reads, with one test per
   behaviour.
4. Cutover job, then the switch for the tedix organization first, then the
   rest. Verify a moved day offline with the ledger owner's check.
5. Telemetry audit events.
6. Work reads and heartbeats logged again, in the store only (Work f4e6d30c).

## Open questions

- Reading the platform-wide ledger (all organizations, for platform admins)
  needs fan-out across stores. No reader needs it today.
