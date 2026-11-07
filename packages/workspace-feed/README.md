# @tedix/workspace-feed

The change feed from a workspace object to the Tedix core. A workspace object
owns its outputs, runs, artifacts, memory and chat. After each write it emits
one `WorkspaceChangeEvent`; the core applies it to projections that back the
org-level views (recent activity, the output library and search, Work
linkage, the Home conversation list) within a second, without ever listing a
workspace object.

## The event

```ts
import type { WorkspaceChangeEvent } from "@tedix/workspace-feed/event";

interface WorkspaceChangeEvent {
	workspaceId: string; // the workspace object id (or `org:<orgId>` for org-level records)
	organizationId: string;
	kind: "output" | "run" | "artifact" | "memory" | "chat";
	id: string; // the changed record's id
	revision: number; // monotonic per record; 1 for a new record, 0 for records without revisions
	actor: { kind: "user" | "tedi" | "external_agent" | "service"; id: string };
	changeRecordId: string; // the workspace-side row holding this change (revision row, run event, fact, message)
	at: string; // writer wall clock, ISO-8601
	seq: number; // contiguous per workspace, allocated by the ledger
	summary: WorkspaceChangeSummary; // what the projections need beyond ids; never the body
}
```

`summary` is optional on input and bounded (titles 300 chars, excerpt 2 000
chars). For an output revision send `title`, `outputKind`, `status`,
`excerpt`, `note`, `createdBy`/`createdAt` of the output, `skillRunId`,
`skillId`, `accessEnvelope`, `contentSha256`, `contentBytes`, `bodyR2Key`
and, when known, `workItemIds`. For a chat message send `conversationId`
and, on the first message, `title`. For a rename or archive send the same
`revision` and `changeRecordId` as the current revision with the new `title`
or `status`; the projection keeps every field the event leaves out.

The zod schemas live in `@tedix/api-contract/schemas/workspace-feed`.

## Emitting from a workspace object

```ts
import { createWorkspaceFeedLedger } from "@tedix/workspace-feed/ledger";
import { createWorkspaceFeed } from "@tedix/workspace-feed/feed";

// In the Durable Object constructor:
const ledger = createWorkspaceFeedLedger(ctx.storage.sql, { workspaceId });
const feed = createWorkspaceFeed({ ledger, queue: env.AUTOMATION_EVENTS });

// After a write (the ledger append is synchronous; call it inside the same
// transactionSync as the write so both commit together, then send after):
const event = await feed.emit({
	workspaceId,
	organizationId,
	kind: "output",
	id: outputId,
	revision: 3,
	actor: { kind: "tedi", id: tediId },
	changeRecordId: revisionRowId,
	at: new Date().toISOString(),
	summary: { title, outputKind: "document", excerpt },
});

// Backfill or repair: re-send everything from a sequence number.
await feed.replayFrom(1);

// The object's side of the reconciler comparison.
const snapshot = await feed.snapshot();
```

`feed.emit(input)` returns the event with its `seq`. The queue is the
existing `AUTOMATION_EVENTS` binding; the message is
`{ kind: "workspace_change", event }`.

## Consuming in the core

`apps/api` routes `workspace_change` messages from the automation-events
queue to `createWorkspaceFeedConsumer` (`@tedix/workspace-feed/consumer`),
which applies them through `@tedix/db/queries/workspace-feed/projection`:

- `(workspaceId, seq)` is the idempotency key. A seq at or below the
  workspace cursor is acknowledged without effect.
- Events apply strictly in `seq` order per workspace. One that arrives ahead
  of a missing predecessor is retried after 5 s; `replayFrom` closes a hole
  that never fills.
- Each contiguous run of events and the cursor advance go in one `db.batch()`.

Projections (all in `packages/db/src/schema/workspace-feed.ts`):

| Table                    | Holds                                                   | Read by                                 |
| ------------------------ | ------------------------------------------------------- | --------------------------------------- |
| `workspace_activity`     | one row per event                                       | `os.workspaces.activity`                |
| `workspace_output_index` | one row per output revision, `is_current` on the newest | `os.outputs.library` (with `search`)    |
| `workspace_work_links`   | output ↔ Work Item links                                | `@tedix/db/queries/workspace-feed/read` |
| `kernel_conversations`   | chat events bump the Home conversation index            | Home conversation list                  |
| `workspace_feed_cursors` | last applied seq per workspace                          | the consumer, the reconciler            |

## Reconciling

```ts
import { reconcileWorkspaceFeed } from "@tedix/workspace-feed/reconcile";

const report = await reconcileWorkspaceFeed(db, await feed.snapshot());
report.drift; // [] when the projection matches the object
report.replayFromSeq; // where to replay from when it does not
```

Both sides fold their records into the same `WorkspaceFeedSnapshot`
(sequence position, per-kind record and event counts, latest revision per
record), so the diff is exact.

## Today, before the workspace object owns the writes

The core API still writes outputs. `apps/api/src/services/workspace-feed.ts`
appends to the core-side ledger (`workspace_feed_ledger`) and sends the same
message after each output write, so the projections fill now and the
workspace object only has to switch the ledger to its own SQLite.
