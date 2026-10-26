---
sidebar:
  order: 95
title: "Build and inspect a factory as an agent"
topic: "Getting started"
resource_type: guide
description: "A bounded agent procedure for inspecting Workspace factories, choosing tools, and separating execution from verified outcomes."
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
A Workspace holds its sources, Documents and review app. Configuration, a queued
run and a delivered result are separate facts.

For the complete first-build loop, start with
[Build, operate and tune a factory](./build-operate-tune-factory.md). It takes a
fresh agent from the goal and dry run through the first probe, daily health and
tuning, and keeps the current trap list in one place.

For an overnight coordinator, use a tedi-owned scheduled automation to
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

## Rank Decisions before curation

`rank_deck_cards` is a paid, explicit snapshot operation for the authenticated
recipient. Ask from workspace chat, "Rank my current Decisions and show the reasons
and example receipts." Discover the callable before use. A tedi needs its own
recipient delegation; its owner's sign-in does not grant inbox access. The
operation does not install a curator, change the OS order, rewrite cards or
make decisions. Save its returned cards and signals in a revisioned Output
when using them in a factory review.

The organization learning policy's optional `deckCuratorRanker` configuration
selects the model, label threshold, penalty, time limits and spend reservations.
It defaults to disabled and selects Qwen3 30B A3B FP8 through the existing
Workers AI Gateway adapter. Exactly eight distinct, explicit personal
usefulness verdicts are retrieved by title and summary similarity, excluding
the current cohort. Approving an action is not a usefulness verdict. Missing
examples, invalid output, unavailable Gateway configuration or exhausted
budgets leave the original score intact. Critical cards always come first;
model signals can only lower other scores and cannot remove cards.

Default reservations are $0.005 per attempted classification, $0.25 per run
and $1 per organization per UTC day. Reservations are conservative admission
accounting, not reconciled provider charges; failed inference retains its
reservation. Measure provider charges from actual run usage. Curator turns,
retrieval and Gateway add-ons are separate.
Changing models requires rechecking the reservation against that model's cost.

For autonomous curation, separately verify the owning skill revision, recipient
grant, immutable card revisions and undo, trigger, schedule and actual run
receipts. Keep decision resolution in shadow until the relevant approval
policy fix is verified live. A ranking snapshot is not evidence that any of
those mechanisms is installed or active.

## Score factory cards

A factory that writes card sheets for the Card review app or Decisions scores
each card when it writes the row. Tedix OS only reads the score: it sorts,
caps and removes repeats. Without a score column, cards keep sheet order and
the existing routing and ranking apply.

Add these optional columns to the card sheet and name them in the source's
`columns` setting, like the other columns:

| Setting    | Example header | Cell                                          |
| ---------- | -------------- | --------------------------------------------- |
| `score`    | `Score`        | A number from 0 to 1                          |
| `features` | `Features`     | JSON object of named numbers behind the score |
| `effort`   | `Effort`       | Short chip on the card face, such as `5 min`  |
| `timing`   | `Timing`       | Short chip on the card face, such as `Today`  |

A score outside 0 to 1 and a features cell that is not a JSON object are
ignored. Feature names are short snake_case words; the card face shows the two
features with the largest weighted contribution as "Why this card".

The source's optional `scoring` block holds the factory's own settings. It is
configuration in the app's manifest, never code. This fictional forum factory
shows every field:

```json
{
	"label": "Forum",
	"workspaceId": "<workspace id>",
	"cardSheetPrefix": "Forum cards ",
	"columns": {
		"type": "Type",
		"source": "Thread",
		"why": "Why",
		"action": "Action",
		"useful": "Useful?",
		"reason": "Reason",
		"done": "Done?",
		"score": "Score",
		"features": "Features",
		"effort": "Effort",
		"timing": "Timing"
	},
	"doIt": "approve",
	"protectedEffects": ["message"],
	"scoring": {
		"weights": {
			"fresh_thread": 0.5,
			"buyer_intent": 0.3,
			"author_karma": 0.2
		},
		"topN": 10,
		"maxAgeDays": 3,
		"skipReasonChips": [
			{ "label": "Already covered", "mapsTo": "duplicate" },
			{ "label": "Wrong topic", "mapsTo": "not_for_me" },
			{ "label": "Stale", "mapsTo": "expired" },
			{ "label": "An agent could do it", "mapsTo": "agent_could_do" },
			{ "label": "Too much effort", "mapsTo": null },
			{ "label": "Other", "mapsTo": null }
		],
		"weightUpdate": { "cadence": "weekly", "mode": "shadow", "minSamples": 30 },
		"agentDecidableClasses": ["upvote"]
	}
}
```

- `weights`: the factory's default weight per feature. The factory computes
  the score with them; Tedix uses them only to explain a card.
- `topN`: cards shown per source and run day, best score first; equal scores
  keep sheet order. Decided cards count, so a verdict never pulls in another
  card.
- `maxAgeDays`: cards from older runs are hidden.
- `skipReasonChips`: the Not useful chips for this factory. `mapsTo` names the
  shared reason (`already_decided`, `expired`, `agent_could_do`, `duplicate`
  or `not_for_me`) the chip teaches, or `null` for a reason only this factory
  uses.
- `weightUpdate`: how verdicts retune the weights each week (see
  [Weekly weight update](#weekly-weight-update)). Promotion always goes
  through a person; `shadow` only reports.
- `reviewerWeights`: accepted weights for one reviewer, by user id. Written
  by an accepted weight proposal; reviewers without an entry use `weights`.
- `agentDecidableClasses`: card types an agent may decide once each person
  has earned it (see [Agent-decidable classes](#agent-decidable-classes)).
- `protectedEffects` (on the source): effects these cards carry when filed as
  Work, such as `message`; they keep a person in the loop.

Before the cap, Tedix collapses repeats: rows of one source with the same type
and the same first link (or the same source text) are one card. A decided copy
wins, else the newest run. Each row keeps its key, `<sheet id>:<row index>`,
across reads, so a verdict always lands on the row the reviewer saw. Keep a
thread's link in the source cell so repeats are recognised.

### Feedback contract

Every verdict writes the sheet cells as before (`useful`, `reason`, and `done`
for Do it or Not useful). The reason cell reads `Chip, Chip: note`. Tedix also
records one learning event for the reviewer with this metadata:

| Field            | Value                                                  |
| ---------------- | ------------------------------------------------------ |
| `decisionClass`  | `factory:<source label>:<card type>`                   |
| `decisionChoice` | `useful`, `not_useful`, `do_it`, `later` or `skip`     |
| `score`          | The card's score, when present                         |
| `features`       | The card's features, when present                      |
| `factoryReason`  | The first skip chip in the reason, when one was picked |
| `sharedReason`   | That chip's `mapsTo`, or `null`                        |
| `reason`         | The full reason text                                   |

When a `run_skill` Do it files a card as Work, the skill passes
`factoryCard: { "cardSheetId": "<cardSheetId>", "row": <row> }` (its own run
params) to `create_work_item`. Tedix reads that card with the caller's access,
finds the Card review or Decisions source whose workspace and sheet prefix match,
and stores the card's proposal envelope as the Work's `metadata.decisionDeck`,
so routing and learning treat it like any other decision: `kind` is
`proposal`, `classId` is the card type, `confidence` is the score,
`protectedEffects` comes from the source (none when it declares none), and
`expiresAt` is the run time plus `maxAgeDays`. The skill never writes the
envelope itself; a `metadata.decisionDeck` next to `factoryCard` is refused.

### Weekly weight update

A daily pass looks at every source whose `weightUpdate.mode` is `shadow` or
`enforce` and fits new weights at most once a week per source:

1. It reads the source's verdict learning events of the last 90 days that
   carry `features`. Useful and Do it count as positive, Not useful as
   negative; Later and Skip are ignored. A reviewer's latest verdict on a card
   wins.
2. A skip reason sets how much a Not useful counts: `duplicate` and
   `already_decided` count 0.25, `expired` and `agent_could_do` 0.5, and
   everything else 1. `weightUpdate.reasonWeights` overrides this by chip
   label or shared reason (0 ignores those verdicts).
3. Below `minSamples` verdicts nothing is proposed. Otherwise a regularised
   logistic step starts from the current weights, is pulled back toward them,
   and moves each weight by at most `maxChange` (default 0.25). It learns on
   the older 75 % of verdicts and is judged on the newest 25 %.
4. A signed-in reviewer with at least `minSamples` verdicts of their own also
   gets personal weights; everyone else uses the source's weights.

Each proposal and its report stay on the organization: verdict counts by
label and reason, held-out ranking accuracy before and after (the share of
useful/not useful pairs ranked correctly), and how many of the top `topN`
cards would change. A proposal is skipped when nothing moves or held-out
accuracy would drop.

- `shadow` stops there. Nothing is written to a sheet or the app.
- `enforce` also adds the proposal to the source's `rules` sheet as a
  `proposed` row (id `weights-<date>`, with the changes and the report as its
  text), so it appears under the Card review app's proposed rules. Accept
  writes the stored weights into the app's settings as a new app revision
  on the next daily pass; Reject keeps the old ones. The weights applied are
  the ones stored with the proposal, never text from the sheet. A proposal
  whose source weights changed in the meantime is marked stale and not
  applied, and no new proposal is made while one waits for a decision.

### Agent-decidable classes

A card type listed in `scoring.agentDecidableClasses` is a candidate for
earned quiet delivery. Its learning class is `factory:<label>:<type>`.
Listing a type states that its Do it can be undone. Each person earns it
separately, through the same class gate as other Decisions decisions:

1. The person's last `unchangedThreshold` verdicts on that class (default 5,
   each on a different card) are Do it with nothing changed. Useful and Later
   do not count and do not break the run. Any other Not useful breaks it.
2. Once earned, the person's open cards of that class appear in Activity as
   updates instead of decisions. A stable audit sample (`auditSampleRate`,
   default 10 %) still asks the person.
3. A Not useful whose chip maps to `agent_could_do` counts as candidacy
   evidence. After two, the class shows as "Eligible to hand to an agent".
   These marks never graduate a class on their own.
4. Demotion is immediate and keeps a record. If the person undoes a verdict
   (Undo learning), edits a card, or decides the same card both ways, the
   class goes back to the person. Only verdicts after that event count. The
   standing names the counted verdicts and the event that demoted it.

Some cards never graduate, however much feedback they get:

- cards from a source with any `protectedEffects` (money, message, consent,
  production, data, contract or commitment);
- types in the routing policy's `criticalClasses`;
- types, actions or drafts that name a human-reserved action (sending,
  paying, publishing, deleting, credentials and similar);
- expired cards;
- any envelope that is outbound, an approval, one-way, of unknown
  reversibility, or marked taste or strategy.

The Card review app, including its view inside Decisions, shows each listed
class as Stays with you, Learning, Eligible to hand to an agent, or Agent
decides. A Decisions `classPolicies` entry for the class with
`autoApprove: false` keeps it with every person. Removing the type from
`agentDecidableClasses` does the same. Nothing here executes a card. Quiet
delivery only changes whether the card asks the person for a decision.

## Create: preview, approve, then build

Choose the source project, owner, cadence, Workspace and durable Output first.
`report` is the current template: each cycle reads project Work and recent item
comments, runs one owner turn, proposes deduplicated Work and posts a scorecard.
It does not fetch arbitrary external comments merely because the goal names them;
bind an appropriate source automation or tool when the source is outside project Work.

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
one-line purpose and `metadata.runsAt` when the automation keeps only some
local times of a daylight-saving cron and returns `status: "off_slot"` for
the rest. Return `cards` or a one-line `summary` in the run result so the
Workspace can say what the last run did. `list_os_workspace_schedules`
reads the same rows the Workspace shows.

A factory for one person's own inbox belongs in that person's private
Workspace. Give it to them with `update_os_workspace` (`visibility:
"private"`, their `ownerUserId`): the current owner can do it, and so can an
organization admin for an org Workspace; afterwards only that member sees
it. The linked skill's runs still read and write that Workspace's Documents,
and nothing else of the member's. Declare the mailbox read in the skill's
manifest (`google_gmail: [search_threads]`). The owner then opens the
Workspace and clicks **Let this read my Gmail (read-only)** on the skill's
**Skills and schedules** row; no CLI step or Gmail resource setup is needed,
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

Pause disables future dispatch while preserving cadence and Documents; it does
not cancel an in-flight run. Resume restores the existing schedule. Archive
retires the lane and removes its schedule; it preserves Work and Documents.
For disposable factories, cancel the returned health Work Item, archive the
project, and complete its standing objective only after checking nothing else
uses them. Archive the scratch Workspace after verifying no schedule remains.

## Apply a reusable project blueprint

Discover `preview_os_blueprint_apply` and `apply_os_blueprint`. Pass the same
`blueprintId`, `instanceKey`, `workspaceName` and `parameters` to both. Preview
returns the resolved plan and stable resource IDs without creating anything.
Pass its `receipt.planSha256` as `expectedPlanSha256` on apply to reject a
plan that changed after preview. Apply saves the workspace, apps, project,
milestones, proposed Work cards,
dependencies, document templates and schedule definitions together. Cards
keep descriptions, done-when and suggested owners; nobody is assigned or
started. Repeating an instance key returns its receipt and preserves member
edits. Different parameters or a different revision require a new instance key.

Authors declare setup under `definition.provisioning` (version 1), with stable
`key` values for each template. Declare parameter types in `parameters` and
use `{{parameterName}}` in text. `{{workspaceId}}` and `{{projectId}}` resolve
to the new instance. A milestone target may be a timezone-aware date or
`{ parameter: "deadline", offsetMinutes: -30 }`. References and dependency
cycles are checked before apply writes anything.

Schedules default to disabled. Without a `skillId`, a schedule is an unbound
definition in Workspace Resources, not a running automation. To provision an
executable schedule, bind an active skill in the installing organization with
an owning tedi and automation. Its approved schedule must match the blueprint's
cron, parameters and enabled flag. Apply cannot change that approved policy;
normal runtime consent, budget and execution gates still apply.

## Automation factory inputs

Record the lane's skill, Workspace and objective once in the project's
`metadata.factory` binding. Each automation receives
`env.__RUN_CONTEXT__.factory` with `workspaceId`, `projectId`, `objectiveId`,
`blueprintRevisionId` and `ownerTediId`, plus its health Work Item and Output.
Unbound skills receive `null`; a factory without a Blueprint has a null revision.
The runtime resolves the Workspace's current pin on the first load of a run
and saves those inputs for its later resumes. Applying a Workspace Blueprint
upgrade changes the next run's inputs without changing the skill.

From workspace chat, ask "Show this factory's binding and the Blueprint revision
used by its latest run." Check the run's `factory/context.json` artifact against
the Workspace pin. A configured binding is separate from a successful run.

Inside an automation, `create_work_items` calls with `factoryCycle` can omit
`projectId`, `objectiveId`, `factoryCycle.workspaceId` and
`factoryCycle.blueprintRevisionId`; the runtime fills missing values from the
run's binding before calling the tool. Explicit values remain explicit and
normal access, revision and admission checks still apply. Keep `templateKey`,
`cycleKey` and immutable `sourceRefs` in each request. `validate_skills` warns
when a stored automation contains literal UUIDs matching its bound factory;
read the run context instead of copying those IDs into source.

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
  lane proposals use `factory-lane:<slug>:proposal:<key>`; custom automations
  need their own namespace and stable deduplication keys.
- A generic opportunity-review factory uses a **Rules sheet** for sources,
  eligibility and scoring; a **Cards sheet** for stable candidate IDs, evidence,
  scores and review state; a **Feedback log** for reviewer decisions and reasons;
  and a **review app** over those same records. The collector reads Rules and
  feedback, deduplicates Cards, and leaves decisions to the reviewer. Treat this
  as a custom automation or app pattern: the report template's sheet Output appends
  summary rows and does not implement structured cards or feedback learning.

For an existing factory, resolve its Workspace, structured project links,
selected resources, lane and schedule before changing it. Read only the
relevant Work, latest runs and Documents; preserve access errors, truncation and
missing links. Blueprint setup uses its exact published revision and
`preflight_os_blueprint` bindings; preflight grants no execution authority.

## Observe repository changes

A repository observer is advisory. Store its repository, branch, owner tedi,
lesson-trigger instructions and repair recipes in the factory project's
`metadata.repositoryObserver` through `configure_repository_observer`.
The owner matches approved memory lessons using the same trigger matcher as
situational recall. It records one commit-watch comment with the lesson revision,
verdict, evidence and proposed fix through `report_repository_observation`.
A claimed lesson application remains unverified until its evidence is checked.

The optional `.github/workflows/tedix-observer.yml` reports main pushes when the
repository secret `TEDIX_OBSERVER_URL` names the installation's
`/webhooks/repository-observer/<organization>/<project>` endpoint. Use a secret,
not a variable: Actions logs print variables, and public repository logs are
readable by anyone. GitHub's
short-lived OIDC identity must match the configured repository, workflow,
branch and pushed SHA. No stored API key is needed. A private release repository
can be separately configured to report Ship outcomes from its own workflow.
Events wake the owner through the existing tedi dispatcher; repeated delivery
reuses the observation and comment.
Each wake is a turn on the owner tedi. Push watches share
`maxActivePushWakes` slots (default 2) per project. A push that arrives while
the slots are taken waits. The 2-minute platform tick wakes waiting pushes,
newest first, as reports free the slots. A slot whose turn has not reported
frees itself after 30 minutes. Red incidents always wake, and they also hold a
slot until reported.
By default, pausing the linked factory schedule rejects new observer events;
a missing schedule also rejects them. A human administrator can explicitly set
`pauseWithFactorySchedule: false` through `configure_repository_observer` when
event-driven observation must continue independently of the hourly factory.
This leaves the timer and skill lifecycle unchanged. The active project,
signed webhook identity, configured owner and standing repair limits still apply.

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
