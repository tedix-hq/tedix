import type { JsonValue } from "@tedix/api-contract/schemas/common";
import { and, desc, eq, inArray, isNull, lt, or, sql } from "drizzle-orm";
import type { DbQueryClient } from "../../query-client";
import {
	type WorkActorType,
	type WorkEvidence,
	type WorkEvidenceDisposition,
	workAttempts,
	workEvidence,
	workEvents,
} from "../../schema/work-items";
import {
	ACTIVE_ATTEMPT_STATES,
	getScopedWorkItem,
	type WorkActor,
	WorkFactoryError,
} from "./factory-state";

function evidenceEventInsert(
	db: DbQueryClient,
	params: {
		evidenceId: string;
		expectedVersion: number;
		disposition: WorkEvidenceDisposition;
		eventType: string;
		actor: WorkActor;
		occurredAt: string;
		payload: Record<string, JsonValue>;
	},
) {
	return db.insert(workEvents).select(
		db
			.select({
				id: sql<string>`${crypto.randomUUID()}`.as("id"),
				orgId: workEvidence.orgId,
				workItemId: workEvidence.workItemId,
				attemptId: workEvidence.attemptId,
				eventType: sql<string>`${params.eventType}`.as("event_type"),
				actorType: sql<WorkActorType>`${params.actor.type}`.as("actor_type"),
				actorId: sql<string>`${params.actor.id}`.as("actor_id"),
				actorSessionId: sql<
					string | null
				>`${params.actor.sessionId ?? null}`.as("actor_session_id"),
				payload: sql<
					Record<string, JsonValue>
				>`${JSON.stringify(params.payload)}`.as("payload"),
				occurredAt: sql<string>`${params.occurredAt}`.as("occurred_at"),
			})
			.from(workEvidence)
			.where(
				and(
					eq(workEvidence.id, params.evidenceId),
					eq(workEvidence.version, params.expectedVersion),
					eq(workEvidence.disposition, params.disposition),
				),
			),
	);
}

/**
 * Record one evidence observation against a claim key.
 *
 * Evidence is telemetry, not a gate
 * (`decisions/minimal-gates-over-pre-proof.md`): the declared
 * `evidenceKinds` allowlist no longer decides whether a row may be written, and
 * nothing here reviews, corroborates, or blocks. What remains is storage
 * integrity — the attempt fence derives `orgId`/`workItemId` from the
 * `work_attempts` row rather than from the caller, so an expired or foreign
 * executor cannot write onto another agent's item — plus org scoping and the
 * batch-conditioned `evidence.submitted` event.
 */
export async function submitWorkItemEvidence(
	db: DbQueryClient,
	params: {
		orgId: string;
		workItemId: string;
		attemptId?: string;
		externalSessionKey?: string;
		claimKey: string;
		kind: string;
		uri: string;
		digest?: string;
		mediaType?: string;
		label?: string;
		submittedBy: WorkActor;
		submittedAt?: string;
		metadata?: Record<string, JsonValue>;
	},
): Promise<WorkEvidence> {
	const submittedAt = params.submittedAt ?? new Date().toISOString();
	// Org scoping: resolves (and refuses) the item before anything is written.
	await getScopedWorkItem(db, params.orgId, params.workItemId);
	if (!params.attemptId && params.submittedBy.type !== "system") {
		throw new WorkFactoryError(
			"STALE_ATTEMPT",
			"Executor evidence requires an active attempt fence",
		);
	}
	const evidenceId = crypto.randomUUID();
	const directSystemEvidence =
		params.submittedBy.type === "system" && !params.attemptId;
	const insertEvidence = directSystemEvidence
		? db
				.insert(workEvidence)
				.values({
					id: evidenceId,
					orgId: params.orgId,
					workItemId: params.workItemId,
					claimKey: params.claimKey,
					kind: params.kind,
					uri: params.uri,
					digest: params.digest,
					mediaType: params.mediaType,
					label: params.label,
					submittedByType: "system",
					submittedById: params.submittedBy.id,
					disposition: "pending",
					submittedAt,
					metadata: params.metadata ?? {},
				})
				.returning()
		: db
				.insert(workEvidence)
				.select(
					db
						.select({
							id: sql<string>`${evidenceId}`.as("id"),
							workItemId: workAttempts.workItemId,
							orgId: workAttempts.orgId,
							attemptId: workAttempts.id,
							claimKey: sql<string>`${params.claimKey}`.as("claim_key"),
							kind: sql<string>`${params.kind}`.as("kind"),
							uri: sql<string>`${params.uri}`.as("uri"),
							digest: sql<string | null>`${params.digest ?? null}`.as("digest"),
							mediaType: sql<string | null>`${params.mediaType ?? null}`.as(
								"media_type",
							),
							label: sql<string | null>`${params.label ?? null}`.as("label"),
							submittedByType:
								sql<WorkActorType>`${params.submittedBy.type}`.as(
									"submitted_by_type",
								),
							submittedById: sql<string>`${params.submittedBy.id}`.as(
								"submitted_by_id",
							),
							submittedBySessionId: sql<
								string | null
							>`${params.submittedBy.sessionId ?? null}`.as(
								"submitted_by_session_id",
							),
							disposition: sql<"pending">`'pending'`.as("disposition"),
							reviewedByType: sql<null>`NULL`.as("reviewed_by_type"),
							reviewedById: sql<null>`NULL`.as("reviewed_by_id"),
							reviewedBySessionId: sql<null>`NULL`.as("reviewed_by_session_id"),
							reviewReason: sql<null>`NULL`.as("review_reason"),
							submittedAt: sql<string>`${submittedAt}`.as("submitted_at"),
							reviewedAt: sql<null>`NULL`.as("reviewed_at"),
							version: sql<number>`1`.as("version"),
							metadata: sql<
								Record<string, JsonValue>
							>`${JSON.stringify(params.metadata ?? {})}`.as("metadata"),
						})
						.from(workAttempts)
						.where(
							and(
								eq(workAttempts.id, params.attemptId!),
								eq(workAttempts.orgId, params.orgId),
								eq(workAttempts.workItemId, params.workItemId),
								eq(
									workAttempts.executorType,
									params.submittedBy.type as "tedi" | "external_agent",
								),
								eq(workAttempts.executorId, params.submittedBy.id),
								params.submittedBy.sessionId
									? eq(
											workAttempts.executorSessionId,
											params.submittedBy.sessionId,
										)
									: isNull(workAttempts.executorSessionId),
								params.externalSessionKey
									? eq(
											workAttempts.externalSessionKey,
											params.externalSessionKey,
										)
									: isNull(workAttempts.externalSessionKey),
								inArray(workAttempts.runtimeState, ACTIVE_ATTEMPT_STATES),
								sql`(${workAttempts.expiresAt} IS NULL OR ${workAttempts.expiresAt} > ${submittedAt})`,
							),
						),
				)
				.returning();
	const submitEvent = evidenceEventInsert(db, {
		evidenceId,
		expectedVersion: 1,
		disposition: "pending",
		eventType: "evidence.submitted",
		actor: params.submittedBy,
		occurredAt: submittedAt,
		payload: { evidenceId, claimKey: params.claimKey, kind: params.kind },
	});
	const [evidenceRows] = await db.batch([insertEvidence, submitEvent]);
	const evidence = evidenceRows[0];
	if (!evidence)
		throw new WorkFactoryError(
			"STALE_ATTEMPT",
			`Attempt ${params.attemptId} is no longer authoritative`,
		);
	return evidence;
}

export async function listWorkItemEvidence(
	db: DbQueryClient,
	params: {
		orgId: string;
		workItemId: string;
		cursor?: { submittedAt: string; id: string };
		limit?: number;
	},
): Promise<{
	data: WorkEvidence[];
	nextCursor: { submittedAt: string; id: string } | null;
}> {
	const limit = Math.min(Math.max(1, Math.trunc(params.limit ?? 50)), 100);
	const rows = await db
		.select()
		.from(workEvidence)
		.where(
			and(
				eq(workEvidence.orgId, params.orgId),
				eq(workEvidence.workItemId, params.workItemId),
				params.cursor
					? or(
							lt(workEvidence.submittedAt, params.cursor.submittedAt),
							and(
								eq(workEvidence.submittedAt, params.cursor.submittedAt),
								lt(workEvidence.id, params.cursor.id),
							),
						)
					: undefined,
			),
		)
		.orderBy(desc(workEvidence.submittedAt), desc(workEvidence.id))
		.limit(limit + 1);
	const data = rows.slice(0, limit),
		last = data.at(-1);
	return {
		data,
		nextCursor:
			rows.length > limit && last
				? { submittedAt: last.submittedAt, id: last.id }
				: null,
	};
}

export async function getWorkItemEvidence(
	db: DbQueryClient,
	params: { orgId: string; workItemId: string; evidenceId: string },
): Promise<WorkEvidence | null> {
	const [row] = await db
		.select()
		.from(workEvidence)
		.where(
			and(
				eq(workEvidence.orgId, params.orgId),
				eq(workEvidence.workItemId, params.workItemId),
				eq(workEvidence.id, params.evidenceId),
			),
		)
		.limit(1);
	return row ?? null;
}
