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
   `env.resources.list()` shows each connected source with its slot, service,
   whether it reads through each person's own account or one the organization
   shares, the access it grants, and whether the person the turn acts for has
   that account connected. It names no owner and holds no credential. The
   agent cannot read from or write to a connected source yet.
   `env.resources.requestConnection({ resourceId, reason })` is a read that
   changes nothing: for a source the person has not connected it records a
   `connection.requested` event, which the chat shows as a "Connect" card
   linking to the person's own accounts or the organization's connections.
   `env.web.fetch(url)` reads a public https page from this object, not the
   sandbox (`src/web.ts`): private, local and internal addresses are refused,
   also after a redirect; size and time are bounded and HTML comes back as
   fenced readable text. The first page from a domain in a conversation holds
   for the person's approval on the usual card; later pages on that domain in
   the same conversation load without asking.
   `env.tedi` (`src/tedi.ts`) reaches the answering tedi's own skills and
   connected tools through its own object. It works only on a turn a
   signed-in person sent to a tedi they may pick, not from an app, a tedi
   or a schedule. Each call sends who sent the turn and whether anyone else
   can open the workspace, read live; the tedi's object decides from that.
   Results come back fenced. A call that needs a decision becomes a
   `tedi_approval.requested` card linking to Tedix's approvals; the chat
   does not decide it and the result does not come back. After the reply,
   the finished turn is handed to the tedi once so it can learn from it.
   A call that fails ends that call, not the turn (`src/call-failure.ts`).
   Refused arguments, a stale `expectedRevision`, an unknown file, a tool
   that throws anything at all, code that throws, does not load or runs out
   of time: each comes back as that call's error with the reason, the model
   corrects it, and the turn goes on. Text holding half of a character (an
   emoji cut in two) is refused before any check or card, because it could
   not be saved as written. Code that runs past 60 s is no longer waited
   for, and the model is told its earlier calls may have applied. The code
   itself cannot be halted, so each run has its own id and the workspace
   accepts calls only from the run the turn is waiting for: code that timed
   out, failed or finished changes nothing afterwards.
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

An attached upload (plain text, Markdown, JSON, code or config file,
spreadsheet, Word, PowerPoint or PDF) reaches the model as text. A file named
as text whose bytes are not valid UTF-8 text is treated as having no text. The API keeps the file's whole text beside it at upload; this object
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
  approvals from any conversation, decided one at a time in the order given;
  the run stops at the first change that fails to apply or that someone
  decided the other way, and each conversation continues with one turn; the
  deciding socket gets `approvals.decided` with how far it got),
  `cancel_turn`, `rename_conversation`,
  `archive_conversation` (`archived: false` restores; `hello` lists archived
  conversations in `archived`), `delete_conversation` (refused while a reply
  is working; every socket gets `conversation.deleted`), `ping`; the
  object answers with ledger events (`turn.started`, `assistant.delta`,
  `step.started`/`step.finished`, `approval.requested`, `turn.finished`, …)
  that each carry a `seq` cursor, plus `hello`, `turn.accepted` and `error`.
  `hello` lists every request in the workspace still waiting for a person
  (`waiting`), and a waiting request and its decision are sent to every open
  chat, also one that follows another conversation, so each chat can show
  and decide all of them.
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
- Local demo only: `POST /local-demo/workspaces/{org}/{workspace}` seeds the
  sample files once, guarded by the launcher's `LOCAL_WORKSPACE_SEED_TOKEN`.
  It is not served outside `ENVIRONMENT=development`.

## Workspace memory

`env.memory` uses `SqlMemoryAdapter` in the workspace object's SQLite.
`write({ key, value })` saves a pending revision with the turn's actor and
source (including its turn ID); code cannot supply its own provenance or
mark the write approved. Values must be JSON. `read(key)` returns the newest
revision as `current` and the newest approved revision as `approved`.
`list(prefix)` and `history(key)` expose the stored revisions and their source.

`review({ revisionId, decision: "approve" | "reject", note? })` decides a
pending revision once. `rollback({ key, toRevisionId })` appends the earlier
value with the rollback turn's provenance and `rolledBackFrom`, preserving
history. Restoring an approved revision stays approved; other restorations
need review. Writes, review and rollback use the existing approval cards and
change records. Review records name the person who approved that decision.
All six methods are available through the sandbox loopback.

This workspace memory is separate from the owner-scoped graph storage port
`ownedMemory`; organization and personal graph memory retain their existing
routing and policy checks.

## Data

The object extends the tenant store from `@tedix/db/tenant-store/store`:
its own SQLite with the workspace's output rows (bodies stay in R2 by
digest) and the memory tables. The store is initialized with the workspace's
directory row when the workspace is created; until then output reads, writes
and resource listings are refused. Apps and Work items are read from the core
database. Chat lists, turn reads and socket replay use only the native chat
tables; `kernel_*` rows copied in by the November 2026 move are kept only
until their conversation is deleted.

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
