# Workspace objects

One object per workspace. It holds the workspace's documents, sheets and
presentations, its conversation, and the record of every change, and it
answers questions and carries out tasks itself: the model streams here and
its code runs beside the data.

## What a turn does

1. A user message arrives (`sendTurn`). The object writes a `turn_started`
   event and answers at once with a turn id and a sequence number.
2. The model gets a system prompt whose first part never changes for a
   workspace (rules plus the TypeScript declarations of the sandbox `env`),
   so the provider caches it, and a short second part (workspace name, time,
   the guest tedi's persona when one runs).
3. The model writes JavaScript. It runs in a fresh Worker with no network;
   its `env.outputs`, `env.apps`, `env.resources` and `env.work` are stubs
   that call back into this object. Every call is checked and recorded by the
   shared adapters (`@tedix/agent-governance`): reads pass, and the agent's
   own create or edit of a doc, sheet or deck applies at once (see below).
   Other canonical writes hold for approval. App file tools stage changes in
   one conversation draft on a pinned revision. The draft files and sequence
   let clients preview edits while the turn runs. The existing app decision API validates and
   saves one revision on acceptance, or discards the draft on rejection.
   Restoring a previous revision preserves history; a moved base requires
   rebasing before acceptance.
   `env.apps.create({ name, files })` makes a new app. Its name and files
   are checked first (the same source check an app edit gets), so a card is
   shown only for an app that loads. The save always holds for the person's
   approval. Once approved the app has
   revision 1 and no resource grants, and `approval.executed` names it so
   the card can open it.
   Each call has a change record; canonical writes include revision and undo
   information. `env.views.show` changes no data: it puts a live view
   (a `view.shown` event) under the answer, which the chat renders in the
   same sandboxed widget frame tedi chat uses.
   `env.web.fetch(url)` reads a public https page from this object, not the
   sandbox (`src/web.ts`): private, local and internal addresses are refused,
   also after a redirect; size and time are bounded and HTML comes back as
   fenced readable text. The first page from a domain in a conversation holds
   for the person's approval on the usual card; later pages on that domain in
   the same conversation load without asking.
   A call that fails ends that call, not the turn (`src/call-failure.ts`).
   Refused arguments, a stale `expectedRevision`, an unknown file, a tool
   that throws anything at all, code that throws, does not load or runs out
   of time: each comes back as that call's error with the reason, the model
   corrects it, and the turn goes on. Text holding half of a character (an
   emoji cut in two) is refused before any check or card, because it could
   not be saved as written. Code that runs past 60 s is no longer waited
   for but is not stopped, so the model is told its calls may have applied.
   Only a failed model request or a result that cannot be stored ends the
   turn.
   A held write does not end the turn. The model reads "Approval required"
   in its tool result and carries on with work that does not depend on it;
   the person decides on the card or in the chat's "Waiting for you" tray
   while the chat goes on. The next turn's prompt lists the proposals still
   waiting. A decision made while a turn works is answered by one turn after
   it finishes (or, after a Stop, with the person's next message).
   Each decision takes its request before applying it. A second decision on
   the same request, from another person, another tab or a retry, changes
   nothing: it waits for the first to land and is answered `alreadyDecided`
   with what the first one did, so a change is never applied twice.
   Creating or editing a doc, sheet or deck does not wait
   (`src/auto-approval.ts`). The write is applied in the same turn and the
   model gets the saved file, or the error, as the call's result. It is
   recorded under whoever the turn acts for as `approval.requested`,
   `approval.decided` (both with `automatic: true`) and `approval.executed`,
   so the chat shows an applied change, not a card to decide, and the
   activity feed records `approval.automatic` instead of a request. Undo and
   version history are the way back. An edit that removes content (an `ops`
   entry named delete, remove or archive), deleting, sharing, filing Work, a
   new app, web pages and anything outside the workspace still wait for a
   person. No setting changes this.
4. Steps and tokens land in an event ledger first and are pushed to
   WebSocket subscribers. A late subscriber replays from any sequence number.
5. The user's message, each model message and each tool result are saved
   to the conversation as they finish, so a stopped, failed or restarted
   turn keeps what it already did. The next turn sees that history; a tool
   call left without a result gets one saying it may not have finished.
   Stop is stored as `cancelled`; a restart marks the turn `failed` with
   `interrupted`. The chat offers Continue after either.
6. Long conversations run their turn in a `TurnFacet` so the object itself
   stays responsive. Stop reaches the facet through its `cancel()` call.
7. One conversation has one working turn. A message sent while it works
   starts no second turn: it is queued (`message.queued`) and the turn reads
   it after its current tool results, before its next model call
   (`message.read`), as the person's message in that turn. When the turn
   ends first, the oldest unread message starts the next turn and that turn
   reads the rest. Stop hands unread messages back (`message.returned`), and
   the chat puts their text back into the composer.

## Attached files

An attached upload (spreadsheet, Word, PowerPoint or PDF) reaches the model
as text. The API keeps the file's whole text beside it at upload; this object
reads it (`src/file-text.ts`). Attached files share 32K characters of text in
one message: a file that fits is given whole, a longer one as its first whole
lines with a note of the lines shown. The agent reads the rest with
`env.outputs.readFileText({ outputId, startLine, lineCount })`, which returns
whole lines up to about 28,000 characters and the line to continue from, or
finds lines with `env.outputs.searchFileText({ outputId, query })` (100
matches a call). Both are reads and never wait for approval. A file with no
text says why: a scanned PDF has no readable text (nothing here reads text in
images), and an upload from before whole texts were kept must be uploaded
again to be read past its start.

## Surfaces

- RPC through the `InternalEntrypoint` service binding: `sendTurn`,
  `cancelTurn`, `readEvents`, `readLedger` (history paging),
  `listConversations`, `readTurn`, `awaitTurn`, `readChangeRecords`,
  `readMessages`, `decideApproval`.
  Its `ownedMemory` storage port routes organization, workspace and personal
  memory by explicit owner. It checks container access from the gateway's
  authenticated context; operation permissions and per-fact visibility and
  use-policy checks belong to the gateway. Organization memory does not
  require membership in a project workspace.
- WebSocket: forward the upgrade to `InternalEntrypoint.fetch` with
  `X-Workspace-Org`, `X-Workspace-Id`, `X-Workspace-Actor-Id` and a path
  ending in `/subscribe`. Frames follow `src/wire.ts`: the client sends
  `subscribe`, `send_turn`, `decide_approval`, `decide_approvals` (several
  approvals of one reply, continued by one turn), `cancel_turn`, `rename_conversation`,
  `archive_conversation` (`archived: false` restores; `hello` lists archived
  conversations in `archived`), `delete_conversation` (refused while a reply
  is working; every socket gets `conversation.deleted`), `ping`; the
  object answers with ledger events (`turn.started`, `assistant.delta`,
  `step.started`/`step.finished`, `approval.requested`, `turn.finished`, …)
  that each carry a `seq` cursor, plus `hello`, `turn.accepted` and `error`.
- MCP: the gateway forwards `POST /mcp/workspaces/{workspaceId}` here with the
  caller's principal; tools are `send_turn`, `read_turn`, `read_events`,
  `read_change_records`, `describe_binding`. Forwarded requests carry
  `X-Workspace-Actor-Id`, `X-Workspace-Actor-Kind` and `X-Workspace-Scopes`.
  The object checks the current workspace permission graph on each call.
  Chat history, turns and approvals require build access. Use access allows
  interaction with deployed apps. Open chat sockets recheck before each action,
  replay and outbound event, closing when access falls. A personal tedi needs
  its active owner binding and the operation's scopes. Guest selection cannot
  impersonate another person's personal tedi.
- Migration: `/migration/workspaces/{org}/{workspace}` (`GET` describe,
  `POST /import`, `POST /rows`, separate `POST /activate`) on the worker, guarded by
  `MIGRATE_WORKSPACES_TOKEN`; see `scripts/migrate-workspaces/README.md`.
  Organization memory (`memory_*`) never moves: an import of such a table
  returns 409 on both public and service fetch. The importer proves its
  snapshot before it sends anything.

## Data

The object extends the tenant store from `@tedix/db/tenant-store/store`:
its own SQLite with the workspace's output rows (bodies stay in R2 by
digest), the memory tables, and `importRows` for the one-shot migration.
Agent output reads and writes and resource listings require workspace
activation and use object SQLite. Shared or unresolved workspaces receive an
activation error; approval does not bypass it. Apps and Work items are read
from the core database.

Copied `kernel_conversations`, `kernel_runtime_runs` and
`kernel_runtime_events` are converted into the object's chat tables on first
access after wake or import. Conversion and per-event checkpoints commit
together, preserving existing chat cursors across retries. Moved archives are
browsable in workspace chat; deleted conversations stay hidden.
Chat lists, turn reads and socket replay then use
only the native tables; the copied rows remain available for reconciliation.
Imported assistant text is labelled as prior assistant context for subsequent
model calls, without inventing model or usage receipts.

## Check it

```bash
bun run --cwd apps/workspace-do type-check
bun run --cwd apps/workspace-do test:run
bun scripts/lint-loader-sandbox.ts --strict
```

`scripts/bench.ts` times one question against a live workspace through the
MCP gateway and prints time to first text and total time.

## Model and usage in chat

The chat picker offers the configured Azure deployment and explicitly allowed
Workers AI models. Azure needs its resource/deployment and AI Gateway settings.
Workers AI needs an executable AI Gateway transport and the deployment-owned
`AI_GATEWAY_AUTO_ALLOWED_MODELS` comma-separated list of exact `@cf/owner/model`
IDs. An in-account `AI` binding with `AI_GATEWAY_BINDING_PROVIDERS=workers-ai`
uses the binding transport; otherwise the shared gateway transport needs its
account and token settings. Gateway credentials stay authoritative; provider
credentials are stripped from SDK requests. Unconfigured IDs are rejected
before writing a turn, and the selected ID reaches both local and isolated
execution. Azure is the default when available; otherwise the first configured
Workers AI model is the default. Workspace chat still requires build access.

Chat labels the selected model until the provider reports its model
name. Input and output totals include all model calls and compaction; cached
input is a subset of input. Missing provider usage stays unavailable, and totals
with missing calls are marked partial. Model and usage events replay with the
turn, including available receipts before a later failure. Cost stays unavailable:
the adapter's zero pricing is a placeholder, not a price or a provider receipt.

## Workflow steps

`src/workflow-manifest.ts` defines a versioned skill-revision manifest with
`tool`, `agent` and `code` steps. `runWorkflow` in `src/workflow-runner.ts`
runs the list through explicit workspace ports. Inputs name earlier steps;
the runner passes pinned Output revision references and writes each result
through the Output port. An agent step makes one turn and validates its
declared JSON Schema. Code runs through the workspace sandbox port.

Each attempted step appends a running receipt before execution and a terminal
receipt afterwards. Tool calls use the shared governance adapters and trusted
catalog policy. `ok: false`, `isError: true`, exceptions and schema mismatches
stop the list. A held approval produces `needs_approval`, never completion.
`approval: required` accepts only an adapter decision from the approval gate;
supplying a request ID alone cannot authorize a call. Failed tool results are
saved as Output revisions, with uncertain external effects recorded as unknown.

This is the source runner contract, exercised with both Reddit skill examples
in `src/workflow-runner.test.ts`. Production tool/model/Output port wiring,
skill revision publication, restart recovery and alarm scheduling are separate
integration work. Existing skill lifecycle, certification and cron dispatch are
unchanged; these tests do not activate schedules or send messages.
