/**
 * Execute-to-promote skill lifecycle engine (flywheel remodel WS2).
 *
 * Skills promote by verified workflow execution recorded in the
 * `skill_usage_events` ledger — never by authorship, rollup counters, or
 * direct self-reports:
 *
 * - `draft → active` requires ≥1 recorded success event.
 * - `active → proven` requires ≥SKILL_PROVEN_MIN_SUCCESSES ledger successes
 *   AND zero unrecovered failures in the last SKILL_PROVEN_RECENT_WINDOW
 *   events (a failure followed by ≥SKILL_FAILURE_RECOVERY_SUCCESSES
 *   consecutive successes counts as recovered).
 * - `proven → crystallized` keeps the muscle-memory bar: only
 *   `crystallizeMuscleFromSkill()` sets it (options.via === "crystallize"),
 *   and that path itself verifies the proven ledger bar, org scope, and a
 *   disposer authority before writing.
 * - Failures gate advancement and demote: SKILL_DEMOTION_CONSECUTIVE_FAILURES
 *   consecutive failures drop `proven → active` and `active → draft`.
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

import { and, desc, eq, inArray, or, sql } from "drizzle-orm";
import type { DbClient } from "../client";
import {
	type SkillEntry,
	type SkillPaceLayer,
	type SkillUsageOutcome,
	skillEntries,
	skillUsageEvents,
} from "../schema/cognitive";
import { chunkForBoundParams } from "../utils/batch";

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
			if (current === "proven")
				return { state: "active", flagForReview: false };
			if (current === "active") return { state: "draft", flagForReview: false };
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

/** Read the promotion signals for a skill from the canonical usage ledger. */
export async function loadSkillUsageSignals(
	db: DbClient,
	organizationId: string,
	skillId: string,
): Promise<SkillUsageSignals> {
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
			// rowid tiebreak keeps same-millisecond events in insert order.
			.orderBy(desc(skillUsageEvents.createdAt), sql`rowid DESC`)
			.limit(SKILL_PROVEN_RECENT_WINDOW),
	]);
	return {
		verifiedSuccessCount: Number(successRows[0]?.count ?? 0),
		// Unverified successes cannot recover a failure or reset a demotion
		// streak. Keep every failure, but only canonical workflow successes.
		recentOutcomes: recentRows
			.filter(
				(row) => row.outcome === "failure" || row.source === "workflow_run",
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
 * are always allowed; upward transitions require recorded execution evidence.
 * Throws SkillLifecycleTransitionError when blocked.
 */
export async function assertSkillLifecycleTransition(
	db: DbClient,
	entry: Pick<SkillEntry, "id" | "organizationId" | "lifecycleState">,
	target: SkillLifecycleState,
	options?: AssertSkillLifecycleTransitionOptions,
): Promise<void> {
	const current = entry.lifecycleState ?? "draft";
	if (target === current) return;
	if (LIFECYCLE_RANK[target] <= LIFECYCLE_RANK[current]) return;

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
	/** Age threshold in days; 0 sweeps every currently eligible draft. */
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

	const isEphemeralFlow = sql<boolean>`exists (
		select 1
		from json_each(coalesce(${skillEntries.tags}, '[]'))
		where value = ${FLOW_EPHEMERAL_SKILL_TAG}
	)`;
	const hasNoUsage = and(
		eq(skillEntries.successCount, 0),
		eq(skillEntries.failureCount, 0),
		sql`NOT EXISTS (SELECT 1 FROM ${skillUsageEvents} WHERE ${skillUsageEvents.skillId} = ${skillEntries.id})`,
	);
	const ordinaryDraftIsExpired = and(
		hasNoUsage,
		sql`datetime(coalesce(${skillEntries.updatedAt}, ${skillEntries.createdAt})) < datetime(${cutoff})`,
	);
	const ephemeralFlowIsExpired = and(
		isEphemeralFlow,
		sql`datetime(coalesce(${skillEntries.lastUsedAt}, ${skillEntries.updatedAt}, ${skillEntries.createdAt})) < datetime(${cutoff})`,
	);
	const conditions = [
		eq(skillEntries.lifecycleState, "draft"),
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

	if (options.dryRun || rows.length === 0) {
		return {
			archived: rows.length,
			cutoff,
			dryRun: options.dryRun ?? false,
			entries: rows,
		};
	}

	const note = `Archived by draft-TTL sweep: unused ordinary draft or unpromoted ephemeral flow inactive for ${olderThanDays} day(s).`;
	// D1 caps bound parameters at 100 per statement; this UPDATE binds ~5
	// besides the id list, so archive in chunks of 50 (same budget as
	// fact-lifecycle's SWEEP_UPDATE_CHUNK).
	for (const ids of chunkForBoundParams(
		rows.map((row) => row.id),
		50,
	)) {
		await db
			.update(skillEntries)
			.set({
				lifecycleState: "archived",
				paceLayer: paceLayerForLifecycle("archived"),
				revision: sql`${skillEntries.revision} + 1`,
				revisionReasoning: sql`CASE WHEN ${skillEntries.revisionReasoning} IS NULL OR ${skillEntries.revisionReasoning} = '' THEN ${note} ELSE ${skillEntries.revisionReasoning} || char(10) || ${note} END`,
				updatedAt: now.toISOString(),
			})
			.where(inArray(skillEntries.id, ids));
	}

	return { archived: rows.length, cutoff, dryRun: false, entries: rows };
}
