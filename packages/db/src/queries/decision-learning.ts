import { and, asc, desc, eq, gt, inArray, lte, sql } from "drizzle-orm";
import {
	decisionExposures,
	decisionOutcomeLabels,
	learningInteractionEvents,
} from "../schema/learning-feedback";
import {
	workInteractions,
	workInteractionResponses,
	workApprovalProposals,
	workApprovalDecisions,
} from "../schema/work-factory";
import { workItems } from "../schema/work-items";
import { tediApprovalRequests } from "../schema/approvals";
import { memoryFacts } from "../schema/memory-graph";
import {
	DecisionLearningConfigSchema,
	type DecisionLearningConfig,
} from "@tedix/api-contract/schemas/decision-learning";
import type { DbQueryClient } from "../query-client";
import { organizations } from "../schema/organizations";
import { chunkForBoundParams } from "../utils/batch";

export async function getDecisionLearningConfig(
	db: DbQueryClient,
	organizationId: string,
) {
	const [row] = await db
		.select({ metadata: organizations.metadata })
		.from(organizations)
		.where(eq(organizations.id, organizationId))
		.limit(1);
	return DecisionLearningConfigSchema.parse(
		row?.metadata?.decisionLearning ?? {},
	);
}
export async function setDecisionLearningConfig(
	db: DbQueryClient,
	organizationId: string,
	config: DecisionLearningConfig,
) {
	const parsed = DecisionLearningConfigSchema.parse(config);
	await db
		.update(organizations)
		.set({
			metadata: sql`json_set(coalesce(${organizations.metadata}, '{}'), '$.decisionLearning', json(${JSON.stringify(parsed)}))`,
		})
		.where(eq(organizations.id, organizationId));
	return parsed;
}

/** Every caller-supplied id is tenant and recipient fenced, including alternatives. */
export async function listDecisionInstrumentationSources(
	db: DbQueryClient,
	p: {
		organizationId: string;
		actorId: string;
		cardIds: string[];
		mayReadApprovals: boolean;
	},
) {
	const interactions: (typeof workInteractions.$inferSelect)[] = [];
	const proposals: (typeof workApprovalProposals.$inferSelect)[] = [];
	const approvals: (typeof tediApprovalRequests.$inferSelect)[] = [];
	for (let offset = 0; offset < p.cardIds.length; offset += 50) {
		const ids = p.cardIds.slice(offset, offset + 50);
		interactions.push(
			...(await db
				.select()
				.from(workInteractions)
				.where(
					and(
						eq(workInteractions.orgId, p.organizationId),
						eq(workInteractions.targetType, "user"),
						eq(workInteractions.targetId, p.actorId),
						inArray(workInteractions.id, ids),
					),
				)),
		);
		proposals.push(
			...(await db
				.select()
				.from(workApprovalProposals)
				.where(
					and(
						eq(workApprovalProposals.orgId, p.organizationId),
						eq(workApprovalProposals.approverType, "user"),
						eq(workApprovalProposals.approverId, p.actorId),
						inArray(
							workApprovalProposals.id,
							ids
								.filter((id) => id.startsWith("work-approval:"))
								.map((id) => id.slice(14)),
						),
					),
				)),
		);
		if (p.mayReadApprovals)
			approvals.push(
				...(await db
					.select()
					.from(tediApprovalRequests)
					.where(
						and(
							eq(tediApprovalRequests.orgId, p.organizationId),
							inArray(
								tediApprovalRequests.id,
								ids
									.filter((id) => id.startsWith("approval:"))
									.map((id) => id.slice(9)),
							),
						),
					)),
			);
	}
	const items: (typeof workItems.$inferSelect)[] = [];
	for (const ids of chunkForBoundParams(
		[
			...new Set([
				...interactions.flatMap((r) => (r.workItemId ? [r.workItemId] : [])),
				...proposals.map((r) => r.workItemId),
			]),
		],
		50,
	)) {
		items.push(
			...(await db
				.select()
				.from(workItems)
				.where(
					and(
						eq(workItems.orgId, p.organizationId),
						inArray(workItems.id, ids),
					),
				)),
		);
	}
	return { interactions, proposals, approvals, items };
}

export async function insertDecisionExposure(
	db: DbQueryClient,
	row: typeof decisionExposures.$inferInsert,
) {
	await db.insert(decisionExposures).values(row).onConflictDoNothing();
	return db
		.select()
		.from(decisionExposures)
		.where(
			and(
				eq(decisionExposures.organizationId, row.organizationId),
				eq(decisionExposures.actorId, row.actorId),
				eq(decisionExposures.id, row.id),
			),
		)
		.limit(1);
}

export async function listDecisionInstrumentation(
	db: DbQueryClient,
	p: {
		organizationId: string;
		actorId: string;
		cardId?: string;
		classId?: string;
		now: string;
		limit: number;
	},
) {
	const scope = and(
		eq(decisionExposures.organizationId, p.organizationId),
		eq(decisionExposures.actorId, p.actorId),
		gt(decisionExposures.expiresAt, p.now),
		p.cardId ? eq(decisionExposures.cardId, p.cardId) : undefined,
		p.classId ? eq(decisionExposures.classId, p.classId) : undefined,
	);
	const exposures = await db
		.select()
		.from(decisionExposures)
		.where(scope)
		.orderBy(desc(decisionExposures.occurredAt), asc(decisionExposures.id))
		.limit(p.limit);
	const labels = await db
		.select()
		.from(decisionOutcomeLabels)
		.where(
			and(
				eq(decisionOutcomeLabels.organizationId, p.organizationId),
				eq(decisionOutcomeLabels.actorId, p.actorId),
				gt(decisionOutcomeLabels.expiresAt, p.now),
				p.cardId ? eq(decisionOutcomeLabels.cardId, p.cardId) : undefined,
				p.classId ? eq(decisionOutcomeLabels.classId, p.classId) : undefined,
			),
		)
		.orderBy(
			desc(decisionOutcomeLabels.observedAt),
			asc(decisionOutcomeLabels.id),
		)
		.limit(p.limit * 3);
	return { exposures, labels };
}

/** Bounded source scan excludes already labelled receipts in SQL; undecided cards cannot starve it. */
export async function listUnlabelledDecisionResponses(
	db: DbQueryClient,
	now: string,
	limit = 50,
) {
	return db
		.select({
			exposureId: sql<string>`${decisionExposures.id}`.as("exposure_id"),
			organizationId: decisionExposures.organizationId,
			actorId: decisionExposures.actorId,
			cardId: decisionExposures.cardId,
			classId: decisionExposures.classId,
			expiresAt: decisionExposures.expiresAt,
			responseId: workInteractionResponses.id,
			respondedAt: workInteractionResponses.respondedAt,
			metadata: workInteractionResponses.metadata,
			responseKind: workInteractionResponses.responseKind,
		})
		.from(decisionExposures)
		.innerJoin(
			workInteractionResponses,
			and(
				eq(workInteractionResponses.orgId, decisionExposures.organizationId),
				eq(workInteractionResponses.interactionId, decisionExposures.cardId),
				eq(workInteractionResponses.responderId, decisionExposures.actorId),
				eq(workInteractionResponses.responderType, "user"),
				sql`${workInteractionResponses.respondedAt} >= ${decisionExposures.occurredAt}`,
				// The response stores the post-save version; the exposure saw the prior request.
				sql`json_extract(${decisionExposures.context},'$.sourceVersion') + 1 = ${workInteractionResponses.resolvedRequestVersion}`,
			),
		)
		.where(
			and(
				gt(decisionExposures.expiresAt, now),
				sql`NOT EXISTS (SELECT 1 FROM decision_outcome_labels l WHERE l.organization_id=${decisionExposures.organizationId} AND l.actor_id=${decisionExposures.actorId} AND l.id=(${decisionExposures.organizationId} || ':' || ${workInteractionResponses.id} || ':immediate'))`,
			),
		)
		.orderBy(
			asc(workInteractionResponses.respondedAt),
			asc(workInteractionResponses.id),
			desc(decisionExposures.occurredAt),
			desc(decisionExposures.id),
		)
		.limit(limit);
}

export async function listUnlabelledDecisionApprovals(
	db: DbQueryClient,
	now: string,
	limit = 50,
) {
	const work = await db
		.select({
			exposureId: sql<string>`${decisionExposures.id}`.as("exposure_id"),
			organizationId: decisionExposures.organizationId,
			actorId: decisionExposures.actorId,
			cardId: decisionExposures.cardId,
			classId: decisionExposures.classId,
			expiresAt: decisionExposures.expiresAt,
			receiptId: workApprovalDecisions.id,
			decidedAt: workApprovalDecisions.decidedAt,
			decision: workApprovalDecisions.decision,
		})
		.from(decisionExposures)
		.innerJoin(
			workApprovalProposals,
			and(
				eq(workApprovalProposals.orgId, decisionExposures.organizationId),
				sql`${decisionExposures.cardId} = ('work-approval:' || ${workApprovalProposals.id})`,
			),
		)
		.innerJoin(
			workApprovalDecisions,
			and(
				eq(workApprovalDecisions.proposalId, workApprovalProposals.id),
				eq(workApprovalDecisions.deciderType, "user"),
				eq(workApprovalDecisions.deciderId, decisionExposures.actorId),
				sql`${workApprovalDecisions.decidedAt}>=${decisionExposures.occurredAt}`,
			),
		)
		.where(
			and(
				gt(decisionExposures.expiresAt, now),
				sql`NOT EXISTS (SELECT 1 FROM decision_outcome_labels l WHERE l.organization_id=${decisionExposures.organizationId} AND l.id=(${decisionExposures.organizationId} || ':' || ${workApprovalDecisions.id} || ':immediate'))`,
			),
		)
		.orderBy(asc(workApprovalDecisions.decidedAt))
		.limit(limit);
	const tedi = await db
		.select({
			exposureId: sql<string>`${decisionExposures.id}`.as("exposure_id"),
			organizationId: decisionExposures.organizationId,
			actorId: decisionExposures.actorId,
			cardId: decisionExposures.cardId,
			classId: decisionExposures.classId,
			expiresAt: decisionExposures.expiresAt,
			receiptId: tediApprovalRequests.id,
			decidedAt: tediApprovalRequests.resolvedAt,
			decision: tediApprovalRequests.status,
		})
		.from(decisionExposures)
		.innerJoin(
			tediApprovalRequests,
			and(
				eq(tediApprovalRequests.orgId, decisionExposures.organizationId),
				sql`${decisionExposures.cardId} = ('approval:' || ${tediApprovalRequests.id})`,
				eq(tediApprovalRequests.resolvedBy, decisionExposures.actorId),
				inArray(tediApprovalRequests.status, ["approved", "rejected"]),
				sql`${tediApprovalRequests.resolvedAt}>=${decisionExposures.occurredAt}`,
			),
		)
		.where(
			and(
				gt(decisionExposures.expiresAt, now),
				sql`NOT EXISTS (SELECT 1 FROM decision_outcome_labels l WHERE l.organization_id=${decisionExposures.organizationId} AND l.id=(${decisionExposures.organizationId} || ':' || ${tediApprovalRequests.id} || ':immediate'))`,
			),
		)
		.orderBy(asc(tediApprovalRequests.resolvedAt))
		.limit(limit);
	return [...work, ...tedi];
}

export async function insertDecisionOutcomeLabel(
	db: DbQueryClient,
	row: typeof decisionOutcomeLabels.$inferInsert,
) {
	const inserted = await db
		.insert(decisionOutcomeLabels)
		.values(row)
		.onConflictDoNothing()
		.returning({ id: decisionOutcomeLabels.id });
	return inserted.length > 0;
}
export async function listDueDecisionLabels(
	db: DbQueryClient,
	now: string,
	window: "day_1" | "day_7",
	limit = 50,
) {
	const milliseconds = window === "day_1" ? 86400000 : 604800000;
	return db
		.select()
		.from(decisionOutcomeLabels)
		.where(
			and(
				eq(decisionOutcomeLabels.window, "immediate"),
				lte(
					decisionOutcomeLabels.dueAt,
					new Date(Date.parse(now) - milliseconds).toISOString(),
				),
				gt(decisionOutcomeLabels.expiresAt, now),
				sql`NOT EXISTS (SELECT 1 FROM decision_outcome_labels l WHERE l.id = (${decisionOutcomeLabels.id} || ':' || ${window}))`,
			),
		)
		.orderBy(asc(decisionOutcomeLabels.dueAt), asc(decisionOutcomeLabels.id))
		.limit(limit);
}
export async function getDecisionLabelEvidence(
	db: DbQueryClient,
	p: {
		organizationId: string;
		actorId: string;
		cardId: string;
		receiptId: string;
		exposureId: string;
		decidedAt: string;
		until: string;
	},
) {
	const exposures = await db
		.select({ snapshot: decisionExposures.snapshot })
		.from(decisionExposures)
		.where(
			and(
				eq(decisionExposures.organizationId, p.organizationId),
				eq(decisionExposures.actorId, p.actorId),
				eq(decisionExposures.cardId, p.cardId),
				eq(decisionExposures.id, p.exposureId),
				sql`${decisionExposures.occurredAt}<=${p.decidedAt}`,
			),
		)
		.orderBy(desc(decisionExposures.occurredAt))
		.limit(1);
	const workItemId = exposures[0]?.snapshot.workItemId;
	const work = workItemId
		? await db
				.select({
					id: workItems.id,
					disposition: workItems.disposition,
					completedAt: workItems.completedAt,
				})
				.from(workItems)
				.where(
					and(
						eq(workItems.orgId, p.organizationId),
						eq(workItems.id, workItemId),
					),
				)
				.limit(1)
		: [];
	const events = await db
		.select({
			id: learningInteractionEvents.id,
			eventKind: learningInteractionEvents.eventKind,
			metadata: learningInteractionEvents.metadata,
		})
		.from(learningInteractionEvents)
		.where(
			and(
				eq(learningInteractionEvents.organizationId, p.organizationId),
				sql`(${learningInteractionEvents.scopeKind} <> 'personal' OR ${learningInteractionEvents.scopeId}=${p.actorId})`,
				sql`${learningInteractionEvents.occurredAt}>${p.decidedAt}`,
				lte(learningInteractionEvents.occurredAt, p.until),
				sql`(${learningInteractionEvents.targetId}=${p.cardId} OR ${learningInteractionEvents.targetId}=${workItemId ?? p.cardId} OR (${p.cardId} LIKE 'approval:%' AND ${learningInteractionEvents.targetId}=substr(${p.cardId},10)) OR json_extract(${learningInteractionEvents.metadata},'$.correctsEventId') IN (SELECT id FROM learning_interaction_events le WHERE le.organization_id=${p.organizationId} AND le.client_event_id=('decision-capture:' || ${p.receiptId})))`,
				sql`json_extract(${learningInteractionEvents.metadata},'$.serverObserved')=1`,
			),
		)
		.limit(50);
	const lessons = await db
		.select({ id: memoryFacts.id })
		.from(memoryFacts)
		.where(
			and(
				eq(memoryFacts.organizationId, p.organizationId),
				sql`(json_extract(${memoryFacts.metadata},'$.learningFeed.ownerUserId')=${p.actorId} OR (${memoryFacts.tediId} IS NULL AND (coalesce(${memoryFacts.visibility},'private')<>'private' OR json_extract(${memoryFacts.metadata},'$.learningFeed.ownerUserId') IS NULL)))`,
				sql`datetime(${memoryFacts.createdAt})>datetime(${p.decidedAt})`,
				sql`datetime(${memoryFacts.createdAt})<=datetime(${p.until})`,
				sql`EXISTS (SELECT 1 FROM json_each(json_extract(${memoryFacts.metadata},'$.learningFeed.evidenceEventIds')) e JOIN learning_interaction_events le ON le.id=e.value AND le.organization_id=${p.organizationId} WHERE le.target_id=${p.cardId})`,
			),
		)
		.limit(50);
	const followUps = workItemId
		? await db
				.select({ id: workInteractions.id })
				.from(workInteractions)
				.where(
					and(
						eq(workInteractions.orgId, p.organizationId),
						eq(workInteractions.targetId, p.actorId),
						eq(workInteractions.targetType, "user"),
						eq(workInteractions.workItemId, workItemId),
						sql`${workInteractions.createdAt}>${p.decidedAt}`,
						lte(workInteractions.createdAt, p.until),
					),
				)
				.limit(50)
		: [];
	return { work: work[0] ?? null, events, lessons, followUps };
}

export async function pruneDecisionInstrumentation(
	db: DbQueryClient,
	now: string,
) {
	await db.batch([
		db
			.delete(decisionOutcomeLabels)
			.where(lte(decisionOutcomeLabels.expiresAt, now)),
		db.delete(decisionExposures).where(lte(decisionExposures.expiresAt, now)),
	]);
}

/** A deferral is timing feedback, never a negative approval outcome. */
export async function getDecisionDeferralTime(
	db: DbQueryClient,
	p: {
		organizationId: string;
		actorId: string;
		cardId: string;
		before: string;
	},
) {
	const events = await db
		.select({ at: learningInteractionEvents.occurredAt })
		.from(learningInteractionEvents)
		.where(
			and(
				eq(learningInteractionEvents.organizationId, p.organizationId),
				eq(learningInteractionEvents.actorId, p.actorId),
				eq(learningInteractionEvents.targetId, p.cardId),
				eq(learningInteractionEvents.scopeKind, "personal"),
				eq(learningInteractionEvents.scopeId, p.actorId),
				sql`json_extract(${learningInteractionEvents.metadata},'$.decisionChoice')='later'`,
				lte(learningInteractionEvents.occurredAt, p.before),
			),
		)
		.orderBy(asc(learningInteractionEvents.occurredAt))
		.limit(1);
	const responses = await db
		.select({ at: workInteractionResponses.respondedAt })
		.from(workInteractionResponses)
		.where(
			and(
				eq(workInteractionResponses.orgId, p.organizationId),
				eq(workInteractionResponses.interactionId, p.cardId),
				eq(workInteractionResponses.responderId, p.actorId),
				eq(workInteractionResponses.responderType, "user"),
				sql`json_extract(${workInteractionResponses.metadata},'$.decisionChoice')='later'`,
				sql`${workInteractionResponses.respondedAt}<${p.before}`,
			),
		)
		.orderBy(asc(workInteractionResponses.respondedAt))
		.limit(1);
	return [...events, ...responses].map((r) => r.at).sort()[0] ?? null;
}

/** Skip/Later is an authenticated browser report, separately identified from an action receipt. */
export async function listUnlabelledDecisionDeferrals(
	db: DbQueryClient,
	now: string,
	limit = 50,
) {
	// CROSS JOIN fixes SQLite's loop order: scan feedback once, then look up
	// exposures by org/actor/card instead of rescanning a user's feedback for
	// every exposure. The output limit alone does not bound that join work.
	return db
		.select({
			exposureId: sql<string>`${decisionExposures.id}`.as("exposure_id"),
			organizationId: decisionExposures.organizationId,
			actorId: decisionExposures.actorId,
			cardId: decisionExposures.cardId,
			classId: decisionExposures.classId,
			expiresAt: decisionExposures.expiresAt,
			eventId: learningInteractionEvents.id,
			occurredAt: learningInteractionEvents.occurredAt,
		})
		.from(learningInteractionEvents)
		.crossJoin(decisionExposures)
		.where(
			and(
				eq(
					learningInteractionEvents.organizationId,
					decisionExposures.organizationId,
				),
				eq(learningInteractionEvents.actorId, decisionExposures.actorId),
				eq(learningInteractionEvents.scopeKind, "personal"),
				eq(learningInteractionEvents.scopeId, decisionExposures.actorId),
				eq(learningInteractionEvents.targetId, decisionExposures.cardId),
				eq(learningInteractionEvents.surface, "decision_deck"),
				sql`json_extract(${learningInteractionEvents.metadata},'$.decisionChoice')='later'`,
				sql`${learningInteractionEvents.occurredAt}>=${decisionExposures.occurredAt}`,
				gt(decisionExposures.expiresAt, now),
				sql`NOT EXISTS (SELECT 1 FROM decision_outcome_labels l WHERE l.id=(${learningInteractionEvents.organizationId} || ':' || ${learningInteractionEvents.id} || ':immediate'))`,
			),
		)
		.orderBy(
			asc(learningInteractionEvents.occurredAt),
			desc(decisionExposures.occurredAt),
		)
		.limit(limit);
}

export async function getDecisionExposure(
	db: DbQueryClient,
	p: { organizationId: string; actorId: string; id: string },
) {
	const [row] = await db
		.select()
		.from(decisionExposures)
		.where(
			and(
				eq(decisionExposures.organizationId, p.organizationId),
				eq(decisionExposures.actorId, p.actorId),
				eq(decisionExposures.id, p.id),
			),
		)
		.limit(1);
	return row ?? null;
}
