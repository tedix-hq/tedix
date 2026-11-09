---
sidebar:
  order: 145
title: "Move workspaces into workspace objects"
topic: "Getting started"
resource_type: guide
description: "The cutover day runbook: copy every workspace's data into its own workspace object in one release, prove the copy, remove the old paths, and how to go back."
summary: "Freeze, snapshot, export, import, reconcile, one deploy, delete the old code, run the feed check, drop the old tables; with rollback and go/no-go checks"
read_when:
  - Planning or running the cutover of all workspaces to workspace objects
  - Deciding whether the cutover can start, continue, or must roll back
visibility: public
---

# Move workspaces into workspace objects

The import checks two things before it copies any customer data, and
stops if either fails. There is no switch to skip them:

- **A complete, fresh snapshot.** You pass the copy of the main database
  and every log partition. The copy is at most two hours old and is
  exactly the one the export read.
- **Complete history.** The log partitions reach back to the oldest chat
  run, every run that recorded steps has them in the copy, and every row
  that should move is in its bundle. The reconcile step repeats this.

A workspace object is one place per workspace that holds the workspace's
own data and runs its agent, instead of rows in the shared database. On
cutover day every workspace's documents, sheets and presentations, their
revision history, workspace chats with their runs and steps, artifacts
and connected resources move into its object. Organization memory does not
move: it stays shared across the organization, with the same access rules
as today. A question asked in a
workspace is then answered next to its data.

Everything moves in one release. There is no flag, no gradual roll-out and
no second code path. The old code is removed in the same release. Nothing in
the shared database is dropped until the reconciler reports zero differences.

The operator runs the steps below from a checkout of this repository with
access to the installation's Cloudflare account. The commands are in
`scripts/migrate-workspaces/`; its README is the command reference.

## Before the day

1. **Rehearse on a copy.** Take a snapshot (step 2 below, without the freeze)
   and run:

   ```bash
   bun scripts/migrate-workspaces/cli.ts rehearse --snapshot main.sql --logs <one file per log partition> --assignments assignments.json --report rehearsal.json
   ```

   It must end with `rehearsal OK` and print the time per workspace. Post the
   report on the migration Work Item. If the total is longer than the freeze
   window you can afford, the day is not ready.

2. **Write `assignments.json`.** For every organization with documents
   that have no workspace today: which workspace receives them. An
   organization with such documents but no workspace gets a new workspace
   named Home, created during the export. `export` refuses to start while
   such an organization is missing from the file. `bun
   scripts/migrate-workspaces/cli.ts assignments --snapshot main.sql --out
   assignments.json` proposes the file; the product owner reviews it and it
   is kept with the Work Item.

3. **Confirm the release is built.** The five changes ship together: the
   shared adapters, the workspace runtime, the workspace object with its
   agent loop and the migration routes, the change feed into the core, and
   the workspace chat screen. Each has its own Work Item under the data
   layout epic; all five must be on `main` and in the release candidate
   before the freeze.

4. **Confirm where objects live.** The installation sets `DO_JURISDICTION`,
   the region workspace objects are created in, to `eu`. The reconciler
   checks that every workspace object reports `eu` and stops if one does
   not.

## Cutover

### 1. Freeze writes

Put the platform into read-only mode for workspaces: pause scheduled runs
and the agent dispatchers, and announce the window. From this point the
shared database must not change in the tables that move.

### 2. Snapshot the shared database

Export the main database and every log partition with the installation's
Wrangler configuration. Keep the files; they are the rollback.

```bash
wrangler d1 export <main database> --remote --output main.sql
wrangler d1 export <log partition> --remote --output logs-1.sql
```

Record the file hashes on the Work Item. Export every log partition, not
only the newest; the import refuses a copy that misses one. Start the
import within two hours of this step.

To move one workspace at a time instead of all of them, add `--scope
<organization id>/<workspace id>` to the export, import and reconcile
commands below, and give the scoped run its own bundle location.

### 3. Export every workspace

```bash
bun scripts/migrate-workspaces/cli.ts export --snapshot main.sql --logs logs-1.sql --assignments assignments.json --bundles r2://<migration bucket>/<release id>
```

One bundle per workspace lands in the EU bucket. The command stops before
writing anything if an organization has no assignment.

### 4. Import every workspace

```bash
bun scripts/migrate-workspaces/cli.ts import --bundles r2://<migration bucket>/<release id> --remote https://<your MCP address> --auth tedix --snapshot main.sql --logs logs-1.sql
```

The command first checks the snapshot (see the top of this page) and lists
every problem it finds. It copies nothing until the list is empty.

`--auth tedix` uses the sign-in that `tedix login -w connect` saved. That
sign-in must belong to a platform administrator; anyone else is refused. The
MCP address forwards the three migration calls to the workspace objects and
adds their own key for you, so you never handle it. The objects are created
in the `eu` jurisdiction on first contact.
If the command stops, run it again: chunks that already landed are skipped.

### 5. Reconcile

```bash
bun scripts/migrate-workspaces/cli.ts reconcile --bundles r2://<migration bucket>/<release id> --remote https://<your MCP address> --auth tedix --snapshot main.sql --logs logs-1.sql --report reconcile.json
```

The report must say `OK` for every workspace and every total. Any `DRIFT`
line stops the cutover; fix the cause, import again, reconcile again. Attach
`reconcile.json` to the Work Item.

### 6. Deploy the release

One deploy switches every workspace read, write and chat to the objects. It
carries the five changes plus the commits that delete the old paths (listed
next). After the deploy, open one workspace per organization, ask a
question in its chat and open its newest document. Confirm the agent
answers from the workspace and the document shows its latest revision.

### 7. Remove the old code paths

The old paths are deleted by a short series of commits prepared before the
day and pushed right after the sibling changes land on `main`, so the
release never carries both. The series removes:

- the shared-database output code in `apps/api`: the router
  `src/rpc/routers/os-workspace-outputs.ts` and the output readers in
  `os-workspaces-shared.ts`, `os-workspace-library.ts`,
  `os-workspace-files.ts`, `os-workspace-collaboration.ts`,
  `src/http/exports-and-renders.ts` and `src/lib/os-share-redemption.ts`
  move to the workspace object's reads; the shared-database query files
  they used go: `packages/db/src/queries/os-workspaces/outputs.ts`,
  `output-body-backfill.ts` and `output-body-offload.ts`
- the in-workspace chat path in `apps/api/src/rpc/routers/kernel-runtime/`:
  the workspace branches of `conversations-reads.ts`,
  `run-reads-streams.ts`, `run-steering.ts` and `direct-read.ts` read the
  object instead of the shared database; the shared-database run and chat
  query files stay because organization Home threads still use them
- the delegation hop for in-workspace chat: the workspace delegation in
  `delegation-context.ts`, `delegation-control.ts` and
  `delegation-resolution-recovery.ts`, and the narration collapse in
  `apps/api/src/rpc/routers/kernel/home-narration.ts`
- in `apps/os`: the polling chat path (`src/components/chat-polling.ts`),
  the "Response is still being prepared" state in
  `src/components/chat-message-parts.tsx`, and the Home relay for
  in-workspace chat in `src/lib/quick-chat-home.ts` (its adapter half is
  already gone)

The exact file list is posted on the Work Item before the day and updated
as the sibling changes land.

### 8. Run the feed check

The change feed (`packages/workspace-feed`) projects every write in a
workspace object into the shared core so Home, search and the Work board
see it.
Run its reconciler against the objects. It must report zero differences
between the objects and the core projections before the old tables go.

### 9. Drop the old tables

Only after steps 5 and 8 both report zero differences, and after the release
has served real traffic for the agreed soak time, remove the moved tables
from the shared database with a migration. Keep the snapshot files from step
2 for the retention period the organization agreed to.

## Go/no-go

Start the freeze only when all of these are true:

- the rehearsal on a fresh copy ended with `OK` and fits the window
- `assignments.json` covers every organization
- the five changes are on `main`, the deletion series is ready, and the
  release candidate is built from them
- every workspace object would be created in `eu` (`DO_JURISDICTION`)
- the people who can decide a rollback are reachable for the whole window

Stop and roll back when any of these happens:

- `reconcile` reports drift that a second import does not clear
- a workspace object reports a jurisdiction other than `eu`
- after the deploy, a workspace chat or document check fails in more than
  one organization
- the feed check reports differences that do not clear within the window

## Rollback

Until step 6, nothing has changed for users: unfreeze and stop. The objects
and bundles can stay where they are; a later import skips the chunks that
already landed.

After step 6 and before step 9:

1. Redeploy the previous release. It reads and writes the shared database,
   which is unchanged since the freeze.
2. Restore the snapshot only if something wrote to the moved tables after
   the freeze (it should not have): import `main.sql` and the log files with
   `wrangler d1 execute --remote --file`.
3. Unfreeze. Workspace changes made on the objects between the deploy and
   the rollback are lost for users; the objects keep them for a later
   attempt.

After step 9 there is no quick way back: restoring means recreating the
tables from the snapshot and the previous release. This is why step 9 waits
for the soak time.

## What the reconciler proves, and what it does not

It proves that the rows in each object are the rows the snapshot had, that
every output serves the same revision as before, that nothing that should
move was left behind, that the log partitions cover every run's history,
and that every object lives in `eu`. It does not prove that nothing
changed in the live database after the snapshot; that is what the freeze
is for. Organization memory is not part of the move, so its access rules
do not change. Checks after the deploy and the feed check verify the
serving paths and projections.
