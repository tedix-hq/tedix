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
report.replayFromSeq; // missing tail, or null when ordinary replay cannot repair it
report.rebuildRequired; // drift below the applied cursor needs a rebuild
```

Both sides fold their records into the same `WorkspaceFeedSnapshot`
(sequence position, per-kind record and event counts, latest revision per
record), so the diff is exact.

## Today, before the workspace object owns the writes

The core API still writes outputs. `apps/api/src/services/workspace-feed.ts`
appends to the core-side ledger (`workspace_feed_ledger`) and sends the same
message after each output write, so the projections fill now and the
workspace object only has to switch the ledger to its own SQLite.

## Recorded workspace activity

Workspace objects publish binding accountability records as `run` events with
`summary.action`. Each entry keeps its actor, source record, turn id, operation,
outcome and optional revision link. Arguments, results and provider errors stay
in the object. A persisted delivery checkpoint and alarm retry failed delivery;
`replayActivity` republishes a bounded source page, and `reconcileActivity`
compares a bounded page of durable binding records with the core projection.
Continue these calls from `lastSequence`; a matching page proves only that page.
Action replay also restores missing activity rows below the applied cursor.

The core ledger remains the sequence owner while both stores accept output
writes. Output recovery reads immutable revision history ten revisions at a
time, so notification coalescing does not drop intermediate file saves. Titles
and lifecycle metadata describe the output when recovered; revision authors and
timestamps come from each saved revision.

New workspace-object metadata updates and conversation lifecycle events also
append sanitized source records beside the chat ledger. These survive chat
retention and retry from their own checkpoint. `replayActivity` and
`reconcileActivity` accept `source: "events"` for this independent sequence;
the default remains binding records. Continue each source separately from its
returned `lastSequence`. Conversation records include completed messages,
steps, approvals and turn outcomes, never message text, titles, arguments,
errors, token deltas or model/usage receipts. Turn starts identify the requester;
agent execution identifies the tedi when known, otherwise the workspace service.
Metadata RPCs currently carry no requester identity, so their execution is
attributed to the service. Metadata values stay private; the activity records
the operation and revision link, including intermediate updates during outages.
Delivery runs on the workspace alarm or the next binding/output flush. This
does not reconstruct transitions or conversation events from before capture,
cover core-only metadata writers, or prove a universal action history.

The activity API returns `coverage: "recorded_only"`. It filters current
workspace visibility and checks both the historical and current revision's
source access before returning file metadata or links. Missing source records,
invalid access metadata, unavailable revisions and moved files are hidden.
Requests examine at most five rows and reserve at most fifty source checks;
continue from `next`, including when a filtered page is empty. These bounds do
not establish production latency or provider-call cost.

The generic app renderer accepts `tedix:app/workspace-activity` with
`{ "version": 1, "workspaceId": "<workspace UUID>" }` in an organization's
installed gadget manifest. The view retains its incomplete-history notice.
Source support is separate from installing that revision and verifying it live.
