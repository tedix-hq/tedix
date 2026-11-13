---
sidebar:
  order: 145
title: "Move workspaces into workspace objects"
topic: "Getting started"
resource_type: guide
description: "The cutover day runbook: copy every workspace's data into its own workspace object in one release, prove the copy, remove the old paths, and how to go back."
summary: "Freeze, capture the final delta, reconcile, activate, deploy the removal release, check browser and agent behavior, and soak; with rollback prerequisites"
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

Import stages a copy; it does not activate it. The staging protocol release
keeps the prior serving paths while an authorized operator reconciles and
activates each workspace. Deploy the removal release only after activation:
its workspace agent output and resource bindings refuse unactivated objects
and have no shared-database fallback. Workspaces that already serve from
their object remain object-owned. Nothing in the shared database is dropped
by import, reconciliation or activation.

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

The installation operator pauses scheduled runs, dispatchers and every other
workspace writer, drains active runs, and announces the window. Freeze both
the shared database and the objects. Record the ISO timestamp as `FROZEN_AT`
and a durable freeze evidence reference as `FREEZE_REF`.

Do not begin without the complete tested removal release, a tested recovery
procedure and reviewed decisions for every held workspace. A clean subset
does not authorize an installation-wide removal release.

### 2. Capture the final shared rows

Use the installation's reviewed capture configuration as `CAPTURE_CONFIG`
and a new directory as `FINAL_CAPTURE`. A completed staging capture cannot
be resumed to make it fresh. The configuration must cover the main database,
every historical log partition and the reviewed workspace assignments.

```bash
bun scripts/migrate-workspaces/cli.ts capture --config "$CAPTURE_CONFIG" --out "$FINAL_CAPTURE" --page-size 100 --delay-ms 2000
```

This capture is paced to protect the shared database. Retain its manifest,
page hashes and rows as evidence. The capture must start after the freeze,
and its freshness and complete history are checked again before import or
delta and reconciliation. Finish while the snapshot remains within the
two-hour freshness limit; otherwise capture again under the freeze.

### 3. Export the final bundles

Choose a new reviewed local or EU object-store location as `FINAL_BUNDLES`.

```bash
bun scripts/migrate-workspaces/cli.ts export --snapshot "$FINAL_CAPTURE/manifest.json" --bundles "$FINAL_BUNDLES"
```

One bundle per workspace is written. Export refuses incomplete assignments.
Keep the exact original staging bundles separately as `STAGED_BUNDLES`.
To operate on a reviewed subset, pass the same `--scope` to each command;
a subset report is not proof for the workspaces it excludes.

### 4. Apply the frozen delta

For workspaces already staged, use the original staging bundle as the
baseline. The installation supplies the admin migration gateway URL as
`MIGRATION_GATEWAY` and a receipt path as `DELTA_RECEIPTS`.

```bash
bun scripts/migrate-workspaces/cli.ts delta --baseline-bundles "$STAGED_BUNDLES" --snapshot "$FINAL_CAPTURE/manifest.json" --bundles "$FINAL_BUNDLES" --remote "$MIGRATION_GATEWAY" --auth tedix --workspace connect --freeze-ref "$FREEZE_REF" --frozen-at "$FROZEN_AT" --report "$DELTA_RECEIPTS"
```

Delta compares full predecessor rows before changing or deleting them. It
preserves object rows absent from both source bundles, refuses divergent
rows and unsafe parent deletions, and journals each generation-fenced batch.
It refuses source changes on unresolved or object-owned workspaces and chat
changes that conflict with native activity. Resolve those cases through their
reviewed merge procedure, then reconcile again; do not force an overwrite.
A lost response can be retried against the same bundles and retained receipts.

For an initial import with no staged baseline, use `import` instead:

```bash
bun scripts/migrate-workspaces/cli.ts import --bundles "$FINAL_BUNDLES" --remote "$MIGRATION_GATEWAY" --auth tedix --workspace connect --snapshot "$FINAL_CAPTURE/manifest.json"
```

The stored sign-in must belong to a platform administrator. Authentication
and human consent must be completed separately by the person; these commands
do not grant access. The gateway forwards the authorized migration calls
and attaches the object's migration token. Imports never activate objects.

### 5. Reconcile under the freeze

```bash
bun scripts/migrate-workspaces/cli.ts reconcile --snapshot "$FINAL_CAPTURE/manifest.json" --bundles "$FINAL_BUNDLES" --remote "$MIGRATION_GATEWAY" --auth tedix --workspace connect --freeze-ref "$FREEZE_REF" --frozen-at "$FROZEN_AT" --report "$RECONCILIATION_REPORT"
```

Require zero drift and no problems or pending re-reads for every workspace
and total. The report records each object's import generation and checks it
again after the comparison. Any intervening import invalidates the report.
Retain native object and chat evidence as well: copied source rows alone do
not establish that native activity has been preserved. Reconciliation does
not resolve held ownership or merge decisions.

Attach the exact report to the Work Item and use its durable evidence URI as
`RECONCILIATION_REF`. Keep the freeze in place.

### 6. Activate reconciled workspaces

The installation release owner must already have deployed the staging and
activation protocol. Deployment alone does not activate copied workspaces.

```bash
bun scripts/migrate-workspaces/cli.ts activate --reconciliation "$RECONCILIATION_REPORT" --reconciliation-ref "$RECONCILIATION_REF" --remote "$MIGRATION_GATEWAY" --auth tedix --workspace connect --report "$ACTIVATION_RECEIPTS"
```

Activation preflights the whole selection. It refuses stale or non-frozen
reports, unresolved authority, dirty reconciliation and changed import
generations. The object checks the generation again atomically. Existing
object owners stay owners. Activation is per workspace, so retain the receipt
journal on failure and read every authority back; a lost response can conceal
a successful activation. Import and rehearsal never issue activation.

### 7. Deploy the removal release

The installation release owner deploys the fully tested removal series while
the freeze remains in place. Preparing a local branch grants no push,
deployment or activation authority. The release must remove every shared
workspace read and write together, without a feature flag or fallback:

- API output readers and writers, including file confirmation, blueprint
  instantiation and provisioning, collaboration, shares, evidence reads,
  exports, body maintenance and cross-workspace summaries.
- Workspace resources, including provider access checks, grants and every
  cross-workspace reader. Core access metadata must still refer to the
  correct object-owned resource.
- Workspace branches of the core chat, run, event, delegation and narration
  paths. Core Home threads, skill runs and shared organization memory stay
  in the core and retain their existing behavior.
- The workspace object's agent output and resource bindings and its storage
  ownership checks. Newly created workspaces need explicit native
  initialization; they must not depend on staging or inferred D1 ownership.
- Workspace MCP routes. Missing runtime bindings or organization identity
  must fail instead of mounting the generic core tool server.
- Any remaining OS callers of core APIs for workspace chat. Preserve Home's
  own helpers and components; native workspace chat uses its object socket
  through `src/lib/workspace-chat-client.ts`.

Post the exact caller audit and the behavior changes for every held workspace
on the Work Item before deployment. An unfinished port is not a release
candidate even if one binding or reader has been removed successfully.

### 8. Check browser, agent and feed behavior

Open a workspace in each organization and check its newest document and
revision history, selected file attachments, workspace chat and run history,
resource visibility and moves. Exercise agent reads and approved writes,
including stale-revision refusal. Check held-workspace decisions explicitly;
do not treat a missing output or refused operation as a successful empty list.
Verify organization Home threads, skill runs and shared organization memory.

Run the installation's feed reconciler against the objects and the core
projections used by Home, search and Work. Require zero differences, including
evidence references. Retain the results. Lift the freeze only after the
installation owner accepts both browser and agent checks and the feed proof.

### 9. Soak and authorize retirement separately

Keep the old tables and recovery evidence throughout the agreed soak and
retention period. Watch serving errors, native writes and projection lag.
Table retirement is a separate authorized migration after acceptance and
zero-difference reconciliation, not part of these preparation commands.

The eventual whole-table candidates are `os_outputs`,
`os_output_revisions` and `os_workspace_resources`, after every caller and
foreign-key dependency has moved. Keep `os_workspaces` as the core directory.
The kernel conversation, run, event, tool-result and artifact tables contain
core data too: retire only workspace-owned rows after classification, never
drop those mixed tables as a whole. Home threads, skill runs and organization
memory remain in the core.

## Go/no-go

Start the freeze only when all of these are true:

- the rehearsal on a fresh copy ended with `OK` and fits the window
- `assignments.json` covers every organization
- the five changes are on `main`, the deletion series is ready, and the
  release candidate is built from them
- every workspace object would be created in `eu` (`DO_JURISDICTION`)
- the people who can decide a rollback are reachable for the whole window

Stop and roll back when any of these happens:

- `reconcile` reports drift that a reviewed frozen delta or merge does not clear
- a workspace object reports a jurisdiction other than `eu`
- after the deploy, a workspace chat or document check fails in more than
  one organization
- the feed check reports differences that do not clear within the window

## Rollback

Before any activation, stop the migration processes and retain the capture,
bundles, reports and per-workspace authority inventory. Confirm that staging
did not change authority. Workspaces that were already object-owned stay
object-owned. Release the freeze only after the previous serving paths have
been checked. An interrupted import can remain staged for a later attempt.

After any activation, including a partially completed activation command:

1. Keep the freeze in place, or freeze again immediately if traffic resumed.
   Drain active runs and record which workspaces actually became object-owned.
   Read authority back; a lost response does not prove activation failed.
   Preserve the activation receipts and reconciliation evidence.
2. Capture the objects' current rows, revision bodies and native chat ledger,
   as well as the source recovery point. Compare all object writes since the
   freeze, including output moves, archives, revisions, resources and chat.
   Preserve those writes before restoring a source snapshot. Snapshot restore
   alone would discard them from the serving path.
3. Reconcile a reverse copy into the previous store under separately authorized,
   tested recovery tooling. Preserve existing object owners and apply the
   reviewed per-row decisions for any divergent workspace. Never apply a
   whole-database snapshot over unrelated core changes made during the window.
4. Restore the exact previous serving release and its compatible authority
   state together. Merely redeploying a release that consults persisted object
   authority does not return activated workspaces to the shared database.
   Reconcile both data and projections, then verify browser documents and chat,
   agent reads and writes, organization Home threads and skill runs.
5. Release the freeze only after the installation owner accepts those checks.
   Retain both recovery points and the receipt inventory for the agreed period.

The migration tools currently provide no deactivation command or reverse-copy
operation. A tested installation recovery procedure for steps 2–4 is therefore
a prerequisite to activation, not a command this guide can claim is ready.
If that procedure is missing, keep the freeze and serving release unchanged;
do not improvise an authority edit or accept loss of intervening object writes.

After old tables have been removed, recovery also requires recreating their
schema and restoring the verified reverse copy before the previous release can
serve. Table removal is separately authorized after reconciliation, browser and
agent acceptance, and the agreed soak and retention period. Tables that retain
Home threads, skill runs or organization memory cannot be dropped as a whole.

## What the reconciler proves, and what it does not

It compares the mapped object rows, including output revision pointers, with
the captured source and checks bundle totals, historical log coverage and EU
jurisdiction. It does not exercise the serving paths or prove that native
chat activity has been preserved. It also cannot prove that writers stayed
frozen after capture. Retain native evidence and require the browser, agent
and feed checks before accepting the release. Organization memory is outside
the move.
