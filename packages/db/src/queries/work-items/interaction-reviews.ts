import type { JsonValue } from "@tedix/api-contract/schemas/common";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import type { DbQueryClient } from "../../query-client";
import { agentSessionRequests } from "../../schema/agent-session-requests";
import { tediRuntimeEvents } from "../../schema/cognitive-runtime";
import { workAttempts } from "../../schema/work-items";
import {
	workInteractions,
	workInteractionResponses,
	type WorkInteraction,
} from "../../schema/work-factory";
import { WorkControlError, requireWorkItem } from "./factory-validation";
import {
	getWorkInteraction,
	validateActor,
	type InteractionActor,
} from "./interactions";

export interface ReviewWorkInteractionParams {
	orgId: string;
	interactionId: string;
	expectedVersion: number;
	actor: InteractionActor;
	action: "close" | "reask" | "continued";
	note: string;
	responseId?: string;
	evidenceId?: string;
	now: string;
}

/** Only the original asker (and exact harness session) owns the next step. */
export async function reviewWorkInteraction(
	db: DbQueryClient,
	p: ReviewWorkInteractionParams,
) {
	await validateActor(db, p.orgId, p.actor);
	const request = await getWorkInteraction(db, p);
	if (
		!request ||
		request.creatorType !== p.actor.type ||
		request.creatorId !== p.actor.id ||
		(request.creatorType === "external_agent" &&
			request.creatorSessionId !== p.actor.sessionId)
	) {
		throw new WorkControlError(
			"INVALID_PRINCIPAL",
			"Only the original ask owner may review or continue it",
		);
	}
	const rawFollow = request.metadata.followThrough;
	const follow =
		rawFollow && typeof rawFollow === "object" && !Array.isArray(rawFollow)
			? rawFollow
			: undefined;
	let continuation: Record<string, JsonValue> | null = null;
	if (p.action === "continued") {
		const [answer] = await db
			.select()
			.from(workInteractionResponses)
			.where(
				and(
					eq(workInteractionResponses.orgId, p.orgId),
					eq(workInteractionResponses.interactionId, request.id),
					sql`(${workInteractionResponses.resolvesRequest}=1 OR json_extract(${workInteractionResponses.metadata},'$.corrects') IS NOT NULL)`,
				),
			)
			.orderBy(
				desc(workInteractionResponses.respondedAt),
				desc(workInteractionResponses.id),
			)
			.limit(1);
		if (
			request.status !== "resolved" ||
			!answer ||
			answer.id !== p.responseId ||
			!p.evidenceId
		)
			throw new WorkControlError(
				"CONFLICT",
				"Continuation requires the current exact answer and action evidence",
			);
		const evidence =
			p.actor.type === "tedi"
				? await db
						.select({ id: tediRuntimeEvents.id })
						.from(tediRuntimeEvents)
						.where(
							and(
								eq(tediRuntimeEvents.organizationId, p.orgId),
								eq(tediRuntimeEvents.tediId, p.actor.id),
								eq(tediRuntimeEvents.id, p.evidenceId),
								eq(tediRuntimeEvents.kind, "tool.completed"),
								sql`${tediRuntimeEvents.createdAt}>=${answer.respondedAt}`,
								sql`coalesce(json_extract(${tediRuntimeEvents.payload},'$.success'),1)<>0`,
							),
						)
						.limit(1)
				: p.actor.type === "external_agent"
					? await db
							.select({ id: workAttempts.id })
							.from(workAttempts)
							.where(
								and(
									eq(workAttempts.orgId, p.orgId),
									eq(workAttempts.id, p.evidenceId),
									eq(workAttempts.workItemId, request.workItemId ?? ""),
									eq(workAttempts.executorType, "external_agent"),
									eq(workAttempts.executorId, p.actor.id),
									eq(workAttempts.executorSessionId, p.actor.sessionId!),
									eq(workAttempts.outcome, "succeeded"),
									sql`${workAttempts.finishedAt}>=${answer.respondedAt}`,
								),
							)
							.limit(1)
					: [];
		if (!evidence.length)
			throw new WorkControlError(
				"CONFLICT",
				"Owner continuation action evidence was not found after the answer",
			);
		if (
			follow?.receipt &&
			typeof follow.receipt === "object" &&
			!Array.isArray(follow.receipt) &&
			follow.receipt.responseId === p.responseId &&
			follow.receipt.evidenceId === p.evidenceId
		)
			return request;
		continuation = {
			responseId: answer.id,
			evidenceId: p.evidenceId,
			note: p.note,
			at: p.now,
		};
	} else {
		const reviewAt =
			typeof follow?.reviewAt === "string"
				? follow.reviewAt
				: new Date(
						Date.parse(request.createdAt) + 3 * 86_400_000,
					).toISOString();
		if (
			request.status !== "open" ||
			(request.expiresAt && request.expiresAt <= p.now) ||
			reviewAt > p.now
		)
			throw new WorkControlError(
				"CONFLICT",
				"This ask is not due for an unanswered review",
			);
		if (p.action === "reask" && follow?.reaskedAt)
			throw new WorkControlError(
				"CONFLICT",
				"An unanswered ask may be re-asked only once",
			);
		if (p.action === "reask" && request.workItemId) {
			const work = await requireWorkItem(db, p.orgId, request.workItemId);
			if (work.disposition === "completed" || work.disposition === "cancelled")
				throw new WorkControlError(
					"CONFLICT",
					"Do not re-ask about completed or cancelled Work",
				);
		}
	}
	if (request.version !== p.expectedVersion)
		throw new WorkControlError(
			"CONFLICT",
			"Interaction changed; read it again",
		);
	const nextFollow: Record<string, JsonValue> = {
		...follow,
		reviewedAt: p.now,
		note: p.note,
		...(continuation ? { receipt: continuation } : {}),
		...(p.action === "reask"
			? {
					reaskedAt: p.now,
					reaskNote: p.note,
					reviewAt: new Date(Date.parse(p.now) + 3 * 86_400_000).toISOString(),
				}
			: {}),
	};
	const mutation = db
		.update(workInteractions)
		.set({
			metadata: { ...request.metadata, followThrough: nextFollow },
			...(p.action === "close"
				? {
						status: "cancelled" as const,
						cancelledAt: p.now,
						resolutionFence: crypto.randomUUID(),
					}
				: {}),
			version: sql`${workInteractions.version}+1`,
		})
		.where(
			and(
				eq(workInteractions.orgId, p.orgId),
				eq(workInteractions.id, request.id),
				eq(workInteractions.version, p.expectedVersion),
			),
		)
		.returning();
	const [rows] = await db.batch([
		mutation,
		...(p.action === "close" &&
		request.targetType === "user" &&
		request.targetId &&
		(request.metadata.laneHandoff || follow?.laneHandoff)
			? [
					db
						.update(agentSessionRequests)
						.set({
							status: "cancelled",
							statusChangedAt: p.now,
							updatedAt: p.now,
						})
						.where(
							and(
								eq(agentSessionRequests.organizationId, p.orgId),
								eq(agentSessionRequests.userId, request.targetId),
								eq(
									agentSessionRequests.evidence,
									`/work/interactions/${request.id}`,
								),
								sql`EXISTS (SELECT 1 FROM work_interactions i WHERE i.org_id=${p.orgId} AND i.id=${request.id} AND i.status='cancelled' AND i.version=${p.expectedVersion + 1})`,
							),
						),
				]
			: []),
	]);
	const updated = rows[0];
	if (!updated)
		throw new WorkControlError("CONFLICT", "Interaction changed during review");
	return updated;
}

/** Global scheduler read. Finished Work and ended owner sessions never get nudged. */
export async function listDueWorkInteractionReviews(
	db: DbQueryClient,
	now: string,
) {
	return db
		.select()
		.from(workInteractions)
		.where(
			and(
				eq(workInteractions.targetType, "user"),
				sql`${workInteractions.kind}<>'coordination'`,
				sql`((${workInteractions.status}='open'
					AND (${workInteractions.expiresAt} IS NULL OR ${workInteractions.expiresAt}>${now})
					AND coalesce(json_extract(${workInteractions.metadata},'$.followThrough.reviewAt'),strftime('%Y-%m-%dT%H:%M:%fZ',${workInteractions.createdAt},'+3 days'))<=${now}
					AND coalesce(json_extract(${workInteractions.metadata},'$.followThrough.reviewWakeVersion'),0)<>${workInteractions.version})
				 OR (${workInteractions.status}='resolved'
					AND coalesce(json_extract(${workInteractions.metadata},'$.followThrough.continuationRetryAt'),'')<=${now}
					AND EXISTS (SELECT 1 FROM work_interaction_responses r WHERE r.org_id=${workInteractions.orgId} AND r.interaction_id=${workInteractions.id}
						AND (r.resolves_request=1 OR json_extract(r.metadata,'$.corrects') IS NOT NULL)
						AND coalesce(json_extract(r.metadata,'$.delivery'),'')<>'none'
						AND r.responded_at<=${new Date(Date.parse(now) - 300_000).toISOString()}
						AND r.id IS NOT json_extract(${workInteractions.metadata},'$.followThrough.receipt.responseId')
						AND NOT EXISTS (SELECT 1 FROM work_interaction_responses newer WHERE newer.org_id=r.org_id AND newer.interaction_id=r.interaction_id AND (newer.resolves_request=1 OR json_extract(newer.metadata,'$.corrects') IS NOT NULL) AND (newer.responded_at>r.responded_at OR (newer.responded_at=r.responded_at AND newer.id>r.id))))))`,
				sql`NOT EXISTS (SELECT 1 FROM work_items w WHERE w.org_id=${workInteractions.orgId} AND w.id=${workInteractions.workItemId} AND w.disposition IN ('completed','cancelled'))`,
				sql`((${workInteractions.creatorType}='tedi' AND EXISTS (SELECT 1 FROM tedis t WHERE t.id=${workInteractions.creatorId} AND t.organization_id=${workInteractions.orgId} AND t.status='active')) OR
		(${workInteractions.creatorType}='external_agent' AND EXISTS (SELECT 1 FROM external_agent_sessions s WHERE s.id=${workInteractions.creatorSessionId} AND s.organization_id=${workInteractions.orgId} AND s.principal_id=${workInteractions.creatorId} AND s.status='active')) OR EXISTS (SELECT 1 FROM work_items w JOIN tedis t ON t.id=w.accountable_owner_id AND t.organization_id=w.org_id WHERE w.org_id=${workInteractions.orgId} AND w.id=${workInteractions.workItemId} AND w.accountable_owner_type='tedi' AND t.status='active' AND t.retired_at IS NULL))`,
			),
		)
		.orderBy(asc(workInteractions.createdAt), asc(workInteractions.id))
		.limit(50);
}

export async function recordWorkInteractionReviewWake(
	db: DbQueryClient,
	row: WorkInteraction,
	now: string,
	runId: string | null,
) {
	await db
		.update(workInteractions)
		.set({
			metadata:
				row.status === "resolved"
					? sql`json_set(${workInteractions.metadata},'$.followThrough.continuationWakeAt',${now},'$.followThrough.continuationRunId',${runId},'$.followThrough.continuationRetryAt',${new Date(Date.parse(now) + 6 * 3_600_000).toISOString()})`
					: sql`json_set(${workInteractions.metadata},'$.followThrough.reviewWakeVersion',${row.version},'$.followThrough.reviewRunId',${runId})`,
		})
		.where(
			and(
				eq(workInteractions.orgId, row.orgId),
				eq(workInteractions.id, row.id),
				eq(workInteractions.version, row.version),
				eq(workInteractions.status, row.status),
			),
		);
}

/** Recognize a manually prepared deadline card before the automatic source runs. */
export async function getDeadlineDecision(
	db: DbQueryClient,
	input: {
		orgId: string;
		userId: string;
		workItemId: string;
		deadlineKey: string;
	},
) {
	return (
		(
			await db
				.select()
				.from(workInteractions)
				.where(
					and(
						eq(workInteractions.orgId, input.orgId),
						eq(workInteractions.workItemId, input.workItemId),
						eq(workInteractions.targetType, "user"),
						eq(workInteractions.targetId, input.userId),
						sql`json_extract(${workInteractions.metadata}, '$.source') = 'deadline-decisions'`,
						sql`json_extract(${workInteractions.metadata}, '$.deadlineKey') = ${input.deadlineKey}`,
					),
				)
				.limit(1)
		)[0] ?? null
	);
}
