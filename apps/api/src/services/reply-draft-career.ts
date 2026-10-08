/**
 * Career stages earned from reply drafts: the settle tick records each settled
 * draft as a competency observation and moves stages by the `reply_drafting`
 * activity's ladder; the level read feeds the Office leaderboard. A stage is
 * a title only; it never grants authority.
 */

import {
	CompetencyCareerLadderSchema,
	TEDI_CAREER_STAGES,
	type TediCareerStage,
} from "@tedix/api-contract/schemas/earned-delegation";
import type { DbClient } from "@tedix/db/client";
import {
	applyReplyDraftCareerChange,
	ensureReplyDraftingActivity,
	ensureReplyDraftRole,
	evaluateCareerLadder,
	getReplyDraftingActivity,
	loadReplyDraftCareers,
	type ReplyDraftCareerState,
	type ReplyDraftingSeed,
	readReplyDraftingConfig,
	recordReplyDraftObservations,
	stoodStreakDays,
} from "@tedix/db/queries/earned-delegation/reply-draft-career";
import {
	listUnrecordedReplyDraftOutcomes,
	type SettledReplyDraftOutcome,
} from "@tedix/db/queries/work-items/reply-drafts";
import seedAsset from "./reply-draft-career-ladder.json";

const SEED: ReplyDraftingSeed = {
	ladder: CompetencyCareerLadderSchema.parse(seedAsset.ladder),
	initialRole: seedAsset.initialRole,
};
/** Drafts older than this are never backfilled. */
const BACKFILL_DAYS = 30;
const MAX_OUTCOMES_PER_TICK = 500;

function minutesAgo(now: Date, minutes: number): string {
	return new Date(now.getTime() - minutes * 60_000).toISOString();
}

function counts(state: ReplyDraftCareerState) {
	return {
		stood: state.stoodIds.length,
		corrected: state.correctedIds.length,
		windowStood: state.windowStoodIds.length,
		windowCorrected: state.windowCorrectedIds.length,
	};
}

/** Records settled drafts and applies ladder changes for their tedis. */
export async function settleReplyDraftCareers(
	db: DbClient,
	now = new Date(),
): Promise<Record<string, number>> {
	const nowIso = now.toISOString();
	const outcomes = await listUnrecordedReplyDraftOutcomes(db, {
		since: minutesAgo(now, BACKFILL_DAYS * 1_440),
		settledBefore: minutesAgo(now, SEED.ladder.autoSettleMinutes),
		limit: MAX_OUTCOMES_PER_TICK,
	});
	const byOrg = new Map<string, SettledReplyDraftOutcome[]>();
	for (const outcome of outcomes) {
		const list = byOrg.get(outcome.orgId) ?? [];
		list.push(outcome);
		byOrg.set(outcome.orgId, list);
	}
	let recorded = 0;
	let promoted = 0;
	let demoted = 0;
	for (const [organizationId, orgOutcomes] of byOrg) {
		const activity = await ensureReplyDraftingActivity(
			db,
			organizationId,
			SEED,
			nowIso,
		);
		const config = readReplyDraftingConfig(activity);
		if (!config) continue;
		recorded += await recordReplyDraftObservations(db, {
			activity,
			outcomes: orgOutcomes,
			now: nowIso,
		});
		const tediIds = [...new Set(orgOutcomes.map((o) => o.drafterId))];
		for (const tediId of tediIds) {
			// A tedi already on another role track keeps it; the ladder moves
			// whichever role is active.
			await ensureReplyDraftRole(db, {
				organizationId,
				tediId,
				role: config.initialRole,
				now: nowIso,
			}).catch(() => null);
		}
		const careers = await loadReplyDraftCareers(db, {
			organizationId,
			activityId: activity.id,
			tediIds,
			windowDays: config.ladder.demotion.windowDays,
			now: nowIso,
		});
		for (const state of careers.values()) {
			if (!state.assignment) continue;
			const evaluation = evaluateCareerLadder(
				config.ladder,
				state.assignment.careerStage,
				counts(state),
			);
			if (!evaluation.change) continue;
			const applied = await applyReplyDraftCareerChange(db, {
				assignment: state.assignment,
				kind: evaluation.change.kind,
				to: evaluation.change.to,
				evidenceObservationIds:
					evaluation.change.kind === "promote"
						? state.stoodIds
						: state.windowCorrectedIds,
				snapshot: {
					ladder: config.ladder,
					activityId: activity.id,
					activityVersion: activity.version,
					...counts(state),
				},
				now: nowIso,
			});
			if (applied && evaluation.change.kind === "promote") promoted++;
			if (applied && evaluation.change.kind === "demote") demoted++;
		}
	}
	return { recorded, promoted, demoted, organizations: byOrg.size };
}

export interface ReplyDraftLevel {
	stage: TediCareerStage;
	nextStage: TediCareerStage | null;
	stood: number;
	corrected: number;
	target: number | null;
	minStandingRate: number;
	streakDays: number;
}

/** Each tedi's stage and progress on the ladder; absent before it has a role. */
export async function readReplyDraftLevels(
	db: DbClient,
	organizationId: string,
	tediIds: string[],
	now = new Date(),
): Promise<Map<string, ReplyDraftLevel>> {
	const levels = new Map<string, ReplyDraftLevel>();
	if (tediIds.length === 0) return levels;
	const activity = await getReplyDraftingActivity(db, organizationId);
	const config = activity ? readReplyDraftingConfig(activity) : null;
	if (!activity || !config) return levels;
	const nowIso = now.toISOString();
	const careers = await loadReplyDraftCareers(db, {
		organizationId,
		activityId: activity.id,
		tediIds,
		windowDays: config.ladder.demotion.windowDays,
		now: nowIso,
	});
	for (const state of careers.values()) {
		const stage = state.assignment?.careerStage;
		if (!stage || !TEDI_CAREER_STAGES.includes(stage)) continue;
		const evaluation = evaluateCareerLadder(
			config.ladder,
			stage,
			counts(state),
		);
		levels.set(state.tediId, {
			stage,
			nextStage: evaluation.nextStage,
			stood: state.stoodIds.length,
			corrected: state.correctedIds.length,
			target: evaluation.target,
			minStandingRate: config.ladder.promotion.minStandingRate,
			streakDays: stoodStreakDays(state.stoodDays, nowIso),
		});
	}
	return levels;
}
