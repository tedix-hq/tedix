/**
 * Agent decision journal reads. Records live in `learning_interaction_events`
 * on surface `agent_decision`: a decision is an event of kind `decided`; an
 * outcome is an event targeting it (`target_type = agent_decision`). Writes
 * go through `recordLearningInteraction`.
 */

import { and, count, desc, eq, gte, inArray, or } from "drizzle-orm";
import type { DbQueryClient } from "../query-client";
import {
	type LearningInteractionEventRow,
	learningInteractionEvents,
} from "../schema/learning-feedback";
import { organizationMembers } from "../schema/organization-members";
import { chunkForBoundParams } from "../utils/batch";

export const AGENT_DECISION_SURFACE = "agent_decision";
export const AGENT_DECISION_TARGET_TYPE = "agent_decision";
const OUTCOME_CHUNK = 50;

/** `created_at` is SQLite CURRENT_TIMESTAMP text: `YYYY-MM-DD HH:MM:SS`. */
function sqliteTimestamp(iso: string): string {
	return new Date(iso).toISOString().slice(0, 19).replace("T", " ");
}

/** Decisions one Agent-Session recorded since `since` (by write time). */
export async function countAgentDecisionsRecordedSince(
	db: DbQueryClient,
	input: { organizationId: string; agentSession: string; since: string },
): Promise<number> {
	const [row] = await db
		.select({ total: count() })
		.from(learningInteractionEvents)
		.where(
			and(
				eq(learningInteractionEvents.organizationId, input.organizationId),
				eq(learningInteractionEvents.surface, AGENT_DECISION_SURFACE),
				eq(learningInteractionEvents.eventKind, "decided"),
				eq(learningInteractionEvents.threadId, input.agentSession),
				gte(learningInteractionEvents.createdAt, sqliteTimestamp(input.since)),
			),
		)
		.limit(1);
	return Number(row?.total ?? 0);
}

/** One journaled decision of this organization, or null. */
export async function getAgentDecisionEvent(
	db: DbQueryClient,
	input: { organizationId: string; decisionId: string },
): Promise<LearningInteractionEventRow | null> {
	const [row] = await db
		.select()
		.from(learningInteractionEvents)
		.where(
			and(
				eq(learningInteractionEvents.organizationId, input.organizationId),
				eq(learningInteractionEvents.id, input.decisionId),
				eq(learningInteractionEvents.surface, AGENT_DECISION_SURFACE),
				eq(learningInteractionEvents.eventKind, "decided"),
			),
		)
		.limit(1);
	return row ?? null;
}

/**
 * Decisions made since `since`, newest first, optionally only those recorded
 * by one principal, plus every outcome recorded for them.
 */
export async function listAgentDecisionJournal(
	db: DbQueryClient,
	input: {
		organizationId: string;
		since: string;
		limit: number;
		recordedBy?: {
			actorType: LearningInteractionEventRow["actorType"];
			actorId: string;
		};
		issueKey?: string;
	},
): Promise<LearningInteractionEventRow[]> {
	const decisions = await db
		.select()
		.from(learningInteractionEvents)
		.where(
			and(
				eq(learningInteractionEvents.organizationId, input.organizationId),
				eq(learningInteractionEvents.surface, AGENT_DECISION_SURFACE),
				eq(learningInteractionEvents.eventKind, "decided"),
				gte(learningInteractionEvents.occurredAt, input.since),
				input.recordedBy
					? and(
							eq(
								learningInteractionEvents.actorType,
								input.recordedBy.actorType,
							),
							eq(learningInteractionEvents.actorId, input.recordedBy.actorId),
						)
					: undefined,
				input.issueKey
					? eq(learningInteractionEvents.issueKey, input.issueKey)
					: undefined,
			),
		)
		.orderBy(desc(learningInteractionEvents.occurredAt))
		.limit(input.limit);
	const outcomes: LearningInteractionEventRow[] = [];
	for (const ids of chunkForBoundParams(
		decisions.map((row) => row.id),
		OUTCOME_CHUNK,
	)) {
		outcomes.push(
			...(await db
				.select()
				.from(learningInteractionEvents)
				.where(
					and(
						eq(learningInteractionEvents.organizationId, input.organizationId),
						eq(learningInteractionEvents.scopeKind, "organization"),
						eq(learningInteractionEvents.scopeId, input.organizationId),
						eq(
							learningInteractionEvents.targetType,
							AGENT_DECISION_TARGET_TYPE,
						),
						// bound-params: chunkForBoundParams caps each list at 50
						inArray(learningInteractionEvents.targetId, ids),
					),
				)
				.orderBy(desc(learningInteractionEvents.occurredAt))
				.limit(ids.length * 5)),
		);
	}
	return [...decisions, ...outcomes];
}

/**
 * Which of the given decisions already carry an outcome event. Daily review
 * cards stay open until every decision they list has one.
 */
export async function listAgentDecisionsWithOutcome(
	db: DbQueryClient,
	input: { organizationId: string; decisionIds: readonly string[] },
): Promise<Set<string>> {
	const decided = new Set<string>();
	for (const ids of chunkForBoundParams(
		[...input.decisionIds],
		OUTCOME_CHUNK,
	)) {
		const rows = await db
			.selectDistinct({ targetId: learningInteractionEvents.targetId })
			.from(learningInteractionEvents)
			.where(
				and(
					eq(learningInteractionEvents.organizationId, input.organizationId),
					eq(learningInteractionEvents.surface, AGENT_DECISION_SURFACE),
					eq(learningInteractionEvents.targetType, AGENT_DECISION_TARGET_TYPE),
					inArray(learningInteractionEvents.targetId, ids),
				),
			)
			.limit(ids.length);
		for (const row of rows) if (row.targetId) decided.add(row.targetId);
	}
	return decided;
}

/**
 * People whose agents recorded decisions since `since`, across
 * organizations, for the scheduled morning review. Bounded.
 */
export async function listAgentDecisionRecorders(
	db: DbQueryClient,
	input: { since: string; limit: number },
): Promise<Array<{ organizationId: string; userId: string }>> {
	const rows = await db
		.selectDistinct({
			organizationId: learningInteractionEvents.organizationId,
			actorId: learningInteractionEvents.actorId,
		})
		.from(learningInteractionEvents)
		.where(
			and(
				gte(learningInteractionEvents.createdAt, sqliteTimestamp(input.since)),
				eq(learningInteractionEvents.surface, AGENT_DECISION_SURFACE),
				eq(learningInteractionEvents.eventKind, "decided"),
				eq(learningInteractionEvents.actorType, "user"),
			),
		)
		.limit(input.limit);
	return rows.flatMap((row) =>
		row.actorId
			? [{ organizationId: row.organizationId, userId: row.actorId }]
			: [],
	);
}

/**
 * The active member a recorded decision belongs to: journal events carry the
 * caller's identity-provider subject, Deck cards address the member user id.
 */
export async function getActiveMemberUserIdForSubject(
	db: DbQueryClient,
	input: { organizationId: string; subject: string },
): Promise<string | null> {
	const [row] = await db
		.select({ userId: organizationMembers.userId })
		.from(organizationMembers)
		.where(
			and(
				eq(organizationMembers.organizationId, input.organizationId),
				eq(organizationMembers.status, "active"),
				or(
					eq(organizationMembers.descopeUserId, input.subject),
					eq(organizationMembers.userId, input.subject),
				),
			),
		)
		.limit(1);
	return row?.userId ?? null;
}
