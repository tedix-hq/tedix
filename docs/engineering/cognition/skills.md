---
summary: "Platform skills: trust boundary, execute-to-promote lifecycle, Workshop governance, runtime delivery, and executable-workflow traps"
read_when:
  - Updating skill storage, lifecycle, promotion, or muscle memory
  - Writing or running an executable skill workflow
  - Changing how skills are exposed to tedis or MCP clients
title: "Skills layer"
---

# Skills Layer

A skill is a D1-backed Agent Skills `SKILL.md` procedure (`skill_entries`),
scoped to an app, optionally linked to tools, and served over MCP as
`skill://<skill-path>/SKILL.md` following
[SEP-2640](https://github.com/modelcontextprotocol/experimental-ext-skills).
"Guidance" is a delivery mode of the same row, not a separate kind. An optional
`scripts/workflow.ts` makes a skill executable on `apps/skill-runtime`. Muscle
memory (`tedi_muscle_memory`) holds compact proven patterns. User-facing
choices between skills, flows, Code Mode, and workflows are in
[Skills, flows, and runs](../../public/skills-flows-workflows.md); schema is
`packages/db/src/schema/cognitive.ts`, contract
`packages/api-contract/src/contracts/cognitive.ts`.

The kernel never runs a skill as a hidden worker: the accountable tedi loads it
through its MCP path and records which procedure it followed.

## Trust boundary

- MCP-served skill content is **untrusted instructional input**. `SKILL.md` is
  never executed and never grants permission, spend, or approval. Host
  instructions outrank it.
- The system prompt stays body-free: skills are advertised by name + summary,
  bodies arrive only as explicit tool results (`read_skill`, `read_resource`),
  and no path folds a loaded body into a later system prompt.
- Tool annotations are enforced at one choke point,
  `requireDestructiveToolApproval` in `apps/mcp/src/mcp/governance.ts`, for
  direct `tools/call`, Code Mode inner calls, and skill-workflow calls carrying
  `_meta["com.tedix/expectedAnnotations"]`. Destructive tools return MCP
  `input_required`; stateless clients pass `confirmDestructive: true` plus a
  `reason`.

**Approvals are replay safety.** Durable work is re-driven after interruption,
so a re-driven attempt must never re-fire a recorded approval:

- Workflow approval decisions are claimed once per
  `(runId, executionEpoch, approvalId)` with a request digest
  (`apps/skill-runtime/src/workflow-approval.ts`); a divergent decision fails
  with `WORKFLOW_APPROVAL_DECISION_CONFLICT`.
- Code Mode approval replay consumes a one-shot grant keyed by session + code
  hash (`apps/tedi-runtime/src/cm-execution-gate.ts`).
- The skill-runtime loopback bridge fails closed on any call that halts for
  approval (`MCP_INPUT_REQUIRED`): it has no channel to ask.

## Placement traps

- **Skills bind to materialized tool rows.** `toolIds` are `app_tools.id`
  UUIDs, not names; on a pure aggregator app they will not resolve.
- The final segment of `skill://<path>/SKILL.md` must equal frontmatter `name`.
  `folderPath` only organizes the OS catalog; `skills.move` never changes the
  immutable `slug`, URI, or revision.
- `guidanceSkillApps` in an aggregating app's `mcpConfig` names materialized
  app slugs whose summaries are injected every turn; use the explicit slug.
- `get_skills_for_mcp` resolves org scope through the calling tedi, so an
  org-level caller must pass a tedi id or every lookup returns `entry: null`.
- `skills.listByOrg` returns `entries[]`, `skills.listByApp` returns
  `skills[]`; do not interchange them.

## Lifecycle: execute-to-promote

Every upward lifecycle transition is checked inside the db write path
(`assertSkillLifecycleTransition()` in
`packages/db/src/queries/skill-lifecycle.ts`, called by `updateSkillEntry()`)
against `skill_usage_events` rows with `source="workflow_run"` from a terminal
`skill_runs` row. No handler, tool, or script can promote a skill that never
ran. Demotion and archival always pass.

| State          | Advances when                                                                    | Falls back when                                      |
| -------------- | -------------------------------------------------------------------------------- | ---------------------------------------------------- |
| `draft`        | → `active` after ≥1 verified workflow success                                    | Zero-usage drafts archive after 14 days              |
| `active`       | → `proven` after ≥5 verified successes and no unrecovered failure in the last 10 | 3 consecutive failures → `draft`                     |
| `proven`       | → `crystallized` only via `muscle.crystallize` or operator force                 | 3 consecutive failures → `active`                    |
| `crystallized` | —                                                                                | Never auto-demotes; a failure sets `reviewFlaggedAt` |
| `stale`        | → `active` through the same ≥1-success gate                                      | → `archived`                                         |

- A failure is recovered once ≥2 consecutive verified successes follow it.
- Direct (`skills.usage`) and muscle usage rows are telemetry only. A direct
  report whose `runId` names an existing `skill_runs` row is rejected
  (`run_reserved`) so it cannot pre-claim the workflow's slot. `read_skill`
  is not usage.
- `force: true` is for signed-in humans and operator API keys; agent, M2M, and
  service callers are rejected
  ([capability-mutation gate](../../../decisions/agent-capability-mutation-gate.md)).
- Pace layers (`innovation` / `differentiation` / `record`) are derived from
  lifecycle (`paceLayerForLifecycle()`). An agent update to a crystallized
  skill's `content`, `files`, `inputSchema`, or `agentSkillsFormat` fails with
  `RECORD_LAYER_MUTATION_REQUIRES_APPROVAL`.

### Ownership and promotion

`tediId = NULL` is a baseline org skill; a set `tediId` is that tedi's working
set and is visible only to it whatever its `visibility` — setting `shared` is
not a promotion. Ownership changes are attach-only; the only tedi → org move is
promotion (`promote_skill`, `dryRun` by default), which updates the row in
place and still passes the lifecycle gate unless a human forces it.

Scheduled skills cannot be promoted: `capabilities.schedule` requires an owning
tedi (`SKILL_SCHEDULE_INVALID`). Activate one with
`improve_skills({ id, lifecycleState: "active", force: true })` as a signed-in
human — the intended human-in-the-loop handshake for scheduled automation.

### Skill Workshop

`propose_skill` creates a tedi-scoped draft; `inspect_` / `revise_` / `apply_`
/ `reject_` / `quarantine_skill_proposal` manage it. `apply_skill_proposal` is
**disposer-separated**: the proposing identity never approves it. A tedi may
apply only another identity's proposal and is clamped to `active`
(`clampLifecycleToTediForceCeiling`); the db layer re-asserts both rules and
fails closed when no author is recorded. Because a separate identity approved
it, apply is the sanctioned override of execute-to-promote. Applying never runs
a workflow the proposal contains.

Moving into or changing the record layer requires
`premortem: { failureModes: string[≥2], rollback }`
(`assertSkillPromotionPremortem`); only humans or operator keys may waive it.

Workflow revisions use a stricter path:
`propose_skill_workflow_improvement` pins a draft to a terminal baseline run and
source hashes; `activate_skill_workflow_improvement` is human-only, requires a
completed run of that exact proposal with `certification.passed: true`, and
fails on baseline drift. `promote_skill` and `apply_skill_proposal` refuse these
drafts. Certification is a correctness check, not a security attestation.

**Trajectory mining** (`packages/db/src/queries/trajectory-mining.ts`) is
deterministic: contiguous 2–8-tool windows from successful, run-corroborated
rationale records that recur in ≥3 distinct runs become Workshop proposals.
Every tool must resolve to exactly one `app_tools.id` or the pattern is
skipped; proposals are never auto-applied.

## Runtime delivery to tedis

`apps/tedi-runtime` surfaces skills three ways, none of which injects bodies,
mutates skills, or runs workflows:

- **Guidance** (`skillGuidanceAddendum`): a capped summary list of the tedi's
  own skills, cached in DO SQLite and rebuilt behind the turn, so a new skill
  shows up next turn without blocking.
- **Act-time retrieval** (`packages/context-core/src/skill-retrieval.ts`):
  lexical overlap against the org-readable corpus with a relevance floor;
  drafts, stale, and archived skills are never retrieved. An API rerank may
  reorder only within the eligible pool. Knobs:
  `TEDI_SKILL_RETRIEVAL_TOP_K` (0 disables), `TEDI_SKILL_RETRIEVAL_MIN_OVERLAP`.
  Injection emits `context.injected`, not a usage row.
- **Crystallizer** (`packages/context-core/src/crystallizer.ts`): records
  private draft skills or muscle candidates from repeated patterns.

`analytics.getSkillRetrievalUtility` reports `unknown` unless the same turn
names a run whose terminal usage row records the outcome; missing data is never
"unused".

## Muscle memory

`muscle.crystallize` requires an org-scoped source skill with ≥5 verified
workflow successes and no unrecovered failure, a premortem, and a non-author
approver (`crystallizeMuscleFromSkill()`, the only writer of `crystallized`).
Direct registration creates a candidate that enters recall only after
`successCount >= 5` and `failureCount == 0`. Executable entries without a
non-empty namespace allowlist are never injected.

## Non-guarantees

- Preconditions (`requires`, `notWhen`, `validUntil`, `staleSince`) are stored
  and displayed but not checked before use.
- `skills.validate` does not check executable-workflow requirements, and
  `preview_skills` strips `capabilities:`; read the raw row to verify a stored
  manifest.
- Deduplication is exact (trajectory hash, identical `toolIds`) plus an
  advisory adjacency warning.

## Executable skill workflows

Cloudflare Workflows owns execution (steps, retries, waits, rollback,
pause/resume, restart); `@cloudflare/dynamic-workflows` only routes a run to
tenant code. Tedix owns identity, capability policy, source pinning, artifacts,
and inspection — it does not emulate engine durability. The sandbox, bridges,
run lifecycle, and restart/abort protocol are documented in
[`apps/skill-runtime/README.md`](../../../apps/skill-runtime/README.md);
fixtures live in `apps/skill-runtime/examples/`
(`runtime-proof` exercises every primitive).

Manifest shape:

```yaml
capabilities:
  network: false # true permits fetch() only inside step.do / rollback
  mcp:
    cms_example: [content_create, content_delete] # env.MCP allowlist
  expectedAnnotations:
    destructive: true # default false: destructive tools fail closed
  reason: { maxCalls: 5 } # enables env.REASON
  schedule: { cron: "0 8 * * 1", params: { mode: "weekly" } } # UTC
```

Traps:

- **Never put secrets in `params`.** The dispatch envelope is persisted and
  visible through `instance.status()`. Provider keys are injected by host in
  `apps/skill-runtime/src/outbound-proxy.ts`.
- `step.do` `retries` must include `delay`; a partial object fails the whole
  run. `config.sensitive: "output"` is rejected by local Wrangler and does not
  redact inputs or logs — never return secrets from steps.
- `env.MCP` idempotency keys exclude the attempt (retries reuse them; a restart
  opens a new epoch). The key is requested, not guaranteed: receipts stay
  `providerConfirmation: "unknown"` unless a trusted adapter says otherwise.
  Write steps and rollbacks must tolerate duplicate delivery. Rollback is not
  exactly-once.
- `send_skill_workflow_event` is not idempotent; inspect before retrying.
- **No continue-as-new.** Near the per-instance step limit, checkpoint and start
  a successor run with a new `runId`; restart keeps the same instance identity.
- MCP task recovery allows up to 180s for a long tedi call under a 240s bridge
  guard; size step timeouts above that.
- Manifest namespace keys are JS identifiers; `resolveNamespaceSlugs()` maps
  them to app slugs (exact, then `${name}-tedix`, then `_` → `-`). Get the
  reserved `env.MCP.tedi` inventory from `tedix flow tools`.
- `env.REASON.ask({ prompt, key })` runs one tool-free child DO per `key` with
  no tedi memory; the same key on retry reuses the call, and exhausting
  `maxCalls` throws. Use `run_tedi_turn` for a tedi's own judgment (concurrent
  turns queue on its DO). Reasoning is not grounding: only `env.EVIDENCE`
  decides whether a citation holds.
- Schedules with `executionKind: inference` must export
  `eligibility(event, step, env)`; `unavailable` fails the run
  (`BACKGROUND_INPUT_UNAVAILABLE`) and never counts as zero work.
- Bump `WORKFLOW_BRIDGE_COMPATIBILITY_VERSION`
  (`apps/skill-runtime/src/runner.ts`) whenever bridge or host orchestration
  semantics change; it fences resume of an existing execution epoch.
- Only `source="workflow_run"` usage from a reconciled terminal run counts
  toward promotion; cancelled and never-executed runs are not stamped.

After changing native skill tools or the workforce projection
(`apps/mcp/src/mcp/aggregate-tedis*.ts`, not D1 rows), probe the aggregate path
with `tedix code` (`read_resource` on a `skill://` URI, `run_skill_workflow` by
slug).
