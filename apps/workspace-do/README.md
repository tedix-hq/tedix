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
   shared adapters (`@tedix/agent-governance`): reads pass, writes hold for
   approval, and each call is one change record with before/after revisions
   and an undo plan.
4. Steps and tokens land in an event ledger first and are pushed to
   WebSocket subscribers. A late subscriber replays from any sequence number.
5. Long conversations run their turn in a `TurnFacet` so the object itself
   stays responsive.

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
  `subscribe`, `send_turn`, `decide_approval`, `cancel_turn`, `ping`; the
  object answers with ledger events (`turn.started`, `assistant.delta`,
  `step.started`/`step.finished`, `approval.requested`, `turn.finished`, …)
  that each carry a `seq` cursor, plus `hello`, `turn.accepted` and `error`.
- MCP: the gateway forwards `POST /mcp/workspaces/{workspaceId}` here with the
  caller's principal; tools are `send_turn`, `read_turn`, `read_events`,
  `read_change_records`, `describe_binding`.
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
Apps, resources and Work items are read from the core database.

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
