/**
 * Career stages earned from reply drafts.
 *
 * Every settled reply draft becomes one competency observation of the
 * `reply_drafting` activity: `success` when it stood, `failure` when the human
 * corrected it. These observations are `ineligible` by construction, so they
 * never count toward entrustment readiness or authority. The activity's rubric
 * carries the career ladder (config, not code); the ladder moves the tedi's
 * active role-assignment stage, which is a title only, through an applied
 * promotion decision so every stage still points at its evidence.
 */

import {
	type CompetencyCareerLadder,
	CompetencyCareerLadderSchema,
	EvidencePolicySchema,
	TEDI_CAREER_STAGES,
	type TediCareerStage,
} from "@tedix/api-contract/schemas/earned-delegation";
import type { JsonValue } from "@tedix/api-contract/schemas/common";
import { and, desc, eq, gte, inArray, isNull, or } from "drizzle-orm";
import type { DbClient } from "../../client";
import {
	competencyObservations,
	type EntrustableActivityRow,
	entrustableActivities,
	promotionDecisions,
	type TediRoleAssignmentRow,
	tediRoleAssignments,
} from "../../schema/earned-delegation";
import { chunkForBoundParams } from "../../utils/batch";
import type { SettledReplyDraftOutcome } from "../work-items/reply-drafts";
import { replyDraftObservationKey } from "../work-items/reply-drafts";
import { createEntrustableActivity } from "./activities";
import { hashSnapshot } from "./authority-policy";
import { assignInitialRoleTrack } from "./role-assignments";

export const REPLY_DRAFTING_ACTIVITY_KEY = "reply_drafting";
/** The trusted service that records outcomes and applies ladder changes. */
export const REPLY_DRAFT_LADDER_PRINCIPAL = "reply-draft-ladder";
const CLASSIFICATION_METHOD = "reply_draft_outcome:v1";
/** How far back progress and streaks are read. */
const HISTORY_DAYS = 180;
/** Evidence ids cited by one ladder decision. */
const MAX_DECISION_EVIDENCE = 50;

export interface ReplyDraftingSeed {
	ladder: CompetencyCareerLadder;
	/** Role track a tedi with no active role starts on. */
	initialRole: { key: string; name: string };
}

/** The org's `reply_drafting` activity, else the platform one. */
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
				eq(entrustableActivities.status, "active"),
				or(
					eq(entrustableActivities.organizationId, organizationId),
					isNull(entrustableActivities.organizationId),
				),
			),
		)
		.limit(2);
	return (
		rows.find((row) => row.organizationId === organizationId) ?? rows[0] ?? null
	);
}

/** Creates the platform activity from `seed` when no head exists. */
export async function ensureReplyDraftingActivity(
	db: DbClient,
	organizationId: string,
	seed: ReplyDraftingSeed,
	now: string,
): Promise<EntrustableActivityRow> {
	const existing = await getReplyDraftingActivity(db, organizationId);
	if (existing) return existing;
	try {
		return await createEntrustableActivity(db, {
			organizationId: null,
			key: REPLY_DRAFTING_ACTIVITY_KEY,
			version: 1,
			name: "Reply drafting",
			description:
				"Drafting a person's reply to their coding agent. Outcomes earn a career stage only, never authority.",
			taskFamily: REPLY_DRAFTING_ACTIVITY_KEY,
			riskLevel: "low",
			maximumLevel: "recommend",
			actionPatterns: ["agentTurnTriage.proposeReplyDraft"],
			toolIds: [],
			rubric: {
				careerLadder: seed.ladder,
				initialRole: seed.initialRole,
			} as unknown as Record<string, JsonValue>,
			evidencePolicy: EvidencePolicySchema.parse({}),
			now,
		});
	} catch (error) {
		const raced = await getReplyDraftingActivity(db, organizationId);
		if (raced) return raced;
		throw error;
	}
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

/**
 * One observation per settled draft; a draft already observed is skipped.
 * Returns how many rows were offered.
 */
export async function recordReplyDraftObservations(
	db: DbClient,
	input: {
		activity: EntrustableActivityRow;
		outcomes: SettledReplyDraftOutcome[];
		now: string;
	},
): Promise<number> {
	const statements = [];
	for (const outcome of input.outcomes) {
		const clientObservationId = replyDraftObservationKey(outcome.draftId);
		statements.push(
			db
				.insert(competencyObservations)
				.values({
					id: crypto.randomUUID(),
					organizationId: outcome.orgId,
					tediId: outcome.drafterId,
					executorType: "tedi",
					executorId: outcome.drafterId,
					activityId: input.activity.id,
					clientObservationId,
					inputHash: await hashSnapshot({
						clientObservationId,
						verdict: outcome.verdict,
					}),
					executionOpportunityId: outcome.draftId,
					sourceKind: "reply_draft",
					sourceId: outcome.draftId,
					taskFamily: input.activity.taskFamily,
					riskLevel: input.activity.riskLevel,
					environment: "production",
					rubricVersion: input.activity.version,
					harness: "reply-draft",
					harnessVersion: "1",
					modelProvider: "unrecorded",
					modelId: "unrecorded",
					modelVersion: "unrecorded",
					outcome: outcome.verdict === "stood" ? "success" : "failure",
					complexity: 0,
					nonTrivial: false,
					heldOut: false,
					calibrationScore: 0,
					escalationQuality: 0,
					learningTransfer: false,
					evidenceRefs: [`work_interaction_reply_draft:${outcome.draftId}`],
					eligibilityStatus: "ineligible",
					evaluatorType: "user",
					evaluatorId: outcome.targetUserId,
					classificationMethod: CLASSIFICATION_METHOD,
					confidence: 1,
					metadata: { delivery: outcome.delivery, verdict: outcome.verdict },
					occurredAt: outcome.createdAt,
					createdAt: input.now,
				})
				.onConflictDoNothing(),
		);
	}
	for (let index = 0; index < statements.length; index += 50) {
		const chunk = statements.slice(index, index + 50);
		if (chunk.length > 0)
			await db.batch(chunk as [(typeof chunk)[0], ...typeof chunk]);
	}
	return statements.length;
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

/** Starts a tedi with no active role on the seed's role track. */
export async function ensureReplyDraftRole(
	db: DbClient,
	input: {
		organizationId: string;
		tediId: string;
		role: ReplyDraftingSeed["initialRole"];
		now: string;
	},
): Promise<TediRoleAssignmentRow> {
	return assignInitialRoleTrack(db, {
		organizationId: input.organizationId,
		tediId: input.tediId,
		roleKey: input.role.key,
		roleName: input.role.name,
		metadata: { startedBy: REPLY_DRAFT_LADDER_PRINCIPAL },
		now: input.now,
	});
}

/**
 * Moves the assignment one ladder step and records the applied decision that
 * explains it. Returns false when the assignment changed underneath.
 */
export async function applyReplyDraftCareerChange(
	db: DbClient,
	input: {
		assignment: TediRoleAssignmentRow;
		kind: "promote" | "demote";
		to: TediCareerStage;
		evidenceObservationIds: string[];
		snapshot: Record<string, JsonValue>;
		now: string;
	},
): Promise<boolean> {
	const { assignment } = input;
	const evidenceObservationIds = input.evidenceObservationIds.slice(
		0,
		MAX_DECISION_EVIDENCE,
	);
	if (evidenceObservationIds.length === 0) return false;
	const decisionId = crypto.randomUUID();
	const evidenceSnapshotHash = await hashSnapshot(input.snapshot);
	const clientProposalId = `${REPLY_DRAFT_LADDER_PRINCIPAL}:${assignment.id}:${assignment.revision}`;
	const changed = await db
		.batch([
			db
				.update(tediRoleAssignments)
				.set({
					careerStage: input.to,
					stageChangedAt: input.now,
					revision: assignment.revision + 1,
					lastDecisionId: decisionId,
					evidenceSnapshotHash,
					updatedAt: input.now,
				})
				.where(
					and(
						eq(tediRoleAssignments.id, assignment.id),
						eq(tediRoleAssignments.status, "active"),
						eq(tediRoleAssignments.revision, assignment.revision),
						eq(tediRoleAssignments.careerStage, assignment.careerStage),
					),
				)
				.returning({ id: tediRoleAssignments.id }),
			db.insert(promotionDecisions).values({
				id: decisionId,
				organizationId: assignment.organizationId,
				clientProposalId,
				inputHash: await hashSnapshot({ clientProposalId, to: input.to }),
				tediId: assignment.tediId,
				roleAssignmentId: assignment.id,
				kind: input.kind,
				status: "applied",
				fromCareerStage: assignment.careerStage,
				toCareerStage: input.to,
				expectedRoleRevision: assignment.revision,
				evidenceObservationIds,
				evidenceRefs: evidenceObservationIds.map(
					(id) => `competency_observation:${id}`,
				),
				evidenceSnapshot: input.snapshot,
				proposedByType: "service",
				proposedById: REPLY_DRAFT_LADDER_PRINCIPAL,
				decidedByType: "certification_service",
				decidedById: REPLY_DRAFT_LADDER_PRINCIPAL,
				reason: `Reply-drafting ladder ${input.kind}`,
				createdAt: input.now,
				updatedAt: input.now,
				proposalExpiresAt: input.now,
				decidedAt: input.now,
				appliedAt: input.now,
			}),
		])
		.then(([updated]) => updated.length > 0)
		.catch(async (error: unknown) => {
			// This revision already has a ladder decision: it moved already.
			const prior = await db
				.select({ id: promotionDecisions.id })
				.from(promotionDecisions)
				.where(
					and(
						eq(promotionDecisions.organizationId, assignment.organizationId),
						eq(promotionDecisions.clientProposalId, clientProposalId),
					),
				)
				.limit(1);
			if (prior[0]) return null;
			throw error;
		});
	if (changed === null) return false;
	if (changed) return true;
	await db
		.update(promotionDecisions)
		.set({
			status: "cancelled",
			reason: "Role assignment changed before the ladder applied",
			updatedAt: input.now,
		})
		.where(eq(promotionDecisions.id, decisionId));
	return false;
}

function shiftDays(iso: string, days: number): string {
	const date = new Date(iso);
	date.setUTCDate(date.getUTCDate() + days);
	return date.toISOString();
}
