/**
 * Execute-to-promote skill lifecycle engine (flywheel remodel WS2).
 *
 * Skills promote by verified workflow execution recorded in the
 * `skill_usage_events` ledger — never by authorship, rollup counters, or
 * direct self-reports:
 *
 * - `draft → active` requires ≥1 recorded success event for executable skills;
 *   instruction-only skills can activate without workflow execution.
 * - `active → proven` requires ≥SKILL_PROVEN_MIN_SUCCESSES ledger successes
 *   AND zero unrecovered failures in the last SKILL_PROVEN_RECENT_WINDOW
 *   events (a failure followed by ≥SKILL_FAILURE_RECOVERY_SUCCESSES
 *   consecutive successes counts as recovered).
 * - `proven → crystallized` keeps the muscle-memory bar: only
 *   `crystallizeMuscleFromSkill()` sets it (options.via === "crystallize"),
 *   and that path itself verifies the proven ledger bar, org scope, and a
 *   disposer authority before writing.
 * - Failures gate advancement. Consecutive failures drop `proven → active`,
 *   but never turn an active skill back into a draft. Flag it for review instead.
 *   Crystallized skills never auto-demote; failures flag them for review.
 * - Ordinary drafts with zero usage and unpromoted `flow-ephemeral` drafts
 *   inactive for SKILL_DRAFT_TTL_DAYS expire via `sweepExpiredDraftSkills()`.
 *
 * Enforcement lives in the transition path itself: `updateSkillEntry()`
 * (queries/cognitive/skill-crud.ts) calls `assertSkillLifecycleTransition()` for every
 * lifecycle write, so no oRPC handler or caller can bypass the gate. A
 * human/operator override is possible via `{ force: true }`, which the
 * handler layer only grants to non-agent auth (user JWT or operator API key
 * — the capability-mutation-gate allowlist doctrine).
 */

import { and, desc, eq, inArray, or, sql, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import type { DbClient } from "../client";
import { coreTable } from "../core-store/client";
import { coreStore, jsonRead } from "../core-store/dialect";
import {
	type SkillEntry,
	type SkillPaceLayer,
	type SkillUsageOutcome,
	skillEntries as d1SkillEntries,
	skillRunArtifacts as d1SkillRunArtifacts,
	skillRuns as d1SkillRuns,
	skillUsageEvents as d1SkillUsageEvents,
} from "../schema/cognitive";
import {
	DEFAULT_PACE_LAYER_POLICY,
	policyPacks as d1PolicyPacks,
} from "../schema/control-plane";
import { tedis as d1Tedis } from "../schema/tedis";
import { chunkForBoundParams } from "../utils/batch";
import { freshReadMarkExists, unusedReportNote } from "./read-marks";

export type SkillLifecycleState = NonNullable<SkillEntry["lifecycleState"]>;
export type { SkillPaceLayer };

/**
 * Pace-layer auto-classification (WS6): the strategic layer is derived from
 * lifecycle at write time. draft (and mined proposals, which are drafts) plus
 * stale/archived re-entrants → innovation; active/proven → differentiation;
 * crystallized → record. Manual overrides ride the same force-authority path
 * as lifecycle overrides and are re-derived on the next lifecycle transition.
 */
export function paceLayerForLifecycle(
	state: SkillEntry["lifecycleState"] | null | undefined,
): SkillPaceLayer {
	switch (state ?? "draft") {
		case "crystallized":
			return "record";
		case "active":
		case "proven":
			return "differentiation";
		default:
			return "innovation";
	}
}

export class SkillPaceLayerOverrideError extends Error {
	readonly code = "SKILL_PACE_LAYER_OVERRIDE_BLOCKED";
	constructor(
		message: string,
		readonly details: { skillId: string; to: SkillPaceLayer },
	) {
		super(message);
		this.name = "SkillPaceLayerOverrideError";
	}
}

/** Ledger successes required for draft → active. */
export const SKILL_ACTIVE_MIN_SUCCESSES = 1;
/** Ledger successes required for active → proven. */
export const SKILL_PROVEN_MIN_SUCCESSES = 5;
/** Recent-event window inspected for unrecovered failures. */
export const SKILL_PROVEN_RECENT_WINDOW = 10;
/** Consecutive successes after a failure that mark it recovered. */
export const SKILL_FAILURE_RECOVERY_SUCCESSES = 2;
/** Consecutive failures that demote a skill one state. */
export const SKILL_DEMOTION_CONSECUTIVE_FAILURES = 3;
/** Days an eligible draft survives before the TTL sweep archives it. */
export const SKILL_DRAFT_TTL_DAYS = 14;
export const FLOW_EPHEMERAL_SKILL_TAG = "flow-ephemeral";

/**
 * Promotion ordering. `stale`/`archived` rank with `draft` so reviving one
 * upward re-enters through the same execution gates.
 */
const LIFECYCLE_RANK: Record<SkillLifecycleState, number> = {
	archived: 0,
	stale: 0,
	draft: 0,
	active: 1,
	proven: 2,
	crystallized: 3,
};

/** Resolve the owning tedi's pack without crossing organization boundaries. */
function skillPolicyKnob(
	db: DbClient,
	layer: SkillPaceLayer | SQL,
	knob: "evalRequired" | "draftTtlDays",
) {
	const policyPacks = coreTable(db, d1PolicyPacks);
	const tedis = coreTable(db, d1Tedis);
	const skillEntries = coreTable(db, d1SkillEntries);
	// SQLite reads JSON true as 1; read booleans as 1/0 on Postgres too.
	const value =
		coreStore(db) === "postgres"
			? sql`(select case jsonb_typeof(v) when 'number' then (v #>> '{}')::numeric
            when 'boolean' then case when (v #>> '{}')::boolean then 1 else 0 end end
            from (select ${policyPacks.definition} -> 'paceLayerPolicy' -> (${layer})::text -> ${knob}::text as v) knob)`
			: sql`json_extract(${policyPacks.definition}, ${sql`'$.paceLayerPolicy.' || ${layer} || ${"." + knob}`})`;
	return sql`(select ${value}
        from ${tedis} join ${policyPacks} on ${policyPacks.id} = ${tedis.policyPackId}
        where ${tedis.id} = ${skillEntries.tediId}
        and ${tedis.organizationId} = ${skillEntries.organizationId}
        and (${policyPacks.organizationId} is null or ${policyPacks.organizationId} = ${skillEntries.organizationId})
        limit 1)`;
}

export function isSkillLifecyclePromotion(
	current: SkillEntry["lifecycleState"],
	target: SkillLifecycleState,
): boolean {
	return LIFECYCLE_RANK[target] > LIFECYCLE_RANK[current ?? "draft"];
}

/**
 * A skill coming back out of the archive unchanged is a return, not a
 * promotion: it needs no new certification when the archive recorded a state
 * at least as high as the target. A row archived before that record was kept
 * can only be returned by a signed-in person or operator key.
 */
export function isSkillReturnFromArchive(
	current: Pick<SkillEntry, "lifecycleState" | "revision" | "archivedFrom">,
	target: SkillLifecycleState,
	operatorForce: boolean,
): boolean {
	if (current.lifecycleState !== "archived" || target === "archived")
		return false;
	const from = current.archivedFrom;
	if (!from) return operatorForce;
	return (
		from.revision === current.revision &&
		LIFECYCLE_RANK[target] <= LIFECYCLE_RANK[from.lifecycleState]
	);
}

function certificationPassed(db: DbClient) {
	const skillRuns = coreTable(db, d1SkillRuns);
	const passed =
		coreStore(db) === "postgres"
			? sql`(${jsonRead(db, skillRuns.result, ["certification", "passed"], "boolean")} is true
    or ${jsonRead(db, skillRuns.result, ["certification", "passed"], "number")} = 1)`
			: sql`${jsonRead(db, skillRuns.result, ["certification", "passed"])} = 1`;
	return sql<boolean>`(
    ${passed}
    or ${jsonRead(db, skillRuns.result, ["certification", "status"])} = 'passed'
    or ${jsonRead(db, skillRuns.result, ["certification", "overallStatus"])} = 'passed'
)`;
}

/**
 * A tool call of this run that failed and was never made good. The runtime
 * keeps one record per attempt (`…/attempts/1/calls/run/1.json`), so a call
 * that failed once and passed when the engine retried its step leaves the
 * failure behind for good; it does not count once a later attempt of the same
 * step (`…/attempts/2.json`) succeeded. A failure inside an attempt that
 * itself succeeded still counts: the workflow carried on past a failed call.
 */
function unrecoveredFailedCall(db: DbClient) {
	const skillRuns = coreTable(db, d1SkillRuns);
	const skillRunArtifacts = coreTable(db, d1SkillRunArtifacts);
	const laterStepAttempt = alias(skillRunArtifacts, "later_step_attempt");
	const postgres = coreStore(db) === "postgres";
	const failedCallPath = postgres
		? sql`(${skillRunArtifacts.path} ~ 'calls/run/[0-9].*[.]json$'
        or ${skillRunArtifacts.path} ~ 'calls/compensate/[0-9].*[.]json$')`
		: sql`(${skillRunArtifacts.path} glob '*calls/run/[0-9]*.json'
        or ${skillRunArtifacts.path} glob '*calls/compensate/[0-9]*.json')`;
	const attemptsAt = postgres
		? sql`strpos(${skillRunArtifacts.path}, '/attempts/')`
		: sql`instr(${skillRunArtifacts.path}, '/attempts/')`;
	return sql<boolean>`(
    ${skillRunArtifacts.runId} = ${skillRuns.id}
    and ${skillRunArtifacts.outcome} = 'failure'
    and ${failedCallPath}
    and not exists (
        select 1 from ${skillRunArtifacts} as ${laterStepAttempt}
        where ${laterStepAttempt.runId} = ${skillRunArtifacts.runId}
        and ${laterStepAttempt.outcome} = 'success'
        and ${laterStepAttempt.attempt} > ${skillRunArtifacts.attempt}
        and ${attemptsAt} > 0
        and ${laterStepAttempt.path} = substr(${skillRunArtifacts.path}, 1, ${attemptsAt} + 9)
            || ${laterStepAttempt.attempt} || '.json'
    )
)`;
}

/** Kept in the UPDATE predicate so a concurrent revision cannot reuse an older eval. */
export function skillEvalGateCondition(
	db: DbClient,
	layer: SkillPaceLayer,
	allowRecordedEval = true,
): SQL<boolean> {
	const skillEntries = coreTable(db, d1SkillEntries);
	const skillRuns = coreTable(db, d1SkillRuns);
	const skillRunArtifacts = coreTable(db, d1SkillRunArtifacts);
	return sql<boolean>`(
        coalesce(${skillPolicyKnob(db, layer, "evalRequired")}, ${DEFAULT_PACE_LAYER_POLICY[layer].evalRequired ? 1 : 0}) = 0
        or (${allowRecordedEval ? 1 : 0} = 1 and exists (
            select 1 from ${skillRuns}
            where ${skillRuns.skillId} = ${skillEntries.id}
            and ${skillRuns.organizationId} = ${skillEntries.organizationId}
            and ${skillRuns.skillRevision} = ${skillEntries.revision}
            and ${skillRuns.status} = 'completed'
            and ${certificationPassed(db)}
            and not exists (
                select 1 from ${skillRunArtifacts} where ${unrecoveredFailedCall(db)}
            )
        ))
    )`;
}

/** Why the eval gate refused, named so the caller can act on it. */
async function describeMissingSkillEval(
	db: DbClient,
	entry: Pick<SkillEntry, "id" | "organizationId">,
	allowRecordedEval: boolean,
): Promise<string> {
	if (!allowRecordedEval)
		return "This change also edits the skill, and a certification run only covers the revision it ran on. Save the edit first, run certification on the new revision, then promote.";
	const skillRuns = coreTable(db, d1SkillRuns);
	const skillEntries = coreTable(db, d1SkillEntries);
	const skillRunArtifacts = coreTable(db, d1SkillRunArtifacts);
	const runs = await db
		.select({
			runId: skillRuns.id,
			runStatus: skillRuns.status,
			entryRevision: skillEntries.revision,
			passed: sql<number>`case when ${certificationPassed(db)} then 1 else 0 end`,
			failedCall: sql<
				string | null
			>`(select min(${skillRunArtifacts.path}) from ${skillRunArtifacts} where ${unrecoveredFailedCall(db)})`,
		})
		.from(skillRuns)
		.innerJoin(
			skillEntries,
			and(
				eq(skillRuns.skillId, skillEntries.id),
				eq(skillRuns.organizationId, skillEntries.organizationId),
				eq(skillRuns.skillRevision, skillEntries.revision),
			),
		)
		.where(
			and(
				eq(skillEntries.id, entry.id),
				eq(skillEntries.organizationId, entry.organizationId),
			),
		)
		.limit(50);
	const completed = runs.filter((run) => run.runStatus === "completed");
	if (completed.length === 0)
		return "No completed run of the current revision was found; run it with certification=true.";
	const passing = completed.find((run) => run.passed === 1);
	if (!passing)
		return `Run ${completed[0]!.runId} completed, but its result does not report certification.passed=true.`;
	return `Run ${passing.runId} reported a pass, but its tool call ${passing.failedCall} failed and its step did not succeed on a later attempt; run certification again.`;
}

export async function assertSkillPaceLayerEval(
	db: DbClient,
	entry: Pick<SkillEntry, "id" | "organizationId" | "lifecycleState">,
	layer: SkillPaceLayer,
	allowRecordedEval = true,
	target?: SkillLifecycleState,
): Promise<void> {
	const skillEntries = coreTable(db, d1SkillEntries);
	const [allowed] = await db
		.select({ id: skillEntries.id })
		.from(skillEntries)
		.where(
			and(
				eq(skillEntries.id, entry.id),
				eq(skillEntries.organizationId, entry.organizationId),
				skillEvalGateCondition(db, layer, allowRecordedEval),
			),
		)
		.limit(1);
	if (!allowed)
		throw new SkillLifecycleTransitionError(
			`Promotion into ${layer} requires a recorded passing certification eval for this skill revision. ${await describeMissingSkillEval(db, entry, allowRecordedEval)}`,
			{
				skillId: entry.id,
				from: entry.lifecycleState ?? "draft",
				to: target ?? entry.lifecycleState ?? "draft",
				rule: "pace_layer_requires_eval",
			},
		);
}

/**
 * True when any failure in the window lacks ≥SKILL_FAILURE_RECOVERY_SUCCESSES
 * consecutive successes immediately after it. `outcomes` is newest-first
 * (index 0 = most recent event), so the events after a failure at index `i`
 * are indexes `i-1 … 0`.
 */
export function hasUnrecoveredFailure(outcomes: SkillUsageOutcome[]): boolean {
	return outcomes.some((outcome, index) => {
		if (outcome !== "failure") return false;
		if (index < SKILL_FAILURE_RECOVERY_SUCCESSES) return true;
		return !outcomes
			.slice(index - SKILL_FAILURE_RECOVERY_SUCCESSES, index)
			.every((later) => later === "success");
	});
}

/** Length of the newest-first failure streak (0 when the latest event succeeded). */
export function countConsecutiveRecentFailures(
	outcomes: SkillUsageOutcome[],
): number {
	let count = 0;
	for (const outcome of outcomes) {
		if (outcome !== "failure") break;
		count += 1;
	}
	return count;
}

export interface SkillLifecycleAdvanceInput {
	current?: SkillEntry["lifecycleState"];
	/** Outcome of the usage event that triggered this evaluation. */
	success: boolean;
	/** Whether the triggering event is canonical execution evidence. */
	promotionEligible: boolean;
	/** Total verified workflow successes in skill_usage_events (incl. this event). */
	verifiedSuccessCount: number;
	/**
	 * Most recent ledger outcomes, newest first, including this event —
	 * up to SKILL_PROVEN_RECENT_WINDOW entries.
	 */
	recentOutcomes: SkillUsageOutcome[];
}

export interface SkillLifecycleAdvance {
	state: SkillLifecycleState;
	/** Crystallized skill recorded a failure — flag for human review. */
	flagForReview: boolean;
}

/**
 * Lifecycle advancement/demotion on every recorded usage event
 * (called by `recordSkillUsageEvent()` after the ledger insert wins).
 */
export function nextSkillLifecycleState(
	input: SkillLifecycleAdvanceInput,
): SkillLifecycleAdvance {
	const current = input.current ?? "draft";
	if (current === "archived") return { state: current, flagForReview: false };
	if (current === "crystallized") {
		// Record layer: never auto-demote, flag failures for review instead.
		return { state: current, flagForReview: !input.success };
	}

	if (!input.success) {
		const streak = countConsecutiveRecentFailures(input.recentOutcomes);
		if (streak >= SKILL_DEMOTION_CONSECUTIVE_FAILURES) {
			if (current === "proven") return { state: "active", flagForReview: true };
			if (current === "active") return { state: "active", flagForReview: true };
		}
		return { state: current, flagForReview: false };
	}

	if (!input.promotionEligible) {
		return { state: current, flagForReview: false };
	}

	if (current === "draft") {
		return {
			state:
				input.verifiedSuccessCount >= SKILL_ACTIVE_MIN_SUCCESSES
					? "active"
					: current,
			flagForReview: false,
		};
	}
	if (
		current === "active" &&
		input.verifiedSuccessCount >= SKILL_PROVEN_MIN_SUCCESSES &&
		!hasUnrecoveredFailure(input.recentOutcomes)
	) {
		return { state: "proven", flagForReview: false };
	}
	return { state: current, flagForReview: false };
}

export interface SkillUsageSignals {
	/** Successful terminal workflow executions; direct reports are telemetry only. */
	verifiedSuccessCount: number;
	/** Newest first, capped at SKILL_PROVEN_RECENT_WINDOW. */
	recentOutcomes: SkillUsageOutcome[];
}

/**
 * A run that failed because the platform refused a tool the skill declared
 * (`WORKFLOW_TOOLS_REFUSED`, raised by the skill runtime's refusal check).
 * Between 22 and 25 Oct a gateway bug refused declared tools; every refusal
 * counted toward demotion, so 13 factories fell to draft and the scheduler
 * turned their schedules off. The failure stays in the ledger, the counters
 * and factory health; it only does not judge the skill's own reliability.
 */
const PLATFORM_REFUSAL_MARKER = "WORKFLOW_TOOLS_REFUSED";

/**
 * Platform failures that say nothing about the skill: the tool-refusal marker
 * above, and the platform database being overloaded or unavailable (on 7 Nov
 * a D1 overload after an account move failed a daily run and the
 * streak turned the skill off). They stay in the ledger and counters.
 */
const PLATFORM_FAILURE_MARKERS = [
	PLATFORM_REFUSAL_MARKER,
	"D1 DB is overloaded",
	"Database temporarily unavailable",
	"D1_ERROR: Network connection lost",
	// The gateway's manifest check could not read the database (11 Nov).
	"Skill manifest authorization is unavailable",
	// Cloudflare API error 10001 on a storage write.
	"We encountered an internal error. Please try again.",
] as const;

export function isPlatformSkillFailure(error: string | null | undefined) {
	return (
		!!error && PLATFORM_FAILURE_MARKERS.some((marker) => error.includes(marker))
	);
}

/** Read the promotion signals for a skill from the canonical usage ledger. */
export async function loadSkillUsageSignals(
	db: DbClient,
	organizationId: string,
	skillId: string,
): Promise<SkillUsageSignals> {
	const skillUsageEvents = coreTable(db, d1SkillUsageEvents);
	const scope = and(
		eq(skillUsageEvents.organizationId, organizationId),
		eq(skillUsageEvents.skillId, skillId),
	);
	const [successRows, recentRows] = await Promise.all([
		db
			.select({ count: sql<number>`count(*)` })
			.from(skillUsageEvents)
			.where(
				and(
					scope,
					eq(skillUsageEvents.outcome, "success"),
					eq(skillUsageEvents.source, "workflow_run"),
				),
			),
		db
			.select({
				outcome: skillUsageEvents.outcome,
				source: skillUsageEvents.source,
				error: skillUsageEvents.error,
			})
			.from(skillUsageEvents)
			.where(
				and(
					scope,
					or(
						eq(skillUsageEvents.outcome, "failure"),
						eq(skillUsageEvents.source, "workflow_run"),
					),
				),
			)
			// rowid tiebreak keeps same-millisecond events in insert order on D1;
			// Postgres has no insertion order for this table, so ties break by id.
			.orderBy(
				desc(skillUsageEvents.createdAt),
				coreStore(db) === "postgres"
					? desc(skillUsageEvents.id)
					: sql`rowid DESC`,
			)
			.limit(SKILL_PROVEN_RECENT_WINDOW),
	]);
	return {
		verifiedSuccessCount: Number(successRows[0]?.count ?? 0),
		// Unverified successes cannot recover a failure or reset a demotion
		// streak. Keep every failure except a platform failure, but only
		// canonical workflow successes.
		recentOutcomes: recentRows
			.filter((row) =>
				row.outcome === "failure"
					? !isPlatformSkillFailure(row.error)
					: row.source === "workflow_run",
			)
			.map((row) => row.outcome),
	};
}

export class SkillLifecycleTransitionError extends Error {
	readonly code = "SKILL_LIFECYCLE_TRANSITION_BLOCKED";
	constructor(
		message: string,
		readonly details: {
			skillId: string;
			from: SkillLifecycleState;
			to: SkillLifecycleState;
			rule: string;
		},
	) {
		super(message);
		this.name = "SkillLifecycleTransitionError";
	}
}

/** New rows have no execution evidence, so their only valid initial state is draft. */
export function assertInitialSkillLifecycleState(
	target: SkillLifecycleState | null | undefined,
): void {
	const resolved = target ?? "draft";
	if (resolved === "draft") return;
	throw new SkillLifecycleTransitionError(
		"new skills must start as draft; create the draft, execute it, then promote from verified workflow evidence or use the existing human/operator lifecycle override path",
		{
			skillId: "new",
			from: "draft",
			to: resolved,
			rule: "new_skills_start_draft",
		},
	);
}

export interface AssertSkillLifecycleTransitionOptions {
	/**
	 * Internal marker for the muscle-memory crystallization path
	 * (`crystallizeMuscleFromSkill()`), the one sanctioned writer of
	 * `crystallized`.
	 */
	via?: "crystallize";
}

/**
 * Who is exercising a `force` lifecycle promotion (disposer separation).
 *
 * - `operator`: the handler layer positively proved a signed-in human or an
 *   operator-issued API key (the capability-mutation-gate allowlist).
 * - `tedi`: an agent-authenticated caller with a resolved tedi identity. It
 *   may force-promote (apply) a proposal only when it is NOT the proposal's
 *   authoring identity — the proposer never approves its own evolution.
 */
export type ForcedSkillPromotionAuthority =
	| { kind: "operator" }
	| { kind: "tedi"; tediId: string };

/**
 * Force ceiling: a `tedi` authority may force-promote to at most this
 * state. `proven` and `crystallized` are systems-of-record states — they
 * require an operator, ledger-proven execution evidence, or the muscle
 * crystallization path (which verifies the proven muscle bar itself).
 */
export const TEDI_FORCE_PROMOTION_CEILING: SkillLifecycleState = "active";

/** True when `target` sits above the tedi force-promotion ceiling. */
export function exceedsTediForcePromotionCeiling(
	target: SkillLifecycleState,
): boolean {
	return LIFECYCLE_RANK[target] > LIFECYCLE_RANK[TEDI_FORCE_PROMOTION_CEILING];
}

/**
 * Clamp a requested force-promotion target to the tedi ceiling. Never demotes:
 * when the entry already sits above the ceiling, its current state is
 * preserved instead of being pulled down to `active`.
 */
export function clampLifecycleToTediForceCeiling(
	current: SkillEntry["lifecycleState"] | null | undefined,
	requested: SkillLifecycleState,
): SkillLifecycleState {
	if (!exceedsTediForcePromotionCeiling(requested)) return requested;
	const resolved = current ?? "draft";
	return LIFECYCLE_RANK[resolved] > LIFECYCLE_RANK[TEDI_FORCE_PROMOTION_CEILING]
		? resolved
		: TEDI_FORCE_PROMOTION_CEILING;
}

export interface AssertForcedSkillPromotionAuthorityOptions {
	/**
	 * Set ONLY by `crystallizeMuscleFromSkill()` after it has verified the
	 * proven muscle bar against the skill_usage_events ledger — the one path
	 * where a non-author tedi authority may reach `crystallized`.
	 */
	via?: "crystallize";
}

/**
 * DB-layer backstop for proposer≠approver: every `force` lifecycle
 * PROMOTION (upward transition) must name the authority exercising it, and a
 * tedi authority can never equal the entry's authoring identity
 * (`proposed_by_tedi_id`, falling back to the scoped `tedi_id` for pre-authorship-tracking
 * rows where authorship was not recorded). A tedi authority additionally:
 *
 * - fails closed when the entry has NO recorded authoring identity at all
 *   (both ids null) — an anonymous-authored entry cannot prove disposer
 *   separation, so only an operator may force it; and
 * - may force-promote to at most TEDI_FORCE_PROMOTION_CEILING (`active`);
 *   `proven`/`crystallized` targets require an operator or the evidence-
 *   verified muscle crystallization path (`options.via === "crystallize"`).
 *
 * Demotions/archival are untouched. Fails closed: force without a named
 * authority is rejected here even if a handler forgets its own check.
 */
export function assertForcedSkillPromotionAuthority(
	entry: Pick<
		SkillEntry,
		"id" | "lifecycleState" | "tediId" | "proposedByTediId"
	>,
	target: SkillLifecycleState,
	authority: ForcedSkillPromotionAuthority | undefined,
	options?: AssertForcedSkillPromotionAuthorityOptions,
): void {
	const current = entry.lifecycleState ?? "draft";
	if (LIFECYCLE_RANK[target] <= LIFECYCLE_RANK[current]) return;

	if (!authority) {
		throw new SkillLifecycleTransitionError(
			"force lifecycle promotion requires a named authority (operator, or a tedi distinct from the proposal author); handlers must resolve it via the capability-mutation-gate allowlist before setting force",
			{
				skillId: entry.id,
				from: current,
				to: target,
				rule: "force_requires_authority",
			},
		);
	}
	if (authority.kind === "operator") return;

	const authorIdentities = [entry.proposedByTediId, entry.tediId].filter(
		(id): id is string => Boolean(id),
	);
	if (authorIdentities.length === 0) {
		throw new SkillLifecycleTransitionError(
			"a tedi force authority cannot be verified against an authorless entry: this entry records no proposing or owning tedi identity, so proposer≠approver separation is unprovable — a signed-in human or operator API key must promote it (fails closed)",
			{
				skillId: entry.id,
				from: current,
				to: target,
				rule: "tedi_force_requires_recorded_author",
			},
		);
	}
	if (authorIdentities.includes(authority.tediId)) {
		throw new SkillLifecycleTransitionError(
			"the identity that proposed a skill evolution can never approve it: this entry was authored by (or scoped to) the acting tedi — a different tedi, a human, or an operator API key must apply it (disposer separation)",
			{
				skillId: entry.id,
				from: current,
				to: target,
				rule: "proposer_cannot_self_approve",
			},
		);
	}
	if (
		exceedsTediForcePromotionCeiling(target) &&
		options?.via !== "crystallize"
	) {
		throw new SkillLifecycleTransitionError(
			`a tedi force authority may promote to at most "${TEDI_FORCE_PROMOTION_CEILING}": "${target}" is a system-of-record state that requires an operator (signed-in human or API key), ledger-proven execution evidence, or the muscle crystallization path (force ceiling)`,
			{
				skillId: entry.id,
				from: current,
				to: target,
				rule: "tedi_force_ceiling",
			},
		);
	}
}

/**
 * Hard write-path gate for lifecycle transitions, verified against the
 * skill_usage_events ledger (not the rollup counters). Demotions and archival
 * are always allowed; instruction-only activation needs no workflow evidence.
 * Throws SkillLifecycleTransitionError when blocked.
 */
export async function assertSkillLifecycleTransition(
	db: DbClient,
	entry: Pick<SkillEntry, "id" | "organizationId" | "lifecycleState" | "files">,
	target: SkillLifecycleState,
	options?: AssertSkillLifecycleTransitionOptions,
): Promise<void> {
	const current = entry.lifecycleState ?? "draft";
	if (target === current) return;
	if (LIFECYCLE_RANK[target] <= LIFECYCLE_RANK[current]) return;
	if (target === "active" && entry.files?.["scripts/workflow.ts"] === undefined)
		return;

	if (target === "crystallized") {
		if (options?.via === "crystallize") return;
		throw new SkillLifecycleTransitionError(
			"crystallized is set only by muscle-memory crystallization (muscle.crystallize / register_muscle_memory) or a human/API-key force override",
			{
				skillId: entry.id,
				from: current,
				to: target,
				rule: "crystallize_via_muscle",
			},
		);
	}

	const signals = await loadSkillUsageSignals(
		db,
		entry.organizationId,
		entry.id,
	);
	if (target === "active") {
		if (signals.verifiedSuccessCount >= SKILL_ACTIVE_MIN_SUCCESSES) return;
		throw new SkillLifecycleTransitionError(
			`${current} → active requires at least ${SKILL_ACTIVE_MIN_SUCCESSES} verified terminal workflow success in skill_usage_events; direct skills.usage reports are telemetry only`,
			{
				skillId: entry.id,
				from: current,
				to: target,
				rule: "active_requires_success",
			},
		);
	}
	if (target === "proven") {
		if (signals.verifiedSuccessCount < SKILL_PROVEN_MIN_SUCCESSES) {
			throw new SkillLifecycleTransitionError(
				`${current} → proven requires ≥${SKILL_PROVEN_MIN_SUCCESSES} verified terminal workflow successes in skill_usage_events (found ${signals.verifiedSuccessCount})`,
				{
					skillId: entry.id,
					from: current,
					to: target,
					rule: "proven_requires_successes",
				},
			);
		}
		if (hasUnrecoveredFailure(signals.recentOutcomes)) {
			throw new SkillLifecycleTransitionError(
				`${current} → proven blocked: an unrecovered failure exists in the last ${SKILL_PROVEN_RECENT_WINDOW} usage events (a failure needs ≥${SKILL_FAILURE_RECOVERY_SUCCESSES} consecutive successes after it to count as recovered)`,
				{
					skillId: entry.id,
					from: current,
					to: target,
					rule: "proven_requires_recovery",
				},
			);
		}
		return;
	}
}

export interface SweepExpiredDraftSkillsOptions {
	/** Restrict to one org; omit for a fleet-wide sweep. */
	organizationId?: string;
	/** Fallback age threshold for layers without draftTtlDays; 0 expires all eligible drafts in those layers. */
	olderThanDays?: number;
	limit?: number;
	dryRun?: boolean;
	now?: Date;
}

export interface SweptDraftSkill {
	id: string;
	organizationId: string;
	tediId: string | null;
	slug: string | null;
	title: string;
	updatedAt: string | null;
}

export interface SweepExpiredDraftSkillsResult {
	archived: number;
	cutoff: string;
	dryRun: boolean;
	entries: SweptDraftSkill[];
	/** What "unused" meant for this sweep, including the read-tracking caveat. */
	note: string;
}

/**
 * Draft TTL: archive either (a) ordinary drafts with zero recorded usage or
 * (b) flow-authored ephemeral drafts whose last use is older than the TTL.
 * A flow run is usage by definition, so applying the ordinary zero-use rule to
 * `flow-ephemeral` skills would retain every successful one forever. Promotion
 * removes a skill from `draft`, which is the explicit keep path. Archived, not
 * deleted — D1 history is the archive.
 */
export async function sweepExpiredDraftSkills(
	db: DbClient,
	options: SweepExpiredDraftSkillsOptions = {},
): Promise<SweepExpiredDraftSkillsResult> {
	const olderThanDays = Math.max(
		options.olderThanDays ?? SKILL_DRAFT_TTL_DAYS,
		0,
	);
	const limit = Math.min(Math.max(options.limit ?? 500, 1), 1000);
	const now = options.now ?? new Date();
	const cutoff = new Date(
		now.getTime() - olderThanDays * 24 * 60 * 60 * 1000,
	).toISOString();

	const skillEntries = coreTable(db, d1SkillEntries);
	const skillUsageEvents = coreTable(db, d1SkillUsageEvents);
	const postgres = coreStore(db) === "postgres";
	// A CASE of bound values alone resolves to text on Postgres.
	const days = (value: number) =>
		postgres ? sql`${value}::numeric` : sql`${value}`;
	const layerTtl = sql`${postgres ? sql`greatest` : sql`max`}(0, coalesce(${skillPolicyKnob(db, sql`${skillEntries.paceLayer}`, "draftTtlDays")},
        case ${skillEntries.paceLayer} when 'innovation' then ${days(DEFAULT_PACE_LAYER_POLICY.innovation.draftTtlDays ?? olderThanDays)}
        when 'differentiation' then ${days(DEFAULT_PACE_LAYER_POLICY.differentiation.draftTtlDays ?? olderThanDays)}
        when 'record' then ${days(DEFAULT_PACE_LAYER_POLICY.record.draftTtlDays ?? olderThanDays)}
        else ${days(olderThanDays)} end))`;
	const layerCutoff = postgres
		? sql`(${now.toISOString()}::timestamptz - (${layerTtl})::float8 * interval '1 day')`
		: sql`datetime(${now.toISOString()}, '-' || ${layerTtl} || ' days')`;
	// Stored times are ISO text or `YYYY-MM-DD HH:MM:SS`; both read as UTC.
	const storedTime = (value: SQL) =>
		postgres
			? sql`CASE WHEN ${value} ~ '(Z|z|[+-][0-9]{2}:?[0-9]{2})$' THEN ${value}::timestamptz ELSE ${value}::timestamp AT TIME ZONE 'UTC' END`
			: sql`datetime(${value})`;
	const tags = postgres
		? sql`jsonb_array_elements_text(coalesce(${skillEntries.tags}, '[]'::jsonb))`
		: sql`json_each(coalesce(${skillEntries.tags}, '[]'))`;
	const isEphemeralFlow = sql<boolean>`exists (
		select 1
		from ${tags}
		where value = ${FLOW_EPHEMERAL_SKILL_TAG}
	)`;
	const hasNoUsage = and(
		eq(skillEntries.successCount, 0),
		eq(skillEntries.failureCount, 0),
		sql`NOT EXISTS (SELECT 1 FROM ${skillUsageEvents} WHERE ${skillUsageEvents.skillId} = ${skillEntries.id})`,
	);
	const ordinaryDraftIsExpired = and(
		hasNoUsage,
		sql`${storedTime(sql`coalesce(${skillEntries.updatedAt}, ${skillEntries.createdAt})`)} < ${layerCutoff}`,
	);
	const ephemeralFlowIsExpired = and(
		isEphemeralFlow,
		sql`${storedTime(sql`coalesce(${skillEntries.lastUsedAt}, ${skillEntries.updatedAt}, ${skillEntries.createdAt})`)} < ${layerCutoff}`,
	);
	// A draft read within its TTL window is not unused even with zero recorded
	// runs: reads leave a daily date in read_marks (kind 'skill'). The mark is
	// compared against the same per-layer cutoff as the usage predicates.
	const notReadWithinTtl = sql`NOT ${freshReadMarkExists({
		organizationId: skillEntries.organizationId,
		kind: "skill",
		rowId: skillEntries.id,
		sinceDate: postgres
			? sql`to_char(${layerCutoff} AT TIME ZONE 'UTC', 'YYYY-MM-DD')`
			: sql`date(${layerCutoff})`,
	})}`;
	const conditions = [
		eq(skillEntries.lifecycleState, "draft"),
		// Improvement copies have their own deletion sweep and evidence guards.
		sql`NOT EXISTS (SELECT 1 FROM ${tags} WHERE value = 'workflow-improvement')`,
		notReadWithinTtl,
		or(ordinaryDraftIsExpired, ephemeralFlowIsExpired),
	];
	if (options.organizationId) {
		conditions.push(eq(skillEntries.organizationId, options.organizationId));
	}

	const rows = await db
		.select({
			id: skillEntries.id,
			organizationId: skillEntries.organizationId,
			tediId: skillEntries.tediId,
			slug: skillEntries.slug,
			title: skillEntries.title,
			updatedAt: skillEntries.updatedAt,
		})
		.from(skillEntries)
		.where(and(...conditions))
		.limit(limit);

	const reportNote = unusedReportNote(
		`draft TTL per pace layer (global fallback ${olderThanDays} day(s)); skill_usage_events kept 90 day(s)`,
	);
	if (options.dryRun || rows.length === 0) {
		return {
			archived: rows.length,
			cutoff,
			dryRun: options.dryRun ?? false,
			entries: rows,
			note: reportNote,
		};
	}

	const note = `Archived by draft-TTL sweep: unused ordinary draft or unpromoted ephemeral flow beyond its resolved pace-layer TTL (global fallback ${olderThanDays} day(s)).`;
	// Leave room under D1's 100-parameter cap for the repeated TTL predicates.
	const archivedIds = new Set<string>();
	for (const ids of chunkForBoundParams(
		rows.map((row) => row.id),
		50,
	)) {
		const applied = await db
			.update(skillEntries)
			.set({
				lifecycleState: "archived",
				paceLayer: paceLayerForLifecycle("archived"),
				archivedFrom: postgres
					? sql`jsonb_build_object('lifecycleState', 'draft', 'revision', ${skillEntries.revision} + 1)`
					: sql`json_object('lifecycleState', 'draft', 'revision', ${skillEntries.revision} + 1)`,
				revision: sql`${skillEntries.revision} + 1`,
				revisionReasoning: sql`CASE WHEN ${skillEntries.revisionReasoning} IS NULL OR ${skillEntries.revisionReasoning} = '' THEN ${note} ELSE ${skillEntries.revisionReasoning} || ${postgres ? sql`chr(10)` : sql`char(10)`} || ${note} END`,
				updatedAt: now.toISOString(),
			})
			.where(and(inArray(skillEntries.id, ids), ...conditions))
			.returning({ id: skillEntries.id });
		for (const row of applied) archivedIds.add(row.id);
	}

	const entries = rows.filter((row) => archivedIds.has(row.id));
	return {
		archived: entries.length,
		cutoff,
		dryRun: false,
		entries,
		note: reportNote,
	};
}
