---
sidebar:
  order: 95
title: "Build and inspect a factory as an agent"
topic: "Getting started"
resource_type: guide
description: "A bounded agent workflow for inspecting Workspace factories, choosing tools, and separating execution from verified outcomes."
summary: "Canonical factory resources, Work links, tool selection, and read-only health inspection"
read_when:
  - Building or inspecting a factory in Tedix OS
  - Finding the canonical Work behind a Workspace
  - Distinguishing configured resources from an operating factory
visibility: public
---

# Build and operate a factory

A factory is a recurring lane owned by a tedi: a Work project and standing
objective, a revisioned executable skill, a schedule and a health Work Item.
A Workspace holds its sources, Outputs and review app. Configuration, a queued
run and a delivered result are separate facts.

For an overnight coordinator, use a tedi-owned scheduled skill workflow to
run the participating tedis, save their replies in a dated Workspace sheet,
file deduplicated blocker Work and write a morning brief. Cover both UTC
offsets for a local-time schedule and return `off_slot` before any mutation
outside its local slots. Prove a guarded run and a full manual cycle before
activation. A running `tedix channel codex <thread-id>` listener can queue Work
events into that local thread or resume it headlessly; the cloud schedule
survives the local session ending, while local execution still needs that
machine and listener. Events are hints: re-read Work and obtain admission.

From workspace chat, ask "Run the night-shift coordinator once for these
tedis, save their replies here and show the blocker Work and morning brief."
Discover the installed coordinator skill and inspect its owner, inputs and
schedule before running it; do not assume every organization has one. Ask
"Show the last cycle and next run" to check its run and Output. Enabling or
changing the schedule follows the approval rules below.

Every factory build must update this guide or its linked operating guide
with workspace-chat requests, permissions and result checks. For a card
factory, include [card actions from chat](./build-a-workspace-app.md#review-cards-from-chat-or-mcp),
not only its scheduled report.

Connect to the requested organization using the [agent guide](./agent-guide.md).
Discover each callable, then describe its exact schema before calling it.
Use the returned namespace. Reads do not grant mutation authority; repository
changes follow the [Work lifecycle](./AGENTS.md).

## Create: preview, approve, then build

Choose the source project, owner, cadence, Workspace and durable Output first.
`report` is the current template: each cycle reads project Work and recent item
comments, runs one owner turn, proposes deduplicated Work and posts a scorecard.
It does not fetch arbitrary external comments merely because the goal names them;
bind an appropriate source workflow/tool when the source is outside project Work.

```bash
# Replace these values with verified resources in your organization.
owner='<owner tedi id or slug>'
workspace='<Workspace UUID>'
goal='Summarise new project comments into the daily review document'
slug='sample-comment-review'

# Dry run writes nothing. Review owner, cron (UTC), Output and all warnings.
tedix factory create --goal "$goal" --slug "$slug" --owner "$owner" \
  --workspace-id "$workspace" --cadence daily \
  --output 'Daily review' --output-kind document --dry-run

# After approval, repeat the same options without --dry-run.
tedix factory create --goal "$goal" --slug "$slug" --owner "$owner" \
  --workspace-id "$workspace" --cadence daily \
  --output 'Daily review' --output-kind document
```

- Omit `--owner` or use `home`/`default` to pick the organization's default
  tedi. A tedi caller omitting the owner picks itself. Check the returned owner.
- Cadence is `daily`, `twice_daily`, or `hourly`. For every N hours, use
  `--cadence hourly --every-hours 3`; N is 1, 2, 3, 4, 6, 8 or 12. The builder
  chooses a UTC minute away from :00/:30; “every morning” is not a local-time
  guarantee. Inspect the returned cron before approving.
- `--workspace-id` also links the factory's project to that Workspace, so its
  Work tab lists the factory's items, and lists the lane skill under **Runs
  on a schedule** in the Workspace's Resources, with its run times, last run
  and next run.
- `--output` takes an existing Output ID or a title in `--workspace-id`.
  Titles are created on the first real run. `--output-kind document|sheet`
  defaults to document; an ID keeps its existing kind. Documents get dated
  sections, sheets get rows, with run IDs to prevent retry duplication.
- Read `warnings`: a goal's prose cannot set cadence, select an Output or
  authorize publication. `--project <KEY>` reuses an existing Work project.
- Activation requires a signed-in human, operator key, or the exact saved
  human approval for a workspace-chat creation. Other callers get a draft
  without a schedule. Read lifecycle state and next fire time after approval;
  an acknowledgment alone does not prove activation.

The MCP equivalent is `create_factory` with `dryRun: true`, then the same
arguments with `dryRun: false` after approval. Workspace chat can propose
“Every morning summarise new comments in project X into a doc here.” Check the
preview's exact project, Workspace, Output, owner and cron before approval.

## Prove one real run

Use the returned skill ID. A probe (`params: { probe: true }`) tests wiring;
it does not ask the owner to deliver the report.

```bash
skill='<returned skill UUID>'
cycle="manual-$(date -u +%Y-%m-%dT%H:%M:%SZ)"
tedix skill run "$skill" --params "{\"cycleKey\":\"$cycle\"}"
tedix skill status '<returned runId>'
tedix factory status "$slug"
```

For a non-default owner, add `--as <owning-tedi-slug>` to `skill run`.
MCP: discover `run_skill_workflow` (some catalogs advertise `run_workflow`),
then pass `skillId`, the returned `ownerTediId` as `tediId`, and
`params: { cycleKey: "manual-unique-cycle" }`. Follow its described confirmation
flow. Use a fresh `cycleKey` for each new manual
run, even within one hour; reuse it only to retry the same cycle. Without it,
daily lanes reuse one owner turn per UTC day and sub-daily lanes one per UTC
hour. Read the terminal run and the exact Output revision before claiming
success. Publication needs its own destination readback.

A scheduled skill built by hand, without `create_factory`, shows in a
Workspace once you add it as a Workspace resource:
`create_os_workspace_resource` with `providerId: "tedix"`,
`connectionScope: "tenant"`, `resourceType: "skill"`, the skill ID as
`providerResourceId` and a plain `name`. Add `metadata.purpose` for the
one-line purpose and `metadata.runsAt` when the workflow keeps only some
local times of a daylight-saving cron and returns `status: "off_slot"` for
the rest. Return `cards` or a one-line `summary` in the run result so the
Workspace can say what the last run did. `list_os_workspace_schedules`
reads the same rows the Workspace shows.

A factory for one person's own inbox belongs in that person's private
Workspace. Give it to them with `update_os_workspace` (`visibility:
"private"`, their `ownerUserId`): the current owner can do it, and so can an
organization admin for an org Workspace; afterwards only that member sees
it. The linked skill's runs still read and write that Workspace's Outputs,
and nothing else of the member's. Declare the mailbox read in the skill's
manifest (`google_gmail: [search_threads]`). The owner then opens the
Workspace and clicks **Let this read my Gmail (read-only)** on the skill's
**Runs on a schedule** row; no CLI step or Gmail resource setup is needed,
and **Stop** revokes it.

For a factory that analyses uploaded local sessions, declare
`work: [list_agent_session_activity]`. The schedule row offers its owner
**Let the CTO tedi read my session activity (read-only)** (using the worker's
name). The click grants only that worker skill a read of the owner's stored,
redacted events and activity digests for one year, unless **Stop** revokes it.
No external account is needed. Each read checks the live run and consent;
other members cannot read the source. The human request ledger stays private.
Until consent, the reader returns `needs_grant` without session data. Keep
source-derived outputs owner-restricted and publish only aggregate findings
through an explicitly approved publication path.

A factory's cards can be carried out, not only recorded. Add a second skill
owned by the same tedi, without a schedule, that takes params `{cardSheetId,
row, kind, action, reason, columns, actions, workProjectId}` (the server adds
`workspaceId` and `tediId`), does that one card and writes its outcome into
the card row: `Done ✓`, `Draft ready`, `Filed as Work /work/items/<id>` or
`Failed: <reason>`, plus `yes` in the done column when it worked. Link it to
the Workspace like the factory and point the Card review source at it with
`doIt: "run_skill"` (see [Build a workspace app](build-a-workspace-app.md)).
The app starts it with `osWorkspaces.schedules.runNow` the moment the person
presses **Do it**. Declare in its manifest only the account tools it uses:
for Gmail, `get_thread`, `get_message` and `list_labels` to read, and
`label_thread`, `unlabel_thread`, `create_label` and `create_draft` to
organise, with `expectedAnnotations: { destructive: true }` because
removing a label is marked destructive (pass `confirmDestructive` and a
`reason` on that call). Never declare a send, trash, spam or delete tool;
consent cannot reach them, and adding the Trash or Spam label is refused.
The owner allows organising on their Gmail row under **Attached resources**
(**Read + organise**), or with the button the card shows the first time;
anything bigger becomes a Work item for the owning tedi or a local agent.

## Health and lifecycle

```bash
tedix factory status                 # Overview with one-line reasons
tedix factory status "$slug"         # Run IDs, errors and deliveries
tedix skill status '<runId>'         # Follow the exact run, never replay it
tedix factory pause "$slug"
tedix factory resume "$slug"
tedix factory archive "$slug"
```

In chat: “How is my sample-comment-review factory doing?”, “Run it now”,
“Pause that factory”, “Resume that factory”, or “Archive that factory”.
Health uses `inspect_factory_health`; immediate runs use the discovered skill
runner. Lifecycle uses `pause_factory`, `resume_factory` and `archive_factory`. Lifecycle tools use the existing
`improve_skills` route and preserve its ownership and governance checks.

| Verdict      | Meaning                                                                |
| ------------ | ---------------------------------------------------------------------- |
| `healthy`    | Recent runs delivered Work, comments or Output revisions.              |
| `idle`       | A successful run delivered nothing; a scorecard alone is not delivery. |
| `failing`    | A run or schedule failed; inspect the returned error/run ID.           |
| `not_firing` | Missing/overdue scheduling or no run when one was due.                 |
| `paused`     | Future scheduled runs are disabled.                                    |
| `pending`    | The first scheduled run is not due yet.                                |

Pause disables future dispatch while preserving cadence and Outputs; it does
not cancel an in-flight run. Resume restores the existing schedule. Archive
retires the lane and removes its schedule; it preserves Work and Outputs.
For disposable factories, cancel the returned health Work Item, archive the
project, and complete its standing objective only after checking nothing else
uses them. Archive the scratch Workspace after verifying no schedule remains.

## Traps and reusable review pattern

- Lanes render once. Repeating a slug reuses existing configuration; it does
  not rewrite cadence, owner prompt or Output bindings. Archive and recreate
  when changing these. Reuse the factory slug/project and selected Output IDs;
  use the new returned skill ID or skill slug because the archived skill keeps
  its original slug.
- Code Mode caps returned results. Search narrowly, describe only the selected
  callable, project small fields and page large lists. A truncated result is
  unknown evidence, not a successful call; do not repeat a mutation to read it.
- `factory:` source intents are reserved for Blueprint factory cycles. Report
  lane proposals use `factory-lane:<slug>:proposal:<key>`; custom workflows
  need their own namespace and stable deduplication keys.
- A generic opportunity-review factory uses a **Rules sheet** for sources,
  eligibility and scoring; a **Cards sheet** for stable candidate IDs, evidence,
  scores and review state; a **Feedback log** for reviewer decisions and reasons;
  and a **review app** over those same records. The collector reads Rules and
  feedback, deduplicates Cards, and leaves decisions to the reviewer. Treat this
  as a custom workflow/app pattern: the report template's sheet Output appends
  summary rows and does not implement structured cards or feedback learning.

For an existing factory, resolve its Workspace, structured project links,
selected resources, lane and schedule before changing it. Read only the
relevant Work, latest runs and Outputs; preserve access errors, truncation and
missing links. Blueprint setup uses its exact published revision and
`preflight_os_blueprint` bindings; preflight grants no execution authority.

## Observe repository changes

A repository observer is advisory. Store its repository, branch, owner tedi,
lesson-trigger instructions and repair recipes in the factory project's
`metadata.repositoryObserver` through `configure_repository_observer`.
The owner matches approved brain lessons using the same trigger matcher as
situational recall. It records one commit-watch comment with the lesson revision,
verdict, evidence and proposed fix through `report_repository_observation`.
A claimed lesson application remains unverified until its evidence is checked.

The optional `.github/workflows/tedix-observer.yml` reports main pushes when the
repository variable `TEDIX_OBSERVER_URL` names the installation's
`/webhooks/repository-observer/<organization>/<project>` endpoint. GitHub's
short-lived OIDC identity must match the configured repository, workflow,
branch and pushed SHA. No stored API key is needed. A private release repository
can be separately configured to report Ship outcomes from its own workflow.
Events wake the owner through the existing tedi dispatcher; repeated delivery
reuses the observation and comment.

Red Ships have a 30-minute diagnosis deadline on Attention. The platform tick
escalates an overdue unresolved incident to the configured human, including a
missing-diagnosis breach when the tedi is unavailable. A green event asks the
owner to verify the exact serving revision before completing the incident.

Repairs are opt-in, per approved lesson. A pinned source-repair skill receives
the exact event, diagnosis and allowed paths; secret and production configuration
paths are excluded. An unchanged-candidate retry is delivered once to the
independently authenticated private ops workflow. Repeated failures reuse the
same repair budget and escalate. Rollbacks and other production operations need
separate approval. This observer adds no per-lesson pre-push gate or release hold;
the ops materialization check still verifies configuration compatibility.
