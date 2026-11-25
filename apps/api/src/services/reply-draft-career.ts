/**
 * Stored reply-drafting stages and progress for the Office leaderboard.
 * A stage is a title only; it never grants authority.
 */

import {
	TEDI_CAREER_STAGES,
	type TediCareerStage,
} from "@tedix/api-contract/schemas/earned-delegation";
import type { DbClient } from "@tedix/db/client";
import {
	evaluateCareerLadder,
	getReplyDraftingActivity,
	loadReplyDraftCareers,
	type ReplyDraftCareerState,
	readReplyDraftingConfig,
	stoodStreakDays,
} from "@tedix/db/queries/earned-delegation/reply-draft-career";

function counts(state: ReplyDraftCareerState) {
	return {
		stood: state.stoodIds.length,
		corrected: state.correctedIds.length,
		windowStood: state.windowStoodIds.length,
		windowCorrected: state.windowCorrectedIds.length,
	};
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
