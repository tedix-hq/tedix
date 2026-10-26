---
name: night-shift-coordinator
description: Select executor-assigned Work, review lane results and write a morning brief without a local lead session.
audience: [tedi]
capabilities:
  schedule:
    cron: "*/15 * * * *"
    enabled: false
    params: {}
  reason:
    enabled: true
    maxCalls: 8
  network: false
  mcp:
    tedix:
      [
        list_projects,
        list_work_items,
        get_work_items_by_id,
        list_work_item_attempts,
        list_attempt_projection,
        list_ready_work,
        update_work_item_specification,
        complete_work_item,
        add_comment,
        list_os_outputs,
        get_os_output,
        create_os_output,
        revise_os_output,
      ]
    tedi: [run_tedi_turn]
    ceo: [run_tedi_turn]
    cro: [run_tedi_turn]
---

# Night shift coordinator

Install this skill under an existing project lead. Configure its native schedule
with `workspaceId`, `projectIds`, `coordinatorId`, `maxLanes` and `people`. The
coordinator must be the owner or steward of Work it plans or completes. Each person supplies
`id`, `timeZone`, `briefAt`, `nightStart` and the real `deckUrl`. Keep installation
coordinates in organization configuration. The example schedule is disabled.

The workflow also includes active projects whose metadata `labels` or `tags`
contains `night-shift`. Work with `metadata.executor` equal to `codex` or
`claude-code` is the backlog. The existing Work scheduler ranks it, including
priority, urgency, fairness and downstream impact. Ranking is advisory; the
local dispatcher admits each child independently.

Use `tedix lane serve --coordinated` as the execution host. Omit `--project`
to follow ready selections across projects. It must honor planned start times,
retain telemetry and reuse a dead lane's own worktree on retry. Run the host as
an operating-system service so ending a chat cannot stop it. A machine that is
off or asleep cannot execute local agents; server coordination remains durable.

The server watcher records heartbeat loss and expires the old Attempt. This
workflow then reviews its terminal result with the platform's tool-free
reasoner and either completes succeeded Work, re-briefs it for a fresh Attempt,
or holds it for escalation. It never renews or settles a peer's Attempt.
Review comments retain the model identity and lesson; re-briefs carry the lesson
into the next lane. Configure `maxRetries` (default 3) and `maxReviews` (default
4, ceiling 6) to bound each cycle. Set the owner's runtime profile
`modelPolicy.synthesisModelRef` to an approved economy model for these reviews.
Review receipts retain the actual model identity. Chat keeps its own setting.
Reviews wait when model identity is unavailable. The server's outcome and
finished timestamp establish settlement; a child's earlier summary cannot
override that receipt. Missing outcome evidence still requires a re-brief.
The retry limit also bounds repeated re-briefs of succeeded Attempts.
Explicit executor assignments also review the latest settled result when a tedi
has already fulfilled the Work. Unsettled Attempts remain held.

Optional `tediTurns` entries (`namespace`, `ownerId`) retain half-hour nudges for
existing tedis. A tedi is nudged only when it has accepted Work in scope without
a live Attempt, excluding Work assigned to Codex or Claude Code. Empty queues
do not create blocker proposals. Lane planning
and the core log finish before these optional turns. A still-running tedi turn
is logged as pending without replaying it or failing lane coordination.

`metadata.laneDispatch` is the dispatch plan on canonical Work: selected Work
is `ready`, and other Work is `held` until a later coordination cycle. Label
coordinated projects `night-shift` so new code assignments start held. The
dispatcher requests `dispatchReadyOnly`; calendar `startAt` remains intact.
Use this only for Work assigned to this coordinator. Escalations remain excluded until a new Attempt
or an explicit human revision resolves them. Approval, consent and outbound
sends retain their existing authority checks.

Each cycle appends to the OS document **Night log YYYY-MM-DD**, using the
morning-ending date. Each person's configured morning slot writes **Morning
brief YYYY-MM-DD** with their Decisions link and overnight lessons. The documents
live in the configured project workspace. No local log supplies readiness.

`probe: true` reads only configuration and reports the current slots. `manual:
true` runs a cycle outside its scheduled slot; `writeBrief: true` also writes
the brief. `cycleKey` lets a repeated manual proof deduplicate its log entry.
A malformed or incomplete queue fails closed. Work mutations use version fences
and document writes use revision fences; retry conflicts from fresh state.
