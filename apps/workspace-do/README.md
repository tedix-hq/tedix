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
  `POST /import`, `POST /rows`) on the worker, guarded by
  `MIGRATE_WORKSPACES_TOKEN`; see `scripts/migrate-workspaces/README.md`.

## Data

The object extends the tenant store from `@tedix/db/tenant-store/store`:
its own SQLite with the workspace's output rows (bodies stay in R2 by
digest), the memory tables, and `importRows` for the one-shot migration.
Apps, resources and Work items are read from the core database.

## Check it

```bash
bun run --cwd apps/workspace-do type-check
bun run --cwd apps/workspace-do test:run
bun scripts/lint-loader-sandbox.ts --strict
```

`scripts/bench.ts` times one question against a live workspace through the
MCP gateway and prints time to first text and total time.
