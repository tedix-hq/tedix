/**
 * Read stored reply-drafting stages and progress for the leaderboard.
 */

import {
	type CompetencyCareerLadder,
	CompetencyCareerLadderSchema,
	TEDI_CAREER_STAGES,
	type TediCareerStage,
} from "@tedix/api-contract/schemas/earned-delegation";
import { and, desc, eq, gte, inArray, isNull, or, sql } from "drizzle-orm";
import type { DbClient } from "../../client";
import {
	competencyObservations,
	type EntrustableActivityRow,
	entrustableActivities,
	type TediRoleAssignmentRow,
	tediRoleAssignments,
} from "../../schema/earned-delegation";
import { chunkForBoundParams } from "../../utils/batch";

export const REPLY_DRAFTING_ACTIVITY_KEY = "reply_drafting";
/** How far back progress and streaks are read. */
const HISTORY_DAYS = 180;

export interface ReplyDraftingSeed {
	ladder: CompetencyCareerLadder;
	/** Role track a tedi with no active role starts on. */
	initialRole: { key: string; name: string };
}

/** The newest org revision wins; a retired head never falls back to platform defaults. */
export async function getReplyDraftingActivity(
	db: DbClient,
	organizationId: string,
): Promise<EntrustableActivityRow | null> {
	const rows = await db
		.select()
		.from(entrustableActivities)
		.where(
			and(
				eq(entrustableActivities.key, REPLY_DRAFTING_ACTIVITY_KEY),
				or(
					eq(entrustableActivities.organizationId, organizationId),
					isNull(entrustableActivities.organizationId),
				),
			),
		)
		.orderBy(
			sql`CASE WHEN ${entrustableActivities.organizationId} = ${organizationId} THEN 0 ELSE 1 END`,
			desc(entrustableActivities.version),
		)
		.limit(1);
	return rows[0]?.status === "active" ? rows[0] : null;
}

export function readReplyDraftingConfig(
	activity: EntrustableActivityRow,
): ReplyDraftingSeed | null {
	const ladder = CompetencyCareerLadderSchema.safeParse(
		activity.rubric.careerLadder,
	);
	const role = activity.rubric.initialRole as
		| { key?: unknown; name?: unknown }
		| undefined;
	if (
		!ladder.success ||
		typeof role?.key !== "string" ||
		typeof role.name !== "string"
	)
		return null;
	return {
		ladder: ladder.data,
		initialRole: { key: role.key, name: role.name },
	};
}

export interface ReplyDraftCareerState {
	tediId: string;
	assignment: TediRoleAssignmentRow | null;
	/** Observations since the current stage began. */
	stoodIds: string[];
	correctedIds: string[];
	/** Since the later of the stage start and the demotion window start. */
	windowStoodIds: string[];
	windowCorrectedIds: string[];
	/** UTC days (YYYY-MM-DD) with a reply that stood. */
	stoodDays: Set<string>;
}

/** Current stage and reply-drafting progress for each tedi. */
export async function loadReplyDraftCareers(
	db: DbClient,
	input: {
		organizationId: string;
		activityId: string;
		tediIds: string[];
		windowDays: number;
		now: string;
	},
): Promise<Map<string, ReplyDraftCareerState>> {
	const result = new Map<string, ReplyDraftCareerState>();
	const tediIds = [...new Set(input.tediIds)];
	const historyStart = shiftDays(input.now, -HISTORY_DAYS);
	const windowStart = shiftDays(input.now, -input.windowDays);
	for (const chunk of chunkForBoundParams(tediIds, 50)) {
		const [assignments, observations] = await Promise.all([
			db
				.select()
				.from(tediRoleAssignments)
				.where(
					and(
						eq(tediRoleAssignments.organizationId, input.organizationId),
						inArray(tediRoleAssignments.tediId, chunk),
						eq(tediRoleAssignments.status, "active"),
					),
				),
			db
				.select({
					id: competencyObservations.id,
					tediId: competencyObservations.tediId,
					outcome: competencyObservations.outcome,
					occurredAt: competencyObservations.occurredAt,
				})
				.from(competencyObservations)
				.where(
					and(
						eq(competencyObservations.organizationId, input.organizationId),
						eq(competencyObservations.activityId, input.activityId),
						inArray(competencyObservations.tediId, chunk),
						gte(competencyObservations.occurredAt, historyStart),
					),
				)
				.orderBy(desc(competencyObservations.occurredAt)),
		]);
		for (const tediId of chunk) {
			const assignment =
				assignments.find((row) => row.tediId === tediId) ?? null;
			// The first stage needs no decision, so all of its history counts.
			const stageStart = assignment?.lastDecisionId
				? assignment.stageChangedAt
				: "";
			const windowFrom = stageStart > windowStart ? stageStart : windowStart;
			const state: ReplyDraftCareerState = {
				tediId,
				assignment,
				stoodIds: [],
				correctedIds: [],
				windowStoodIds: [],
				windowCorrectedIds: [],
				stoodDays: new Set(),
			};
			for (const row of observations) {
				if (row.tediId !== tediId) continue;
				const stood = row.outcome === "success";
				if (stood) state.stoodDays.add(row.occurredAt.slice(0, 10));
				if (row.occurredAt <= stageStart) continue;
				(stood ? state.stoodIds : state.correctedIds).push(row.id);
				if (row.occurredAt >= windowFrom)
					(stood ? state.windowStoodIds : state.windowCorrectedIds).push(
						row.id,
					);
			}
			result.set(tediId, state);
		}
	}
	return result;
}

export interface CareerLadderEvaluation {
	stage: TediCareerStage;
	nextStage: TediCareerStage | null;
	/** Replies that must stand to reach `nextStage`; null at the top. */
	target: number | null;
	change: { kind: "promote" | "demote"; to: TediCareerStage } | null;
}

export function evaluateCareerLadder(
	ladder: CompetencyCareerLadder,
	stage: TediCareerStage,
	counts: {
		stood: number;
		corrected: number;
		windowStood: number;
		windowCorrected: number;
	},
): CareerLadderEvaluation {
	const rank = TEDI_CAREER_STAGES.indexOf(stage);
	const top = TEDI_CAREER_STAGES.indexOf(ladder.maximumStage);
	const nextStage = rank < top ? TEDI_CAREER_STAGES[rank + 1]! : null;
	const target = nextStage ? ladder.promotion.stood : null;
	const windowDecided = counts.windowStood + counts.windowCorrected;
	if (
		rank > 0 &&
		windowDecided >= ladder.demotion.minDecided &&
		counts.windowStood / windowDecided < ladder.demotion.belowStandingRate
	)
		return {
			stage,
			nextStage,
			target,
			change: { kind: "demote", to: TEDI_CAREER_STAGES[rank - 1]! },
		};
	const decided = counts.stood + counts.corrected;
	if (
		nextStage &&
		counts.stood >= ladder.promotion.stood &&
		counts.stood / decided >= ladder.promotion.minStandingRate
	)
		return {
			stage,
			nextStage,
			target,
			change: { kind: "promote", to: nextStage },
		};
	return { stage, nextStage, target, change: null };
}

/** Consecutive UTC days ending today, or yesterday, with a reply that stood. */
export function stoodStreakDays(stoodDays: Set<string>, now: string): number {
	let day = now.slice(0, 10);
	if (!stoodDays.has(day)) day = shiftDays(now, -1).slice(0, 10);
	let streak = 0;
	while (stoodDays.has(day)) {
		streak++;
		day = shiftDays(`${day}T00:00:00.000Z`, -1).slice(0, 10);
	}
	return streak;
}

function shiftDays(iso: string, days: number): string {
	const date = new Date(iso);
	date.setUTCDate(date.getUTCDate() + days);
	return date.toISOString();
}
