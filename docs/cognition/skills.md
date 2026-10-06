---
summary: "Platform skills: D1 storage, lifecycle and promotion, executable skill workflows, muscle memory, validation, and MCP exposure"
read_when:
  - Updating skill storage, lifecycle, promotion, or muscle memory
  - Writing or running an executable skill workflow
  - Changing how skills are exposed to tedis or MCP clients
title: "Skills layer"
---

# Skills Layer

A Tedix skill is a D1-backed Agent Skills `SKILL.md` procedure, scoped to an
app and optionally linked to specific tools. It is served over MCP as
`skill://<skill-path>/SKILL.md` plus any supporting files. "Guidance" is not a
separate kind of skill: it is a delivery mode where selected skill summaries are
placed in the model's context. The same D1 row backs both.

In the cognitive vocabulary, skills and muscle memory are **procedural
memory** — reusable know-how. Facts are semantic memory; rationale, tool calls,
and outcomes are episodic memory (see [brain.md](brain.md)).

Tedix follows the [Skills Over MCP Working Group](https://github.com/modelcontextprotocol/experimental-ext-skills)
convention (SEP-2640). The working-group repo is the source of truth for the
protocol shape.

## Concept Map

| Concept                             | Backing store                                               | What it is                                                                     | How it is used                                                                                                 |
| ----------------------------------- | ----------------------------------------------------------- | ------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------- |
| Platform skill                      | `skill_entries`                                             | Versioned `SKILL.md` with metadata, app/tool links, optional supporting files. | `list_skills`, `read_skill`, `skill://.../SKILL.md`, server instructions, Code Mode tool descriptions.         |
| Executable skill workflow           | `skill_entries.files["scripts/workflow.ts"]` + `skill_runs` | Optional workflow code attached to a skill.                                    | Runs only through `run_skill_workflow` or a declared `capabilities.schedule`; source is pinned per run.        |
| Flow                                | Ephemeral draft `skill_entries` row + `skill_runs`          | One-off author-and-run convenience over the same engine.                       | `tedix flow run --file` records a `flow-ephemeral` draft and starts it; `--skill` runs an existing definition. |
| Run                                 | `skill_runs` + R2 artifacts                                 | One execution of a pinned skill revision.                                      | `get_skill_workflow_status`, `inspect_skill_workflow_run`, `tedix skill status` / `inspect`.                   |
| Platform workflow                   | Deployed `WorkflowEntrypoint`                               | Tedix-owned engine definition, not tenant-authored.                            | Observed through `workflows.*` / `tedix workflow`; changed only in platform source.                            |
| Muscle memory                       | `tedi_muscle_memory`                                        | Compact proven action pattern, correction hook, or project prime.              | `recall_muscle_memory`, bridged into the tedi workspace, usage tracked with `track_muscle_usage`.              |
| MCP prompt                          | `app_tools` rows with `toolTypeId="prompt"`                 | Host-facing prompt template, not learned procedure.                            | Offered through MCP prompts.                                                                                   |
| Directive / working-memory guidance | `context-core` runtime files and rationale records          | Short behavioral guidance from observation/reflection.                         | Injected into prompt context; not a reusable skill until recorded in `skill_entries`.                          |

Rule of thumb: skills teach procedure, skill workflows execute it, muscle
memory accelerates proven patterns.

Planning may attach a recommended skill to an assignment, but the kernel never
runs a skill as a hidden worker. The accountable tedi loads the skill through
its MCP path and records which procedure it followed on the run, Work Item,
rationale, or skill run.

### Skills, flows, Code Mode

| Surface              | Best for                                                            | Cost                                               |
| -------------------- | ------------------------------------------------------------------- | -------------------------------------------------- |
| Persistent skill     | Reusable procedures with revision, scheduling, rationale, artifacts | Discovery and lifecycle overhead                   |
| One-off flow         | Multi-step work that should run off the model's context window      | Creates an ephemeral draft; promote it to reuse it |
| Code Mode call       | Atomic tools, filtering large results, direct composition           | No procedural guidance or run lifecycle            |
| Workflow observation | Engine definition health and history                                | Read-only                                          |

The CLI mirrors this: `tedix skill`, `tedix flow`, `tedix workflow`, and
`tedix code` (see [codemode.md](../mcp/codemode.md)). All four go through the
same MCP authorization, audit, and annotation gate; none defines a second tool
or workflow model.

## Trust Boundary

MCP-served skill content is **untrusted instructional input**. Skills are data,
not directives. Hosts must not execute code from skills implicitly; tool calls
happen only through explicit, policy-gated MCP tool invocations. The host's
system/developer/user instructions always outrank skill content. A `SKILL.md`
never grants permission, spend, or approval by itself.

Skill library and workflow tools use the `mcp:skills` scope; memory and
rationale tools use `mcp:memory`; cross-org operations need `platform:admin`.

Tool annotations (`destructiveHint`, `readOnlyHint`, `idempotentHint`,
`openWorldHint`) are enforced at one choke point, so every invocation surface
behaves the same:

- **Execution** — `requireDestructiveToolApproval` in
  `apps/mcp/src/mcp/governance.ts`. A destructive tool returns an MCP
  `input_required` result (`inputRequests` + opaque `requestState`) that the
  caller answers with `inputResponses`. Legacy `elicitInput()` survives only for
  bidirectional human hosts. Stateless clients may instead pass
  `confirmDestructive: true` plus a non-empty `reason`. Every outcome writes a
  `mcp.tool.execute` / `mcp.tool.error` audit event tagged
  `destructive_approved` or `destructive_denied`. The same gate covers direct
  `tools/call`, Code Mode inner calls, and skill-workflow assertions carried on
  `_meta["com.tedix/expectedAnnotations"]` (`enforceExpectedAnnotations`).
- **Discovery** — `createCatalogToolEntry` in `apps/mcp/src/mcp/codemode.ts`.
  `discover.search()` and `discover.list_namespaces({ includeTools: true })`
  surface `annotations` and `outputSchema` so the model sees safety and
  response shape before it calls.

First-party operator tools (`apps/mcp/src/mcp/platform-operator-tools.ts`)
declare a `kind` of `read | write | destructive`; `operatorKindToAnnotations()`
in `packages/api-contract/src/schemas/tools.ts` maps it to D1
`app_tools.annotations` through `apps/api/src/services/tool-schema-sync.ts`.

**Approvals are replay safety.** Durable work is re-driven after interruption,
so a non-idempotent effect must be idempotent or approval-gated, and a re-driven
attempt can never re-fire a recorded approval:

- Skill-workflow approval decisions are claimed once per
  `(runId, executionEpoch, approvalId)` with a request digest
  (`apps/skill-runtime/src/workflow-approval.ts`). A retry deduplicates; a
  divergent decision fails with `WORKFLOW_APPROVAL_DECISION_CONFLICT`; a new
  execution epoch gets a fresh approval namespace.
- Code Mode approval replay consumes a one-shot grant keyed by session + code
  hash (`apps/tedi-runtime/src/cm-execution-gate.ts`).
- The skill-runtime loopback bridge rejects any tool call that halts for
  approval (`MCP_INPUT_REQUIRED`, `apps/skill-runtime/src/mcp-bridge-utils.ts`)
  because it has no channel to ask; it fails closed.

### Design principles

- Keep `skills/list` and `list_skills` compact and metadata-first; load a full
  `SKILL.md` only when relevant.
- The system prompt stays body-free: skills are advertised as name + summary,
  the body arrives only as an explicit tool result (`read_skill`,
  `get_skill`, `read_resource`), and no path folds a loaded body into a later
  turn's system prompt.
- Map skills to concrete tools with `metadata."io.modelcontextprotocol/tools"`
  so coverage can be audited.
- Read-only tools declare `outputSchema` so workflows can compose results
  reliably.

## Placement Rules

- **Skills bind to materialized tool rows.** An app can own skills when it owns
  the relevant `app_tools` rows. Do not author skills on pure aggregator apps
  unless they point at tools from a materialized source app; otherwise
  `toolIds` will not resolve. See [runtime.md](../mcp/runtime.md) for app tiers.
- **Folder identity follows SEP-2640.** Every skill is a folder with a
  `SKILL.md` entrypoint. The final segment of `skill://<skill-path>/SKILL.md`
  must equal the frontmatter `name`; app prefixes are allowed as locators
  (`skill://example-app/scrape-a-page/SKILL.md` → name `scrape-a-page`).
- **Catalog folders are organization only.** `folderPath` is an optional
  slash-separated, lowercase kebab-case path used by the Tedix OS catalog. It
  is not the SEP-2640 skill path. Moving a skill with `skills.move` preserves
  its immutable `slug`, `skill://` URI, workflow references, content revision,
  and lineage; `null` moves it to the catalog root.
- **`toolIds` are `app_tools.id` UUIDs, not tool names.** `toolSkillMap` in
  `apps/mcp/src/mcp/tool-registration.ts` reverse-maps UUIDs to registered
  tools. Frontmatter may show readable slugs; storage uses UUIDs.
- **`guidanceSkillApps`** in an aggregating app's `mcpConfig` lists
  materialized app slugs whose skill _summaries_ are injected every turn.
  Use the explicit aggregate slug, not an upstream alias.

### SKILL.md import/export

Skills are already Agent-Skills-shaped: `content` is the `SKILL.md` body
(frontmatter included) and `files` maps relative paths to supporting
`references/`, `assets/`, and `scripts/` content. Import is one
`record_skills` call with `title`/`description` lifted from frontmatter; export
reads `get_skills_for_mcp` and writes `content` plus each `files[path]`. Use
Code Mode (`skills.*`). `get_skills_for_mcp` resolves org scope through the
calling tedi's identity, so an org-level caller must pass a tedi id or every
lookup returns `entry: null`.

`agentSkillsFormat` is a write-only text marker for the Agent Skills spec
version; nothing reads it.

## Data Model

Schema: `packages/db/src/schema/cognitive.ts`. Queries:
`packages/db/src/queries/cognitive/`, `packages/db/src/queries/skill-usage.ts`,
`packages/db/src/queries/skill-lifecycle.ts`.

**`skill_entries`**

| Column                                                        | Notes                                                                                                     |
| ------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `id`, `organizationId`                                        | UUIDs                                                                                                     |
| `tediId`                                                      | Null = baseline org skill; set = tedi-scoped                                                              |
| `domainId`                                                    | FK `memory_domains`                                                                                       |
| `title`, `slug`, `folderPath`, `description`, `summary`       | Slug is the immutable SEP-2640 identity; optional folderPath organizes the OS catalog without changing it |
| `content`                                                     | Full `SKILL.md`                                                                                           |
| `files`                                                       | JSON path → content map for supporting files                                                              |
| `inputSchema`                                                 | Expected input                                                                                            |
| `successCount`, `failureCount`, `lastUsedAt`, `avgDurationMs` | Rollups of `skill_usage_events`                                                                           |
| `revision`, `revisionReasoning`, `supersedesId`               | Version chain                                                                                             |
| `visibility`                                                  | `private` / `shared` / `org`                                                                              |
| `appId`, `toolIds`                                            | App link and orchestrated tool UUIDs                                                                      |
| `tags`, `audience`                                            | Classification; audience `["assistant"]`, `["user"]`, or both                                             |
| `preconditions`                                               | `requires`, `notWhen`, `validUntil`, `staleSince`                                                         |
| `lifecycleState`                                              | `draft` (default) / `active` / `proven` / `crystallized` / `stale` / `archived`                           |
| `paceLayer`                                                   | Derived from lifecycle (see [Pace layers](#pace-layers))                                                  |
| `reviewFlaggedAt`, `reviewFlagReason`                         | Set when a crystallized skill records a failure                                                           |
| `proposedByTediId`                                            | Author of a Workshop proposal                                                                             |

**`tedi_muscle_memory`** — `id`, `tediId`, `organizationId`, `kind`
(`action_template` / `correction_hook` / `project_prime`), `name`,
`description`, `r2Path`, usage/success/failure counts, `lastUsedAt`, `origin`
(`manual` / `crystallized` / `from_skill` / `from_correction`), `sourceSkillId`.

**`skill_usage_events`** — the usage ledger. One row per execution or direct
report, with `tediId`, `skillId`, `runId`, `executionEpoch`, `source`
(`workflow_run` / `muscle_memory` / `direct`), `outcome`, `error`, timing. A
unique `(runId, executionEpoch)` index makes stamping idempotent, and the same
write maintains the `skill_entries` rollups.

- Workflow runs are stamped automatically when `apps/skill-runtime` reconciles
  a `skill_runs` row to `completed` / `failed`. Cancelled and never-executed
  runs are skipped. The reconcile CAS pins the stamp to the epoch it observed,
  and a reconcile that loses the CAS against an already-terminal, unstamped row
  re-stamps it.
- Muscle invocations with a `sourceSkillId` stamp through `muscle.usage`;
  direct self-reports go through `skills.usage`.
- **Only `source="workflow_run"` rows from a terminal `skill_runs` row count
  toward promotion.** Direct and muscle rows are telemetry. A caller-supplied
  `runId` on `skills.usage` is correlation metadata, not proof of execution; a
  direct report whose `runId` names an existing `skill_runs` row is rejected
  (`run_reserved`) so it cannot pre-claim the workflow's slot.
- `read_skill` records a tool observation only. Reads do not count as usage,
  boost ranking, or keep a draft alive.

Key helpers: `createSkillEntry()`, `applySupersedes()`,
`recordSkillUsageEvent()` (the one usage recorder), `recordSkillRunOutcome()`,
`crystallizeMuscleFromSkill()` (the only writer of `crystallized`),
`assertSkillLifecycleTransition()` (enforced inside `updateSkillEntry()`),
`nextSkillLifecycleState()`, `sweepExpiredDraftSkills()`.

## oRPC API

Contract: `packages/api-contract/src/contracts/cognitive.ts`. Router:
`apps/api/src/rpc/routers/cognitive.ts` with `cognitive-skill-*.ts` and
`cognitive-muscle.ts` siblings.

| Endpoint                             | Purpose                                                                                                                                                       |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `skills.record`                      | Create a draft skill. Non-draft creation is rejected.                                                                                                         |
| `skills.improve`                     | Update content, bump revision, update lifecycle/preconditions. Upward lifecycle changes hit the execute-to-promote gate; `force: true` is human/API-key only. |
| `skills.delete`                      | Delete a skill.                                                                                                                                               |
| `skills.listByOrg`                   | Filtered list; returns `{ entries[], total }`.                                                                                                                |
| `skills.listByApp`                   | List by `appId`/`appSlug`; returns `{ skills[] }`. Drafts excluded by default.                                                                                |
| `skills.getForMcp`                   | Resolve a skill for MCP resource serving.                                                                                                                     |
| `skills.move`                        | Move a skill to an optional catalog folder without changing slug, URI, or revision.                                                                           |
| `skills.find`                        | Text search.                                                                                                                                                  |
| `skills.usage`                       | Direct usage report. Telemetry only; can contribute failure signals but never advances lifecycle.                                                             |
| `skills.sweepDraftTtl`               | Archive zero-usage drafts past their TTL (org-scoped, `dryRun` defaults true). A daily scheduled job runs it fleet-wide at 14 days.                           |
| `skills.promote`                     | Promote a tedi-scoped skill to the org baseline.                                                                                                              |
| `skills.mineCandidates`              | Trajectory mining (see below).                                                                                                                                |
| `skills.portfolioBalance`            | Org-wide pace-layer distribution.                                                                                                                             |
| `muscle.list` / `register` / `usage` | Muscle memory CRUD and usage.                                                                                                                                 |
| `muscle.crystallize`                 | Promote a proven skill to muscle memory; marks the source `crystallized`.                                                                                     |

All require `tedis:read` or `tedis:update`. The shapes of `listByOrg`
(`entries[]`) and `listByApp` (`skills[]`) differ; do not interchange them. The
native Tedi MCP `list_skills` tool normalizes both into `entries[]`.

## Lifecycle and Promotion

### Lifecycle states

Advancement is **execute-to-promote**: every upward transition is checked
against `source="workflow_run"` rows in `skill_usage_events` inside the db
write path (`assertSkillLifecycleTransition()` in
`packages/db/src/queries/skill-lifecycle.ts`, called by `updateSkillEntry()`).
No handler, tool, or script can promote a skill that never ran. Demotion and
archival always pass.

| State          | Meaning                               | Transition rules                                                                                                           |
| -------------- | ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `draft`        | Default for every new skill           | → `active` needs ≥1 verified workflow success. Zero-usage drafts archive after 14 days of inactivity.                      |
| `active`       | Executed at least once                | → `proven` needs ≥5 verified successes and no unrecovered failure in the last 10 events. 3 consecutive failures → `draft`. |
| `proven`       | Reliable; candidate for muscle memory | → `crystallized` only through `muscle.crystallize` or an operator force. 3 consecutive failures → `active`.                |
| `crystallized` | Promoted to muscle memory             | Never auto-demotes; a failure sets `reviewFlaggedAt` / `reviewFlagReason` for review.                                      |
| `stale`        | Quarantined or preconditions outdated | → `active` through the same ≥1-success gate, or → `archived`.                                                              |
| `archived`     | Retired                               | Reviving re-enters through the execution gates.                                                                            |

A failure is **recovered** once ≥2 consecutive verified successes follow it.
Self-reported success never erases a failure. Signed-in humans and operator API
keys may override with `force: true`; agent, M2M, and service callers are
rejected (see [agent-capability-mutation-gate](../decisions/agent-capability-mutation-gate.md)).
Draft skills are excluded from app listings unless a review surface opts in.

### Ownership and visibility

| Ownership          | `tediId`    | Meaning                                                           |
| ------------------ | ----------- | ----------------------------------------------------------------- |
| Baseline org skill | `NULL`      | Accepted org capability, discoverable by every tedi in the org.   |
| Tedi-scoped skill  | a tedi UUID | That tedi's working set: drafts, candidates, personal procedures. |

`visibility` qualifies access within a tier. Baseline `private` skills are
hidden from tedi discovery; baseline `shared`/`org` skills are visible to all
tedis. A tedi-scoped skill is visible only to its tedi, whatever its
visibility — setting `shared` is **not** a promotion. The predicate is
`readableSkillCondition()` in `packages/db/src/queries/cognitive/skill-crud.ts`.

Ownership changes are attach-only: `improve_skills` can give an ownerless skill
a tedi (for example, a scheduled skill needs one), but cannot transfer it
between tedis. The only tedi → org move is promotion.

`promote_skill` defaults to `dryRun: true`. Applying it clears `tediId`, sets
visibility (default `org`), moves draft/stale/archived candidates to `active`
unless a target is given, keeps `proven`/`crystallized`, optionally sets
`supersedesId`, and bumps revision. The lifecycle write still passes the
execute-to-promote gate (`SKILL_LIFECYCLE_TRANSITION_BLOCKED`) unless a human or
API key forces it. Promotion updates the row in place, so the pre-promotion
candidate is not kept as a separate row.

Scheduled skills cannot be promoted: a `capabilities.schedule` requires an
owning tedi, so `promote_skill` throws `SKILL_SCHEDULE_INVALID`. Activate a
scheduled tedi-owned skill with
`improve_skills({ id, lifecycleState: "active", force: true })`, which requires
a signed-in human or operator API key. This is the intended human-in-the-loop
handshake for scheduled automation.

`applySupersedes()` hides a baseline skill from a tedi whose own skill
supersedes it.

### Skill Workshop

The governed path for creating reusable skills, built on `skill_entries`:

| Tool                        | Effect                                                                                                        |
| --------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `propose_skill`             | Create a tedi-scoped `draft`. Not injected as org guidance.                                                   |
| `inspect_skill_proposal`    | Read-only: validation diagnostics, promotion blockers, field changes apply would make.                        |
| `revise_skill_proposal`     | Update in place, bump revision, append reasoning, stay `draft`.                                               |
| `apply_skill_proposal`      | Promote into the org baseline (`tediId` cleared, org visibility, `active` unless a stronger target is given). |
| `reject_skill_proposal`     | Archive with a reason.                                                                                        |
| `quarantine_skill_proposal` | Mark `stale` with a reason.                                                                                   |

`apply_skill_proposal` is **disposer-separated**: the identity that proposed a
skill never approves it. Humans and operator API keys pass; a tedi may apply
only a different identity's proposal (author recorded in
`proposed_by_tedi_id`) and needs `mcp:skills`; anonymous machine credentials
are rejected. Because a separate identity approved it, apply is the sanctioned
override of the execute-to-promote gate. A tedi applier is capped at `active`
(`clampLifecycleToTediForceCeiling`); a higher request is applied at `active`
and annotated `TEDI_APPLY_LIFECYCLE_CLAMPED`. The db layer re-asserts both rules
(`assertForcedSkillPromotionAuthority`) and fails closed when no author is
recorded.

Apply only after `inspect_skill_proposal` shows no errors or blockers. Applying
never runs a workflow the proposal contains.

**Premortem.** Moving a skill into the record layer (`crystallized`) or changing
record-layer content via `apply_skill_proposal`, `skills.promote`,
`skills.improve`, or `muscle.crystallize` requires
`premortem: { failureModes: string[≥2 distinct], rollback }`, enforced by
`assertSkillPromotionPremortem` (`apps/api/src/services/decision-hygiene.ts`) and
appended to `revisionReasoning`. A human or operator API key may waive it with
`skipPremortemReason`; agent callers cannot.

**Adjacency warning.** Direct skill creation runs a lexical adjacency check
(`apps/api/src/rpc/routers/cognitive-skill-shared.ts`); near misses may get a
`SKILL_SEMANTIC_ADJACENCY` warning pointing at the existing skill. It is advice
and never blocks creation.

### Governed workflow improvement

Workflow revisions use a stricter path than general proposals:

1. `propose_skill_workflow_improvement` names a terminal baseline run and
   creates a private tedi-owned draft pinned to the baseline skill, revision,
   run, and source hashes. Identical source is rejected; drafts are never
   scheduled.
2. The tedi runs and iterates on the draft explicitly.
3. `inspect_skill_workflow_improvement` re-validates and reports baseline drift.
4. `activate_skill_workflow_improvement` is human-only and requires a completed
   run of that exact proposal whose result has `certification.passed: true` (or
   `overallStatus: "passed"`).
5. Activation fails on drift, updates the skill in place, bumps its revision,
   reconciles its schedule, and archives the proposal.

`promote_skill` and `apply_skill_proposal` refuse workflow-improvement drafts.
The certification result is a correctness check, not a security attestation.

### Trajectory mining

A deterministic miner (no LLM) turns recurring successful tool-call sequences
into Workshop draft proposals (`packages/db/src/queries/trajectory-mining.ts`):

- Inputs are `tedi_rationale_records` with `outcome_status = "success"`, a
  proof reference, a `run_id`, and tool-call refs within the lookback window
  (default 14 days). A skill-workflow run must also be `completed`; any other
  run id must be corroborated by run-scoped `tedi_runtime_events`, so a
  fabricated run id cannot qualify.
- A routine is a contiguous window of 2–8 tools with ≥2 distinct names and must
  recur in **≥3 distinct runs**. Sub-routines subsumed by an equally supported
  longer routine are dropped.
- A pattern is skipped when an org skill carries its `trajectory:{hash}` tag
  (any lifecycle) or a non-archived skill has the same ordered `toolIds`.
- Every tool name must resolve to exactly one `app_tools.id`; otherwise the
  whole pattern is skipped. The miner never guesses inner tools of a Code Mode
  wrapper call.

Proposals go through the normal Workshop gate and are never auto-applied or
self-applied. Surfaces: `skills.mineCandidates` / `mine_skill_candidates`
(`dryRun`, default cap of 3 proposals); an optional runtime hook on a
`skill-development` cron fire (`shouldRunTrajectoryMining` in
`apps/tedi-runtime/src/cron.ts`); and the on-demand
[`trajectory-mining`](../../apps/skill-runtime/examples/trajectory-mining/SKILL.md)
workflow, which is not scheduled.

### Pace layers

`skill_entries.pace_layer` is derived from lifecycle at write time
(`paceLayerForLifecycle()`):

| Layer             | Lifecycle                    | Governance                              |
| ----------------- | ---------------------------- | --------------------------------------- |
| `innovation`      | `draft`, `stale`, `archived` | Light gates, draft TTL                  |
| `differentiation` | `active`, `proven`           | Execute-to-promote gates                |
| `record`          | `crystallized`               | Agent-caller mutations require approval |

Per-layer policy is config (`paceLayerPolicy` in
`packages/db/src/schema/control-plane.ts`, defaulting to
`DEFAULT_PACE_LAYER_POLICY`). Enforced today: an agent-authenticated update to a
crystallized skill's `content`, `files`, `inputSchema`, or `agentSkillsFormat`
fails with `RECORD_LAYER_MUTATION_REQUIRES_APPROVAL`. A manual layer override
needs the same human/API-key `force` and is re-derived on the next transition.

`get_skill_portfolio_balance` reports the org-wide layer distribution with a
`stagnation` flag (all-innovation = churn, all-record = rigidity). It is
org-wide on purpose: org skills have no `tediId`, so a tedi filter would miss
them.

## Runtime Delivery to Tedis

The Agent runtime (`apps/tedi-runtime/src/do.ts`) surfaces skills three ways:

- **Skill guidance** (`skillGuidanceAddendum`) — a capped, summary-only list of
  the tedi's own skills, cached in DO SQLite and rebuilt behind the turn
  (`SkillGuidanceTurnGate`), so a skill recorded now is visible next turn
  without blocking. The tedi reads a full body on demand with `read_skill`.
- **Act-time retrieval** (`retrievedSkillsAddendum`, core in
  `packages/context-core/src/skill-retrieval.ts`) — ranks the org-readable skill
  corpus (cached by `skill-retrieval-corpus-store-do.ts`) against the turn's
  user text by significant-word overlap over title, summary, description, tags,
  and `toolIds`, with a relevance floor. Ties break by lifecycle
  (crystallized > proven > active; **drafts, stale, and archived are never
  retrieved**) then by recency-weighted success. When more candidates exist
  than K, the API may rerank within the eligible pool; it cannot add an
  ineligible skill, and failures keep the lexical order. Top-K (default 2,
  ceiling 5) is injected as a token-capped block with a `read_skill` pointer.
  Knobs: `TEDI_SKILL_RETRIEVAL_TOP_K` (0 disables) and
  `TEDI_SKILL_RETRIEVAL_MIN_OVERLAP`. Each injection writes a
  `context.injected` event with `source: "skill-retrieval"`; it is not a usage
  row, because retrieval is not execution.
- **Crystallizer** — detects repeated procedural patterns
  (`packages/context-core/src/crystallizer.ts`) and records private draft
  skills or muscle candidates through
  `apps/tedi-runtime/src/brain/crystallizer.ts`, deduped against existing
  skills.

The guidance and retrieval blocks never inject full bodies, mutate skills, or
run workflows.

**Measuring retrieval.** `analytics.getSkillRetrievalUtility` reports each
injected skill as `unknown` unless the same turn named a workflow run, the
`skill_runs` row pins that turn and skill, and a terminal usage row records the
outcome. Missing data stays `unknown`, not "unused". This measures
retrieved-to-executed outcomes, not whether the skill text helped.

**Human effect.** A signed-in org member may record
`skills.recordRunEffectObservation` (`confirmed` / `contradicted` /
`uncertain` + reference + note) for a terminal run linked to a Work Item with
an accepted outcome. It is the user's attestation, not verification; tedis and
API keys cannot record it for a user. `skills.getRunUsefulness` is a read-only,
separately billed model assessment of up to five observations against that
outcome, returning `supports`, `contradicts`, or `unknown`. It changes nothing
and verifies nothing; each call may bill a new judgment, so do not poll it.

## Validation

### SKILL.md structure

```
{skill-name}/
├── SKILL.md
├── references/   # optional
├── scripts/      # optional; never auto-executed from MCP-served skills
└── assets/       # optional
```

Hard failures: missing frontmatter; missing `name` or `description`; `name`
not matching `^[a-z0-9]+(-[a-z0-9]+)*$` or over 64 chars; final URI segment ≠
`name`; nested `SKILL.md`; empty body; frontmatter declaring executable hooks
or auto-run commands.

Warnings: missing `summary`; vague `description`; body over ~500 lines without
`references/`; links to unpackaged files; unresolved tool references; `toolIds`
stored as names instead of UUIDs; app-scoped skill on an app whose tools are
not materialized.

`skills.validate` / `validate_skills` returns
`{ severity, code, message, path }` issues without mutation. It does **not**
check executable-workflow requirements: a skill with `scripts/workflow.ts` but
no `capabilities` manifest validates as an instruction skill.
`preview_skills` returns a rendered projection that strips `capabilities:`; to
verify a stored manifest, read the raw row.

### Tool coverage

`audit_skill_tool_coverage` reports skills without resolved tools, tools not
covered by any active skill, unresolved
`metadata."io.modelcontextprotocol/tools"` names, and read-only tools without
`outputSchema`. Run it after catalog sync, OpenAPI import, or promotion:

```ts
await codemode.audit_skill_tool_coverage({ appSlug: "tedix", summary: true });
```

First-party apps must declare `outputSchema` on read-only tools and resolve all
skill metadata. Upstream third-party MCP servers Tedix proxies but does not own
are excluded by policy, not treated as backlog. Catalog sync supplies an object
schema for read-only tools whose upstream omits one.

### Repair and cleanup

- `repair_skill({ slug, dryRun: true })` normalizes stored content and
  backfills UUID `toolIds` from tool metadata; review before applying.
- `audit_low_quality` lists weak candidates with reason codes; archive mode
  needs an exact slug or bulk confirmation and never deletes rows.
- `improve_skills` accepts a new lowercase kebab-case `slug`; a rename is
  rejected when another non-archived skill owns it.

### Non-guarantees

- Preconditions (`requires`, `notWhen`, `validUntil`, `staleSince`) are stored
  and shown at retrieval, but the runtime does **not** check them against
  session context before a skill is used, and muscle memory has no
  preconditions.
- Nothing measures semantic drift between revisions; revision history and the
  usage ledger are the only signals.
- Deduplication is exact (trajectory hash, identical `toolIds`) plus the
  advisory adjacency warning; near-duplicate skills can still be recorded.

## Muscle Memory

Muscle memory holds compact, proven action patterns for fast recall:

| Kind              | Purpose                   |
| ----------------- | ------------------------- |
| `action_template` | Reusable action sequences |
| `correction_hook` | Error-prevention patterns |
| `project_prime`   | Project initialization    |

- **From a skill:** `muscle.crystallize` requires an org-scoped source skill,
  ≥5 verified workflow successes with no unrecovered failure, a premortem (or
  logged human skip), and a non-author approver. It is enforced at both the
  handler and `crystallizeMuscleFromSkill()`.
- **Direct registration** creates a candidate that enters normal recall only
  after `successCount >= 5` and `failureCount == 0`. A percentage success rate
  is not an alternative path.
- `list_muscle_memories` / `recall_muscle_memory` hide unproven candidates by
  default; `includeUnproven: true` is the administrative inventory. Executable
  entries without a non-empty namespace allowlist are never injected.
- Entries are bridged into the tedi workspace (`memory/muscle-memory.md`)
  through the per-tedi repo and context assembly. Workspace templates that wire
  skill development in (`AGENTS.md`, `HEARTBEAT.md`, `TOOLS.md`) live in
  `packages/context-core/src/tedi-workspace.ts`.

## Executable Skills (Skill Workflows)

A skill becomes executable when it ships `scripts/workflow.ts` alongside
`SKILL.md`. **Cloudflare Workflows owns execution**: steps, attempts, retries,
waits, rollback, pause/resume, restart. `@cloudflare/dynamic-workflows` only
routes a run to its tenant code (`createDynamicWorkflowEntrypoint` and
`wrapWorkflowBinding` in `apps/skill-runtime/src/skill-workflow.ts`). Tedix owns
identity, capability policy, source pinning, run artifacts, and the inspection
projections. Tedix does not emulate engine durability.

A tedi or operator starts a run with `run_skill_workflow(slug)`, or a declared
`capabilities.schedule` fires it through the same admission. Only the workflow
file runs. `scripts/workflow.js` is not a supported stored source; the runtime
compiles the TypeScript snapshot at dispatch.

### Sandbox

- **`SKILL.md` is never executed.**
- **`scripts/workflow.ts` runs only through the explicit workflow-run
  operation.** `run_skill_workflow`, `skills.runWorkflow`, and the internal
  service binding are the same operation.
- **No ambient network.** The Dynamic Worker has `globalOutbound: null`. Every
  outbound call goes through `env.MCP.<namespace>` (manifest-gated) or, with
  `capabilities.network: true`, through `fetch()` while a `step.do` callback or
  rollback handler is active. A platform gate module evaluated before tenant
  code replaces `fetch`, tracks floated calls, caps response bodies at 8 MiB,
  and disables Cache, WebSocket, EventSource, and beacons.
- **Static imports only.** Before loading, the compiled module is parsed with
  `es-module-lexer`: only a static `cloudflare:workflows` import is allowed.
  Relative/platform imports, re-exports, dynamic `import()`, and `import.meta`
  fail closed. Loader flags `disallow_eval_during_startup` and
  `disallow_importable_env` are set.
- **Monkeypatch-resistant.** The gate captures the primitives it relies on
  before tenant code runs; `__RUN_CONTEXT__` is structured-cloned and frozen,
  and bridge routing reads the trusted snapshot.
- **Limits.** WorkerCode and `getEntrypoint()` enforce `cpuMs: 60_000` and
  `subRequests: 1_000`.
- **Capability-gated.** Anything not declared in the manifest is unreachable.

**Credentials.** With `network: true`, the loader-side OutboundProxy
(`apps/skill-runtime/src/outbound-proxy.ts`) injects platform API keys by host,
so tenant code calls provider hosts with no key. Unknown hosts are forwarded
without credentials, and credential-bearing requests use `redirect: "manual"`
so a redirect cannot leak the key. **Never put secrets in `params`**:
dynamic-workflows persists the dispatch envelope and exposes it through
`instance.status()`. Use `params` for non-secret input and the proxy for auth.
See `apps/skill-runtime/examples/gemini-media/` for a provider call through the
proxy.

**Loader cache identity.** Loader ids are cache hints, keyed
`${skillId}:${tediId}:${runId}:${executionEpoch}:${loaderConfigHash}`. The
config hash covers source, manifest, namespace routing, deployment, runtime
surface, and one-way secret versions. A separate `executionCompatibilityHash`
excludes deploy identity and credentials and fences resume of an existing
epoch, so a deploy or key rotation can recreate the Loader without killing the
epoch. Bump `WORKFLOW_BRIDGE_COMPATIBILITY_VERSION` in
`apps/skill-runtime/src/runner.ts` whenever bridge or host orchestration
semantics change. Isolates may be evicted at any time; correctness never
depends on in-memory state.

### Capability manifest

```yaml
---
name: blog-migrate
description: Migrate blog posts from an external source into the CMS.
capabilities:
  network: false
  mcp:
    source_docs: [search, get_page]
    firecrawl: [firecrawl_scrape]
    cms_example: [content_create, content_publish, content_delete]
  expectedAnnotations:
    destructive: true # this workflow may call content_delete in rollback
    readOnly: false
  schedule:
    cron: "0 8 * * 1" # UTC, five-field cron
    params: { mode: "weekly" }
    enabled: true
---
```

- `network: true` permits `fetch()` only inside `step.do` or rollback. Default
  `false`.
- `mcp.<namespace>: [methods]` is the allowlist for
  `env.MCP.<namespace>.<method>(args)`; anything else throws
  `CAPABILITY_NOT_DECLARED`.
- `expectedAnnotations` is forwarded on every call as
  `_meta["com.tedix/expectedAnnotations"]`. A contradicting tool fails with
  `ANNOTATION_VIOLATION` before it runs. `destructive` defaults to `false`, so
  workflows fail closed on destructive tools unless they opt in. `readOnly:
true` rejects any tool without `readOnlyHint === true`.
- `grounding` (optional) declares the skill's standard of proof for
  `env.EVIDENCE` citation checks.
- `reason` (optional) enables `env.REASON` (below).
- `rationale.mode` is `off`, `important` (default), or `all` (currently the same
  as `important`).
- `schedule` (optional) is projected into `skill_schedules`; a periodic API scan
  fires due rows through normal admission with a deterministic idempotency key
  and `createdBy: "schedule"`. Draft, stale, and archived skills never fire. Use
  the tedi `cron` tool for conversational turns instead.

**Namespace names.** Manifest keys must be JS identifiers (use underscores).
`resolveNamespaceSlugs()` maps a friendly name to an app slug at boot: exact
`apps.slug` match, then `${name}-tedix`, then `_` → `-`. For an aggregate app,
the bridge retries a tool-not-found with the unique `{source}__{method}` name
from `tools/list`, so manifests never hardcode aggregate prefixes. The reserved
`env.MCP.tedi` namespace is a curated projection; run `tedix flow tools` (or
`flow.tools({ tediSlug })`) to get its exact method inventory.

### `env.EVIDENCE` and `env.REASON`

`env.EVIDENCE` checks citations host-side: scraping, exact/entailment verdicts,
and scoring happen outside the tenant isolate, and a workflow cannot author
`verified: true`.

`env.REASON.ask({ prompt, key })` is the fan-out reasoning primitive
(`apps/skill-runtime/src/reason.ts`, `reason-core.ts`). Each distinct `key` is a
separate tool-free Pi child Durable Object with empty state (session prefix
`WORKFLOW_SYNTH_SESSION_PREFIX`), so `Promise.all` over N keys runs N
independent reasoners that never touch the tedi's memory. Use
`env.MCP.<tedi>.run_tedi_turn` instead when you want that tedi's own judgment;
a tedi is one Durable Object, so concurrent turns queue.

```yaml
capabilities:
  reason:
    maxCalls: 5
```

- Undeclared → `REASON_NOT_DECLARED`.
- `maxCalls` is enforced host-side and clamped to a platform ceiling. Exhausting
  it throws rather than silently returning fewer voters.
- Calls must run inside `step.do`. The attempt is excluded from call identity,
  so an engine retry reuses the same call instead of re-billing; fresh samples
  need a different `key`.
- Reasoning is not grounding: only `env.EVIDENCE` decides whether a claim is
  supported.
- Every exchange is sealed to `reason/<n>-<key>-<hash>.json`. An unreachable
  reasoner returns `{ empty: true }` so K voters degrade to K−1.

### Workflow code shape

```ts
import { NonRetryableError } from "cloudflare:workflows";

export default {
	async run(event, step, env) {
		const posts = await step.do(
			"list-posts",
			{
				retries: { limit: 3, delay: "2 seconds", backoff: "exponential" },
				timeout: "2 minutes",
			},
			() => env.MCP.source_docs.search({ query: "blog", page_size: 20 }),
		);
		for (const post of posts) {
			await step.do(
				`migrate-${post.id}`,
				{ retries: { limit: 1, delay: "3 seconds" }, timeout: "5 minutes" },
				async () => {
					const page = await env.MCP.source_docs.get_page({ id: post.id });
					if (!page.url) throw new NonRetryableError("Page has no URL");
					const md = await env.MCP.firecrawl.firecrawl_scrape({
						url: page.url,
						format: "markdown",
					});
					const created = await env.MCP.cms_example.content_create({
						slug: page.slug,
						body: md,
					});
					await env.MCP.cms_example.content_publish({ id: created.id });
					return created;
				},
				{
					rollback: async ({ output }) => {
						if (output?.id) {
							await env.MCP.cms_example.content_delete({ id: output.id });
						}
					},
					rollbackConfig: { retries: { limit: 2, delay: "1 second" } },
				},
			);
			await step.sleep(`pace-${post.id}`, "5 seconds");
		}
		return { migrated: posts.length };
	},
};
```

Primitives:

- `step.do(name, [config,] fn, [rollbackOptions])` — the callback receives
  Cloudflare's context `{ step: { name, count }, attempt, config }`. Network and
  MCP calls belong here. Omitted config takes Cloudflare's defaults; pass
  explicit config for mutations. `retries` must include `delay`
  (`{ limit, delay, backoff? }`) — a partial object fails the whole run.
- `NonRetryableError` — fail immediately on permanent input or policy errors.
  The bridge maps capability, annotation, auth, and non-transient 4xx failures
  to it.
- `config.sensitive: "output"` — Cloudflare hides the step output and Tedix
  redacts mirrored output, MCP receipts, and failure artifacts. It does not
  redact inputs, logs, external side effects, or values copied into later
  steps. Local Wrangler currently rejects this config, so do not rely on it for
  secrets; never return secrets from steps.
- `rollbackOptions: { rollback, rollbackConfig? }` — compensating handlers run
  in reverse step-start order when the workflow fails (the failing step's
  handler gets `output: undefined`). Rollback is not exactly-once; make it
  idempotent.
- `step.sleep(name, duration)`, `step.sleepUntil(name, timestamp)`.
- `step.waitForEvent(name, { type, timeout })` — `type` is required (1–100
  ASCII letters, digits, `-`, `_`) and is what event delivery matches.
- `env.MCP.<namespace>.<method>(args)` — calls the loader-side `McpBridge`,
  which checks the manifest and dispatches to `apps/mcp` over a service
  binding. It returns the normalized value: `structuredContent` if present,
  otherwise text blocks joined and JSON-parsed when possible. Errors and
  input-required results reject.
- `console.log` — captured to the run log.

The runner accepts `(event, step)` or `(event, step, env)`. Type annotations
are stripped. Top-level side effects are rejected by validation.

**Idempotency keys.** Each `env.MCP` call carries a key derived from run,
execution epoch, step identity, phase, namespace, method, and call ordinal — but
not the attempt, so a retry reuses the key. A restart opens a new epoch and a new
key space. The key is **requested**, not guaranteed: the receipt keeps
`providerConfirmation: "unknown"` unless the tool result carries an explicit
`completionEvidence.providerConfirmation` from a trusted adapter (today only
`gmail_send`). Write steps and rollbacks must tolerate duplicate delivery.

Before a callback closes, the shim drains its tracked `fetch` and `env.MCP`
promises with `Promise.allSettled()`, so a missing `await` cannot let work
escape the step.

### Run lifecycle

`run_skill_workflow`, `cancel_skill_workflow`, `restart_skill_workflow`,
`approve_skill_workflow`, `reject_skill_workflow`, and
`send_skill_workflow_event` are destructive-governed. Stateless clients such as
`tedix code` pass `confirmDestructive: true` and a `reason`.

1. **Admission.** `run_skill_workflow({ skillId | slug, params, runId?,
idempotencyKey?, workItemId? })` validates the skill and sends the pinned
   `scripts/workflow.ts` + `SKILL.md` snapshot to `apps/skill-runtime`. The
   runtime inserts the `skill_runs` row with a
   `WORKFLOW_ADMISSION_PENDING` marker, admits a submission `sub:{runId}`, and
   creates the Cloudflare instance with `id = runId`; only accepted creation
   moves the row to `queued`. A `workItemId` is org-validated, pinned to the run,
   and propagated to every MCP call and receipt.
2. **Dispatch.** The shim (`dispatch.js`, injected by
   `apps/skill-runtime/src/runner.ts`) wraps the default export in a
   `WorkflowEntrypoint`, builds `env.MCP` as a Proxy, and calls `run`. The
   isolate only gets capability bindings (`__MCP_BRIDGE__`,
   `__ARTIFACT_BRIDGE__`, `__RATIONALE_BRIDGE__`) and non-secret
   `__RUN_CONTEXT__`; tenant `env` is `{ MCP, __RUN_CONTEXT__ }`. D1, R2, service
   bindings, and tokens stay loader-side.
3. **MCP calls.** `McpBridge` posts a JSON-RPC `tools/call` to the app's MCP
   endpoint over a service binding authenticated with `PLATFORM_SERVICE_TOKEN`
   and `X-Tedix-*` identity headers. MCP task recovery allows up to 180s for a
   long tedi call, under a 240s bridge guard; size the step timeout above that.
4. **Status.** `get_skill_workflow_status({ runId })` returns persisted state
   plus the live engine snapshot; `inspect_skill_workflow_run` adds the pinned
   revision, artifacts, steps, and tool calls (source only with
   `includeSource`).
5. **Pause/resume/restart.** Restart without `from` replays from the start;
   with `{ from: { name, count?, type? } }` it reuses cached results before that
   step. Restart needs a caller-stable `restartId` (1–128 chars). Tedix reserves
   a new `execution_epoch` and records a restart intent before calling the
   engine exactly once; same-id retries repair bookkeeping without restarting
   again. If a restart's delivery is ambiguous and the reserved epoch has no
   start record, an operator can resolve it with the same `restartId` and
   `from`, `abortUnknown: true`, and a `reason`: the run is cancelled, the
   instance is permanently retired (`WORKFLOW_INSTANCE_RETIRED`), and new work
   needs a new run id.
6. **Cancel.** `cancel_skill_workflow({ runId, rollback? })` records the intent
   first, so reconciliation retries a lost terminate. `rollback: true` runs
   compensation first; an engine outcome that is already terminal wins. Idle
   waits hibernate at near-zero cost.
7. **Events.** `send_skill_workflow_event({ runId, type, payload })` is **not
   idempotent**; inspect before retrying an ambiguous send, and include a
   business id in the payload if the workflow needs dedupe.
   `approve_skill_workflow` / `reject_skill_workflow` deliver the standard
   `approval` event, require an `approvalId`, and deduplicate through a
   per-epoch receipt.

Every lifecycle control carries `expectedExecutionEpoch`. On terminal engine
observation, the runtime settles the submission for that exact epoch before
writing `skill_runs.status`; any mismatch leaves the run active for
reconciliation. Unresolved admission blocks all controls, and an open restart
intent blocks everything except restart replay/abort.

**No continue-as-new.** For work that may hit the per-instance step limit, end
with a compact checkpoint and start a successor run with a new `runId`. Do not
use restart for this; restart keeps the same instance identity.

**Conformance fixture.**
[`apps/skill-runtime/examples/runtime-proof/`](../../apps/skill-runtime/examples/runtime-proof/SKILL.md)
(`workflow-kitchen-sink`) exercises steps, retries, `NonRetryableError`,
timeouts, sensitive output, sleeps, MCP calls, network policy, parallel and
dynamic steps, artifacts, a tedi turn, approvals/events, rollback, and lifecycle
controls. Engine completion and scenario assertions are reported separately: a
run can complete while its certification fails.

### `skill_runs`

Defined in `packages/db/src/schema/cognitive.ts`.

| Column                                                         | Notes                                                                                    |
| -------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `id` = `workflow_instance_id`                                  | Run UUID, also the Cloudflare instance id                                                |
| `organization_id`, `skill_id`, `tedi_id`                       | FKs                                                                                      |
| `status`                                                       | `queued` / `running` / `paused` / `completed` / `failed` / `canceled`                    |
| `execution_epoch`                                              | Zero-based; restart increments it before calling the engine                              |
| `restart_requested_at`, `restart_command_id`                   | Restart fence and the winning command                                                    |
| `workflow_retired_at`                                          | Permanent tombstone; later restarts and factory entry fail closed                        |
| `runtime_environment`                                          | Which workflow binding owns the instance                                                 |
| `last_reconciled_at`                                           | Fair-scan cursor for reconciliation                                                      |
| `params`, `result`, `error`                                    | Input, terminal output, failure or `REVOKED[: reason]` marker                            |
| `capability_manifest`                                          | Declared capabilities at run time                                                        |
| `cost_summary`                                                 | Best-effort rollup (steps, retries, MCP calls, durations) for the current terminal epoch |
| `workflow_source`, `skill_doc`, `skill_revision`, `skill_slug` | Pinned snapshot; no live-skill fallback during execution                                 |
| `started_at`, `completed_at`, `paused_at`, `created_by`        | Timing and invoker                                                                       |

### Scheduled inference

Schedules are deterministic unless the manifest sets
`executionKind: inference`. An inference schedule must export
`eligibility(event, step, env)`, called before `run()`:

- `eligible` — `run()` may call a model.
- `no_work` — inputs read fine but nothing to do; `run()` is skipped and the run
  completes with outcome `no_change`.
- `unavailable` — inputs could not be read; the run fails with
  `BACKGROUND_INPUT_UNAVAILABLE`. Unavailable never counts as zero.

Eligibility and the required top-level `backgroundOutcome` (schema version 1,
classification `no_change` / `observation` / `proposal` / `verified_action` /
`partial` / `failed`) both carry an `inputWatermark` and references, sealed as
`background/eligibility.json` and `background/outcome.json`. `skill_runs.status`
still describes engine completion; writing a receipt is not a verified action.

### Run rationale

Runs write rationale records at four gates, each with
`evidence.runUri = "skill://runs/{runId}"`:

| Gate                    | Where                            | Outcome                                       |
| ----------------------- | -------------------------------- | --------------------------------------------- |
| `workflow_dispatch`     | `apps/api` + terminal reconciler | `pending` → `success` / `failure` / `partial` |
| `wait_for_event_pause`  | dispatch shim                    | open                                          |
| `wait_for_event_resume` | dispatch shim                    | `success`                                     |
| `step_do_failure`       | dispatch shim                    | `failure` with `evidence.blameChain`          |

Per-step success records are deliberately not written. `RationaleBridge`
forwards to `rationaleRecords.create` through the loader-side API binding with
identity from bridge props, so tenant code cannot spoof provenance. Each call
has a semantic idempotency key, so replays after hibernation return the
original record. The dispatch record stays `pending` until the terminal CAS
reconciles it to the run's real outcome.

### Observability

Run receipts and artifacts live in R2 under the run
(`skill://{slug}/runs/{runId}/{path}`, including `timeline.json`). The status,
inspection, step, tool-call, revision, reliability, schedule, and history tools
below project them. `skills.revokeSkillRun` is the destructive cleanup path: it
retires a terminal run, then removes artifacts and facts sourced from
`skill://runs/{runId}` while keeping the audit row. It is on the API/admin
surface, not the tedi workforce projection.

### MCP tools

**Admin app (`tedix`)** — D1 `app_tools` rows executed by `ToolHandler`
(`apps/mcp/src/mcp/handler.ts`):

- Skills: `record_skills`, `improve_skills`, `delete_skills`,
  `list_skills_by_org`, `list_skills_by_app`, `find_skills`,
  `get_skills_for_mcp`, `usage_skills`, `validate_skills`, `repair_skills`,
  `preview_skills`, `audit_low_quality`. `record_skill` / `improve_skill` set
  `allowExplicitAppId: true` so a caller may target a different app.
- Muscle: `list_muscle_memories`, `register_muscle_memory`,
  `crystallize_muscle_memory`, `track_muscle_usage`.
- Knowledge: `synthesize_knowledge`, `opine_knowledge`, `list_knowledge`,
  `get_knowledge`.

**Tedi workforce namespaces** — a curated RPC projection in
`apps/mcp/src/mcp/aggregate-tedis.ts` and `aggregate-tedis-skill-workflows.ts`
that maps stable tool ids to `skills/*` endpoints and injects the selected tedi
and org. These are not D1 rows and not a second engine. Update these schemas
when a `skills` contract changes.

| Tool                                                                                                                                             | Purpose                                                                                      |
| ------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------- |
| `list_skills`, `read_skill`, `read_resource`                                                                                                     | Compact list (with `hasWorkflow`), full body, `skill://` resource reads. Never execute code. |
| `validate_skill`, `preview_skill`, `repair_skill`, `audit_low_quality`                                                                           | Validation and cleanup (see [Validation](#validation)).                                      |
| `propose_skill`, `inspect_skill_proposal`, `revise_skill_proposal`, `apply_skill_proposal`, `reject_skill_proposal`, `quarantine_skill_proposal` | Skill Workshop.                                                                              |
| `promote_skill`                                                                                                                                  | Tedi-scoped → org baseline; `dryRun` by default.                                             |
| `mine_skill_candidates`                                                                                                                          | Trajectory mining.                                                                           |
| `propose_/inspect_/activate_skill_workflow_improvement`                                                                                          | Governed workflow revisions.                                                                 |
| `run_skill_workflow`                                                                                                                             | Start a run.                                                                                 |
| `get_skill_workflow_status`                                                                                                                      | Persisted state + engine snapshot (not a step timeline).                                     |
| `inspect_skill_workflow_run`                                                                                                                     | Run, revision, artifacts, steps, tool calls, warnings.                                       |
| `list_skill_workflow_steps`, `list_skill_workflow_tool_calls`                                                                                    | Step/attempt/rollback/wait records and MCP call receipts.                                    |
| `list_skill_workflow_revisions`, `get_skill_workflow_revision`, `compare_skill_workflow_revisions`                                               | Revisions observed on executed runs (not full edit history) and their diffs.                 |
| `get_skill_workflow_reliability`                                                                                                                 | `successRate` against the pinned policy; `completionRate` as raw completed/terminal.         |
| `list_skill_workflow_schedules`                                                                                                                  | UTC schedules with next/last fire and last error.                                            |
| `list_skill_workflow_history`                                                                                                                    | Recent runs; with no filter it is org-wide.                                                  |
| `list_skill_run_artifacts`, `get_skill_run_artifact`                                                                                             | Raw artifacts, paginated.                                                                    |
| `record_artifact`                                                                                                                                | Publish a tedi-owned artifact.                                                               |
| `pause_`, `resume_`, `restart_`, `cancel_skill_workflow`                                                                                         | Native lifecycle controls.                                                                   |
| `approve_`, `reject_skill_workflow`, `send_skill_workflow_event`                                                                                 | Approval and event delivery.                                                                 |

Use `get_skill_workflow_status` for polling and `inspect_skill_workflow_run`
for diagnosis; reach for raw artifacts only when projections are not enough.

MCP tools with `outputSchema` must keep `structuredContent` schema-clean.
Widget-only fields (`appCapabilities`, `_detailTemplate`, `_utmParams`,
`layoutSpec`) belong in `_meta`.

### Workflow validation

`skills.validate` and the pre-write gate on `skills.record` / `skills.improve`
run `validateWorkflowSource()` whenever `files["scripts/workflow.ts"]` exists.
These checks are authoring feedback; the runtime fetch gate and Loader import
parse are the real boundary.

| Code                                  | Catches                                                                                  |
| ------------------------------------- | ---------------------------------------------------------------------------------------- |
| `WORKFLOW_NO_DEFAULT_EXPORT`          | No default export                                                                        |
| `UNSUPPORTED_WORKFLOW_JS`             | `scripts/workflow.js` / `.mjs` / `.cjs` instead of `.ts`                                 |
| `WORKFLOW_DEFAULT_NOT_OBJECT`         | Default export is not an object with an async `run`                                      |
| `WORKFLOW_RUN_SIGNATURE_INVALID`      | `run` is not `(event, step)` or `(event, step, env)`                                     |
| `WORKFLOW_TOP_LEVEL_SIDE_EFFECT`      | Top-level `fetch`, timers, `new Worker`, `XMLHttpRequest`, `EventSource`                 |
| `WORKFLOW_DYNAMIC_IMPORT`             | `import(...)` anywhere                                                                   |
| `WORKFLOW_RUNTIME_IMPORT_NOT_ALLOWED` | Runtime imports other than `cloudflare:workflows`, or `require()`; `import type` is fine |
| `WORKFLOW_EVAL_OR_FUNCTION`           | `eval()` or `new Function()`                                                             |
| `WORKFLOW_NETWORK_WITHOUT_CAPABILITY` | `fetch()` without `capabilities.network: true`                                           |
| `WORKFLOW_NETWORK_OUTSIDE_STEP`       | `fetch()` not provably inside `step.do(...)`                                             |

After changing native skill tools or the workforce bridge, check the aggregate
path with a `tedix code` probe (`read_resource` on a `skill://` URI,
`run_skill_workflow` by slug). A completed
run's artifacts should show the capability-only tenant `env` and a
`timeline.json` with per-step events.

### Authoring checklist

- [ ] Frontmatter declares `name`, `description`, `audience`, and
      `capabilities.mcp.<namespace>: [methods]`.
- [ ] Frontmatter declares `metadata."io.modelcontextprotocol/tools"` for every
      covered tool.
- [ ] `scripts/workflow.ts` default-exports `{ async run(event, step, env) {} }`.
- [ ] Every `env.MCP` method is in the manifest.
- [ ] Workflows that call destructive tools set
      `expectedAnnotations.destructive: true`.
- [ ] Non-trivial `step.do` calls pass explicit `{ retries, timeout }`, with
      `delay` inside `retries`.
- [ ] Permanent failures throw `NonRetryableError`.
- [ ] No secrets in params, step outputs, or logs.
- [ ] Write steps and rollbacks tolerate duplicate delivery.
- [ ] Every `waitForEvent` passes `{ type, timeout }`; approvals use a stable
      `approvalId`.
- [ ] Long workloads checkpoint into a successor run.
- [ ] Namespace keys are JS identifiers, and the target app exists (check with
      `discover.list_namespaces()`).

## Key Files

| File                                               | Purpose                                                         |
| -------------------------------------------------- | --------------------------------------------------------------- |
| `packages/db/src/schema/cognitive.ts`              | Skill, muscle, usage, and run tables                            |
| `packages/db/src/queries/cognitive/`               | Skill query leaves (CRUD, search, validation, crystallization)  |
| `packages/db/src/queries/skill-lifecycle.ts`       | Lifecycle gate, pace layers, draft TTL                          |
| `packages/db/src/queries/skill-usage.ts`           | Usage ledger                                                    |
| `packages/db/src/queries/trajectory-mining.ts`     | Trajectory miner                                                |
| `packages/api-contract/src/contracts/cognitive.ts` | oRPC contract                                                   |
| `apps/api/src/rpc/routers/cognitive*.ts`           | Routers                                                         |
| `apps/mcp/src/mcp/tool-registration.ts`            | `enrichToolsWithSkills()`, `registerAppSkills()`, tool coupling |
| `apps/mcp/src/mcp/server-factory.ts`               | Skill catalog in server instructions                            |
| `apps/mcp/src/mcp/governance.ts`                   | Destructive-tool approval gate                                  |
| `apps/mcp/src/mcp/aggregate-tedis*.ts`             | Workforce skill and workflow tools                              |
| `apps/tedi-runtime/src/do.ts`                      | Skill guidance and act-time retrieval                           |
| `apps/tedi-runtime/src/mcp-mount.ts`               | Per-tedi `skill://` resource reads                              |
| `packages/context-core/src/skill-retrieval.ts`     | Retrieval ranking and rendering                                 |
| `packages/context-core/src/crystallizer.ts`        | Pattern detection                                               |
| `apps/skill-runtime/src/runner.ts`                 | Loader, dispatch shim, bridges                                  |
| `apps/skill-runtime/src/skill-workflow.ts`         | Dynamic-workflows entrypoint                                    |
| `apps/skill-runtime/src/outbound-proxy.ts`         | Credential-injecting egress                                     |
| `apps/skill-runtime/examples/`                     | Executable skill fixtures                                       |

## References

- [Skills Over MCP Working Group](https://github.com/modelcontextprotocol/experimental-ext-skills)
  and [SEP-2640](https://github.com/modelcontextprotocol/modelcontextprotocol/pull/2640)
- [Agent Skills specification](https://agentskills.io/specification)
- [Dynamic Workflows](https://blog.cloudflare.com/dynamic-workflows/) ·
  [cloudflare/dynamic-workflows](https://github.com/cloudflare/dynamic-workflows) ·
  [Workflows API](https://developers.cloudflare.com/workflows/build/workers-api/) ·
  [Dynamic Workers egress control](https://developers.cloudflare.com/dynamic-workers/usage/egress-control/)
- Related: [runtime.md](../mcp/runtime.md), [codemode.md](../mcp/codemode.md),
  [agent-runtime.md](../tedi/agent-runtime.md), [brain.md](brain.md),
  [work-items.md](work-items.md)
