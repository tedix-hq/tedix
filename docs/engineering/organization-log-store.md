# Organization log store

Design note, 20 November 2026, for Work c5642d65 (epic c4272c01). Status:
proposed, under review by the ledger owner before the build.

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
- Size scales with organizations, not with the platform. One object can hold
  10 GB; the largest organization writes well under that per year.
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
store's checkpoints are signed with the key verifiers already hold. api and
mcp need no config change.

## What the store holds

Tables in the object, created by migrate-on-wake:

- `change_records`: `sequence` (integer, primary key, not autoincrement),
  `id` (unique), `recorded_at`, `resource`, `actor_id`, `subject_id`,
  `record` (JSON body, unchanged from today), `record_digest`, `chain_hash`.
- `change_record_checkpoints`: the same columns as
  `gateway_change_record_checkpoints`, including `evidence_bundle_key`.
- `pending_change_records`: appends that arrive before the store has taken
  over the organization's chain (see the cutover below).
- Later, `audit_events` with the main table's columns.

### Append (one record)

1. The api validates the input as today (`GatewayChangeRecordInputSchema`)
   and calls `appendChangeRecord(organizationId, input)`.
2. The store, in one synchronous transaction after the digest is computed:
   `sequence = last sequence + 1`, `chain_hash = chainHash(previous, sequence, recordDigest(readerView(record)))`,
   insert. Appends are serialized inside the object, as in the workspace
   ledger, so the chain never forks (requirement 7).
3. An append whose `id` exists returns the stored record (same idempotency
   as `appendGatewayChangeRecord`).

The digest is computed over the same reader view the sealer uses today
(`GatewayChangeRecordSchema`), so a record's digest is the same in main and in
the store (requirement 1).

### Checkpoints

An alarm closes a checkpoint every 50 records or 5 minutes, whichever comes
first: the same in-toto statement, DSSE envelope and key as today
(`sealRun`'s checkpoint half). `previousCheckpointDigest` and
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

## Cutover, one organization at a time

There is no long dual-running. For each organization:

1. **Writers switch.** A deploy points the api's ledger writes (gateway
   appends through `audit.appendChangeRecord` and the machine records) at
   the store. Until the store has taken over the chain, it keeps appends in
   `pending_change_records` with no sequence and answers reads by
   forwarding to main plus the pending rows.
2. **Main settles.** The main sealer seals the organization's last rows
   (in-flight `waitUntil` writes land within seconds; the sealer's
   60-second settling window covers them) and writes the last checkpoint.
3. **Copy and verify.** A backfill job copies the organization's sealed rows
   and checkpoints from main into the store, in sequence order and in pages,
   with their stored `sequence`, digest and chain hash unchanged. The store
   runs `verifyChain` over every copied page against the copied checkpoints
   and compares the count per checkpoint range with main (requirement 5).
4. **Take over.** The store sets its tail to the last copied chain hash and
   sequence, then chains the pending appends in arrival order with sequences
   after it. Reads switch to the store.
5. **Delete from main.** Only after step 3 passed for the organization, a job
   deletes its rows from `gateway_change_records` (checkpoints too). Then,
   when every organization is done, the main tables, the main sealer and the
   old readers are removed. No fallback path remains.

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
class with its own chain if it is ever signed.

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

- Checkpoint cadence: 50 records or 5 minutes keeps a busy organization at a
  few hundred checkpoints a day. A slower cadence means fewer bundles but
  larger unsigned tails.
- Reading the platform-wide ledger (all organizations, for platform admins)
  needs fan-out across stores. No reader needs it today.
