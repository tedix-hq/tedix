import {
	and,
	asc,
	desc,
	eq,
	gte,
	inArray,
	isNotNull,
	isNull,
	lt,
	lte,
	notExists,
	or,
	sql,
} from "drizzle-orm";
import type { DbClient } from "../client";
import { auditEvents } from "../schema/audit-events";
import { tediApprovalRequests } from "../schema/approvals";
import {
	chatDispatchIdempotency,
	kernelRuntimeRuns,
	kernelWakeQueue,
	tediArtifacts,
	tediRuntimeEvents,
} from "../schema/cognitive-runtime";
import { tediSessionStates } from "../schema/tedi-sessions";
import { tedis } from "../schema/tedis";

export type TediRuntimeEventRow = typeof tediRuntimeEvents.$inferSelect;
export type TediRuntimeEventInsert = typeof tediRuntimeEvents.$inferInsert;
export type TediRuntimeEventKind = TediRuntimeEventInsert["kind"];
export type TediRuntimeEventCursor = Pick<
	TediRuntimeEventRow,
	"createdAt" | "id"
>;
export type TediConversationCompactionEventRow = Pick<
	TediRuntimeEventRow,
	"payload" | "createdAt"
>;
export type TediArtifactRow = typeof tediArtifacts.$inferSelect;
export type TediArtifactInsert = typeof tediArtifacts.$inferInsert;
export class TediArtifactOwnershipConflictError extends Error {
	constructor(readonly artifactId: string) {
		super(`Artifact ${artifactId} is owned by another tedi`);
		this.name = "TediArtifactOwnershipConflictError";
	}
}
export type TediApprovalRequestRow = typeof tediApprovalRequests.$inferSelect;
export type KernelRuntimeRunRow = typeof kernelRuntimeRuns.$inferSelect;

export type TediObservabilityRuntimeRow = Pick<
	TediRuntimeEventRow,
	"id" | "kind" | "runId" | "traceId" | "payload" | "createdAt"
>;

export interface TediObservabilityAuditRow {
	id: string;
	action: string;
	resourceType: string;
	resourceId: string | null;
	timestamp: Date;
}

export async function listTediObservabilityRows(
	db: DbClient,
	input: {
		organizationId: string;
		tediId: string;
		from: string;
		to: string;
		limit: number;
	},
): Promise<{
	runtimeEvents: TediObservabilityRuntimeRow[];
	auditEvents: TediObservabilityAuditRow[];
	runtimeTruncated: boolean;
	auditTruncated: boolean;
}> {
	const rowLimit = input.limit + 1;
	const [runtimeRows, auditRows] = await Promise.all([
		db
			.select({
				id: tediRuntimeEvents.id,
				kind: tediRuntimeEvents.kind,
				runId: tediRuntimeEvents.runId,
				traceId: tediRuntimeEvents.traceId,
				payload: tediRuntimeEvents.payload,
				createdAt: tediRuntimeEvents.createdAt,
			})
			.from(tediRuntimeEvents)
			.where(
				and(
					eq(tediRuntimeEvents.organizationId, input.organizationId),
					eq(tediRuntimeEvents.tediId, input.tediId),
					gte(tediRuntimeEvents.createdAt, input.from),
					lte(tediRuntimeEvents.createdAt, input.to),
				),
			)
			.orderBy(desc(tediRuntimeEvents.createdAt))
			.limit(rowLimit),
		db
			.select({
				id: auditEvents.id,
				action: auditEvents.action,
				resourceType: auditEvents.resourceType,
				resourceId: auditEvents.resourceId,
				timestamp: auditEvents.timestamp,
			})
			.from(auditEvents)
			.innerJoin(
				tedis,
				and(
					eq(tedis.id, input.tediId),
					eq(tedis.organizationId, input.organizationId),
				),
			)
			.where(
				and(
					eq(auditEvents.organizationId, input.organizationId),
					eq(auditEvents.actorType, "tedi"),
					eq(auditEvents.actorId, input.tediId),
					gte(auditEvents.timestamp, new Date(input.from)),
					lte(auditEvents.timestamp, new Date(input.to)),
				),
			)
			.orderBy(desc(auditEvents.timestamp))
			.limit(rowLimit),
	]);
	return {
		runtimeEvents: runtimeRows.slice(0, input.limit),
		auditEvents: auditRows.slice(0, input.limit),
		runtimeTruncated: runtimeRows.length > input.limit,
		auditTruncated: auditRows.length > input.limit,
	};
}

export async function enqueueKernelChildWake(
	db: DbClient,
	input: typeof kernelWakeQueue.$inferInsert,
): Promise<void> {
	await db
		.insert(kernelWakeQueue)
		.values(input)
		.onConflictDoNothing({ target: kernelWakeQueue.id });
}

export async function getMappedDispatchRunId(
	db: DbClient,
	input: { tediId: string; idempotencyKey: string },
): Promise<string | null> {
	const [mapping] = await db
		.select({ runId: chatDispatchIdempotency.runId })
		.from(chatDispatchIdempotency)
		.where(
			and(
				eq(chatDispatchIdempotency.tediId, input.tediId),
				eq(chatDispatchIdempotency.idempotencyKey, input.idempotencyKey),
			),
		)
		.limit(1);
	return mapping?.runId ?? null;
}

export async function insertTediRuntimeEvent(
	db: DbClient,
	input: TediRuntimeEventInsert,
): Promise<TediRuntimeEventRow | null> {
	const metadataTraceId = input.runtimeMetadata?.traceId;
	const [row] = await db
		.insert(tediRuntimeEvents)
		.values({
			...input,
			traceId:
				input.traceId ??
				(typeof metadataTraceId === "string" ? metadataTraceId : undefined),
		})
		.onConflictDoNothing({ target: tediRuntimeEvents.id })
		.returning();
	return row ?? null;
}

export async function getTediRuntimeEventById(
	db: DbClient,
	id: string,
): Promise<TediRuntimeEventRow | null> {
	const [row] = await db
		.select()
		.from(tediRuntimeEvents)
		.where(eq(tediRuntimeEvents.id, id))
		.limit(1);
	return row ?? null;
}

export async function updateTediRuntimeEventPayload(
	db: DbClient,
	input: { id: string; payload: TediRuntimeEventInsert["payload"] },
): Promise<TediRuntimeEventRow | null> {
	const [row] = await db
		.update(tediRuntimeEvents)
		.set({ payload: input.payload })
		.where(eq(tediRuntimeEvents.id, input.id))
		.returning();
	return row ?? null;
}

export async function listTediRuntimeEventsForRouter(
	db: DbClient,
	input: {
		tediId: string;
		conversationId?: string;
		runId?: string;
		runIds?: string[];
		kind?: TediRuntimeEventKind;
		kinds?: TediRuntimeEventKind[];
		before?: TediRuntimeEventCursor;
		order?: "asc" | "desc";
		limit?: number;
	},
): Promise<TediRuntimeEventRow[]> {
	if (input.runIds?.length === 0 || input.kinds?.length === 0) return [];
	const conditions = [
		eq(tediRuntimeEvents.tediId, input.tediId),
		...(input.conversationId
			? [eq(tediRuntimeEvents.conversationId, input.conversationId)]
			: []),
		// bound-params: one runId plus its dispatch-alias mappings (sole caller
		// builds [input.runId, ...mappedRunIds] for a single run)
		...(input.runIds
			? [inArray(tediRuntimeEvents.runId, input.runIds)]
			: input.runId
				? [eq(tediRuntimeEvents.runId, input.runId)]
				: []),
		...(input.kind ? [eq(tediRuntimeEvents.kind, input.kind)] : []),
		// bound-params: kinds is a subset of the closed TediRuntimeEventKind enum
		...(input.kinds ? [inArray(tediRuntimeEvents.kind, input.kinds)] : []),
		...(input.before
			? [
					or(
						lt(tediRuntimeEvents.createdAt, input.before.createdAt),
						and(
							eq(tediRuntimeEvents.createdAt, input.before.createdAt),
							lt(tediRuntimeEvents.id, input.before.id),
						),
					)!,
				]
			: []),
	];
	const base = db
		.select()
		.from(tediRuntimeEvents)
		.where(and(...conditions));
	const ordered =
		input.order === "asc"
			? base.orderBy(
					asc(tediRuntimeEvents.createdAt),
					asc(tediRuntimeEvents.id),
				)
			: input.order === "desc"
				? base.orderBy(
						desc(tediRuntimeEvents.createdAt),
						desc(tediRuntimeEvents.id),
					)
				: base;
	return input.limit === undefined ? ordered : ordered.limit(input.limit);
}

export async function listTediRunConversationHints(
	db: DbClient,
	input: { tediId: string; runId: string; limit: number },
): Promise<Array<Pick<TediRuntimeEventRow, "conversationId" | "kind">>> {
	return db
		.select({
			conversationId: tediRuntimeEvents.conversationId,
			kind: tediRuntimeEvents.kind,
		})
		.from(tediRuntimeEvents)
		.where(
			and(
				eq(tediRuntimeEvents.tediId, input.tediId),
				eq(tediRuntimeEvents.runId, input.runId),
			),
		)
		.orderBy(desc(tediRuntimeEvents.createdAt))
		.limit(input.limit);
}

export async function listTediConversationIndexRows(
	db: DbClient,
	input: {
		organizationId: string;
		tediId: string;
		before?: string;
		limit: number;
	},
): Promise<TediRuntimeEventRow[]> {
	return db
		.select()
		.from(tediRuntimeEvents)
		.where(
			and(
				eq(tediRuntimeEvents.tediId, input.tediId),
				notExists(
					db
						.select({ one: sql`1` })
						.from(tediSessionStates)
						.where(
							and(
								eq(tediSessionStates.organizationId, input.organizationId),
								eq(tediSessionStates.tediId, input.tediId),
								eq(
									tediSessionStates.sessionKey,
									tediRuntimeEvents.conversationId,
								),
								isNotNull(tediSessionStates.deletedAt),
							),
						),
				),
				input.before
					? lt(tediRuntimeEvents.createdAt, input.before)
					: undefined,
			),
		)
		.orderBy(desc(tediRuntimeEvents.createdAt))
		.limit(input.limit);
}

export async function isTediConversationDeleted(
	db: DbClient,
	input: { organizationId: string; tediId: string; conversationId: string },
): Promise<boolean> {
	const rows = await db
		.select({ one: sql`1` })
		.from(tediSessionStates)
		.where(
			and(
				eq(tediSessionStates.organizationId, input.organizationId),
				eq(tediSessionStates.tediId, input.tediId),
				eq(tediSessionStates.sessionKey, input.conversationId),
				isNotNull(tediSessionStates.deletedAt),
			),
		)
		.limit(1);
	return rows.length > 0;
}

export async function listTediConversationTranscriptRows(
	db: DbClient,
	input: {
		tediId: string;
		conversationId: string;
		before?: string;
		limit: number;
	},
): Promise<TediRuntimeEventRow[]> {
	return db
		.select()
		.from(tediRuntimeEvents)
		.where(
			and(
				eq(tediRuntimeEvents.tediId, input.tediId),
				eq(tediRuntimeEvents.conversationId, input.conversationId),
				or(
					eq(tediRuntimeEvents.kind, "message.received"),
					eq(tediRuntimeEvents.kind, "message.delta"),
					eq(tediRuntimeEvents.kind, "message.completed"),
					eq(tediRuntimeEvents.kind, "run.completed"),
				),
				input.before
					? lt(tediRuntimeEvents.createdAt, input.before)
					: undefined,
			),
		)
		.orderBy(desc(tediRuntimeEvents.createdAt))
		.limit(input.limit);
}

export async function getLatestTediConversationCompactionEvent(
	db: DbClient,
	input: { tediId: string; conversationId: string },
): Promise<TediConversationCompactionEventRow | null> {
	const [row] = await db
		.select({
			payload: tediRuntimeEvents.payload,
			createdAt: tediRuntimeEvents.createdAt,
		})
		.from(tediRuntimeEvents)
		.where(
			and(
				eq(tediRuntimeEvents.tediId, input.tediId),
				eq(tediRuntimeEvents.conversationId, input.conversationId),
				eq(tediRuntimeEvents.kind, "context.compacted"),
			),
		)
		.orderBy(desc(tediRuntimeEvents.createdAt), desc(tediRuntimeEvents.id))
		.limit(1);
	return row ?? null;
}

export async function upsertChatDispatchIdempotency(
	db: DbClient,
	input: typeof chatDispatchIdempotency.$inferInsert,
): Promise<void> {
	await db
		.insert(chatDispatchIdempotency)
		.values(input)
		.onConflictDoNothing({ target: chatDispatchIdempotency.idempotencyKey });
}

export async function updateChatDispatchRunId(
	db: DbClient,
	input: { idempotencyKey: string; runId: string; mappedAt: string },
): Promise<void> {
	await db
		.update(chatDispatchIdempotency)
		.set({ runId: input.runId, mappedAt: input.mappedAt })
		.where(eq(chatDispatchIdempotency.idempotencyKey, input.idempotencyKey));
}

export async function listTediApprovalRequests(
	db: DbClient,
	input: {
		tediId: string;
		organizationId: string;
		status: TediApprovalRequestRow["status"];
		before?: string;
		limit: number;
	},
): Promise<TediApprovalRequestRow[]> {
	return db
		.select()
		.from(tediApprovalRequests)
		.where(
			and(
				eq(tediApprovalRequests.tediId, input.tediId),
				eq(tediApprovalRequests.orgId, input.organizationId),
				eq(tediApprovalRequests.status, input.status),
				input.before
					? lt(tediApprovalRequests.createdAt, input.before)
					: undefined,
			),
		)
		.orderBy(desc(tediApprovalRequests.createdAt))
		.limit(input.limit);
}

export async function findDirectKernelParentRun(
	db: DbClient,
	input: { organizationId: string; childRunId: string },
): Promise<KernelRuntimeRunRow | null> {
	const rows = await db
		.select()
		.from(kernelRuntimeRuns)
		.where(
			and(
				eq(kernelRuntimeRuns.organizationId, input.organizationId),
				eq(kernelRuntimeRuns.childRunId, input.childRunId),
			),
		)
		.limit(1);
	return rows.find((row) => row.childRunId === input.childRunId) ?? null;
}

export async function listRecentKernelRunsForOrganization(
	db: DbClient,
	input: { organizationId: string; limit: number },
): Promise<KernelRuntimeRunRow[]> {
	return db
		.select()
		.from(kernelRuntimeRuns)
		.where(eq(kernelRuntimeRuns.organizationId, input.organizationId))
		.orderBy(desc(kernelRuntimeRuns.updatedAt))
		.limit(input.limit);
}

export async function listTediArtifacts(
	db: DbClient,
	input: {
		tediId: string;
		conversationId?: string;
		runId?: string;
		messageId?: string;
		kind?: TediArtifactRow["kind"];
		name?: string;
		before?: string;
		limit: number;
	},
): Promise<TediArtifactRow[]> {
	const conditions = [
		eq(tediArtifacts.tediId, input.tediId),
		...(input.name ? [eq(tediArtifacts.name, input.name)] : []),
		...(input.conversationId
			? [eq(tediArtifacts.conversationId, input.conversationId)]
			: []),
		...(input.runId ? [eq(tediArtifacts.runId, input.runId)] : []),
		...(input.messageId ? [eq(tediArtifacts.messageId, input.messageId)] : []),
		...(input.kind ? [eq(tediArtifacts.kind, input.kind)] : []),
		...(input.before ? [lt(tediArtifacts.createdAt, input.before)] : []),
	];
	return db
		.select()
		.from(tediArtifacts)
		.where(and(...conditions))
		.orderBy(desc(tediArtifacts.createdAt))
		.limit(input.limit);
}

export async function upsertTediArtifact(
	db: DbClient,
	input: TediArtifactInsert,
): Promise<TediArtifactRow> {
	const [row] = await db
		.insert(tediArtifacts)
		.values(input)
		.onConflictDoUpdate({
			target: tediArtifacts.id,
			set: {
				conversationId: input.conversationId,
				runId: input.runId,
				messageId: input.messageId,
				kind: input.kind,
				name: input.name,
				mimeType: input.mimeType,
				uri: input.uri,
				sizeBytes: input.sizeBytes,
				metadata: input.metadata,
			},
			setWhere: and(
				eq(tediArtifacts.organizationId, input.organizationId),
				eq(tediArtifacts.tediId, input.tediId),
				isNull(tediArtifacts.accessClassification),
			),
		})
		.returning();
	if (!row) throw new TediArtifactOwnershipConflictError(input.id);
	return row;
}

/**
 * Create the immutable identity/content/provenance claim before publishing R2
 * bytes. Retries may read the identical claim, but can never rewrite or
 * downgrade it.
 */
export async function claimTediArtifact(
	db: DbClient,
	input: TediArtifactInsert,
): Promise<{ artifact: TediArtifactRow; created: boolean }> {
	const [created] = await db
		.insert(tediArtifacts)
		.values({
			...input,
			createdAt: input.createdAt ?? new Date().toISOString(),
		})
		.onConflictDoNothing({ target: tediArtifacts.id })
		.returning();
	if (created) return { artifact: created, created: true };
	const existing = await getTediArtifact(db, {
		organizationId: input.organizationId,
		artifactId: input.id,
	});
	if (
		!existing ||
		existing.tediId !== input.tediId ||
		existing.conversationId !== (input.conversationId ?? null) ||
		existing.runId !== (input.runId ?? null) ||
		existing.messageId !== (input.messageId ?? null) ||
		existing.kind !== input.kind ||
		existing.name !== input.name ||
		existing.mimeType !== (input.mimeType ?? null) ||
		existing.uri !== input.uri ||
		existing.sizeBytes !== (input.sizeBytes ?? null) ||
		JSON.stringify(existing.metadata ?? null) !==
			JSON.stringify(input.metadata ?? null) ||
		existing.contentDigest !== input.contentDigest ||
		existing.accessClassification !== input.accessClassification ||
		existing.producerExecutionId !== (input.producerExecutionId ?? null) ||
		existing.accessEnvelope !== (input.accessEnvelope ?? null) ||
		(input.createdAt !== undefined && existing.createdAt !== input.createdAt)
	) {
		throw new TediArtifactOwnershipConflictError(input.id);
	}
	return { artifact: existing, created: false };
}

/** Publish only the exact pending immutable claim after storage verification. */
export async function markTediArtifactPublished(
	db: DbClient,
	input: {
		id: string;
		organizationId: string;
		tediId: string;
		contentDigest: string | null;
	},
): Promise<TediArtifactRow | null> {
	const [published] = await db
		.update(tediArtifacts)
		.set({ publicationState: "ready" })
		.where(
			and(
				eq(tediArtifacts.id, input.id),
				eq(tediArtifacts.organizationId, input.organizationId),
				eq(tediArtifacts.tediId, input.tediId),
				input.contentDigest === null
					? isNull(tediArtifacts.contentDigest)
					: eq(tediArtifacts.contentDigest, input.contentDigest),
				eq(tediArtifacts.publicationState, "pending"),
			),
		)
		.returning();
	return published ?? null;
}

export async function getTediArtifact(
	db: DbClient,
	input:
		| { tediId: string; artifactId: string }
		| { organizationId: string; artifactId: string },
): Promise<TediArtifactRow | null> {
	const ownerCondition =
		"organizationId" in input
			? eq(tediArtifacts.organizationId, input.organizationId)
			: eq(tediArtifacts.tediId, input.tediId);
	const [row] = await db
		.select()
		.from(tediArtifacts)
		.where(and(ownerCondition, eq(tediArtifacts.id, input.artifactId)))
		.limit(1);
	return row ?? null;
}

/** Exact global-id lookup used only to fence create-only ownership claims. */
export async function getTediArtifactClaim(
	db: DbClient,
	artifactId: string,
): Promise<TediArtifactRow | null> {
	const [row] = await db
		.select()
		.from(tediArtifacts)
		.where(eq(tediArtifacts.id, artifactId))
		.limit(1);
	return row ?? null;
}

export async function patchOldestQueuedDispatchRunId(
	db: DbClient,
	input: {
		tediId: string;
		conversationId: string;
		runId: string;
		cutoff: string;
		mappedAt: string;
	},
): Promise<number> {
	const [candidate] = await db
		.select({ idempotencyKey: chatDispatchIdempotency.idempotencyKey })
		.from(chatDispatchIdempotency)
		.where(
			and(
				eq(chatDispatchIdempotency.tediId, input.tediId),
				eq(chatDispatchIdempotency.conversationId, input.conversationId),
				sql`${chatDispatchIdempotency.runId} IS NULL`,
				sql`datetime(${chatDispatchIdempotency.createdAt}) > datetime(${input.cutoff})`,
			),
		)
		.orderBy(chatDispatchIdempotency.createdAt)
		.limit(1);
	if (!candidate) return 0;
	await updateChatDispatchRunId(db, {
		idempotencyKey: candidate.idempotencyKey,
		runId: input.runId,
		mappedAt: input.mappedAt,
	});
	return 1;
}

export type OrphanRunCandidate = {
	tediId: string;
	organizationId: string;
	runId: string;
	conversationId: string | null;
	runtimeBackend: TediRuntimeEventRow["runtimeBackend"];
	runtimeExternalId: string | null;
	startedEventId: string;
	startedAt: string;
	/** A durable success signal exists but the terminal event was lost. */
	succeededLost: boolean;
};

// A workstation wake, clone, install, and full test can legitimately run for
// 8-12 minutes without a progress event. Keep the orphan age and activity
// window above that gap so the sweep does not seal live coding work.
const ORPHAN_DEFAULT_AGE_MINUTES = 12;
const ORPHAN_DEFAULT_ACTIVITY_WINDOW_MINUTES = 12;
const ORPHAN_DEFAULT_LIMIT = 100;
// The lower bound prevents every two-minute sweep from rescanning the complete
// runtime-event ledger. A swept run receives a terminal row and cannot become a
// candidate again, so seven days is safely wider than the recovery cadence.
const ORPHAN_DEFAULT_LOOKBACK_DAYS = 7;

export async function findOrphanRuns(
	db: DbClient,
	options: {
		now?: Date;
		organizationId?: string;
		orphanAgeMinutes?: number;
		activityWindowMinutes?: number;
		lookbackDays?: number;
		limit?: number;
	} = {},
): Promise<OrphanRunCandidate[]> {
	const now = options.now ?? new Date();
	const orphanAgeMinutes =
		options.orphanAgeMinutes ?? ORPHAN_DEFAULT_AGE_MINUTES;
	const activityWindowMinutes =
		options.activityWindowMinutes ?? ORPHAN_DEFAULT_ACTIVITY_WINDOW_MINUTES;
	const limit = options.limit ?? ORPHAN_DEFAULT_LIMIT;
	const lookbackDays = options.lookbackDays ?? ORPHAN_DEFAULT_LOOKBACK_DAYS;
	const organizationId = options.organizationId ?? null;
	// The fleet sweep intentionally stays unscoped. Org-scoped health reads add
	// an indexable outer predicate and fence every correlated alias to the same
	// organization so malformed cross-org rows cannot suppress a candidate.
	const outerOrganizationPredicate = organizationId
		? sql`AND tedi_runtime_events.organization_id = ${organizationId}`
		: sql``;
	const okOrganizationPredicate = organizationId
		? sql`AND ok.organization_id = tedi_runtime_events.organization_id`
		: sql``;
	const termOrganizationPredicate = organizationId
		? sql`AND term.organization_id = tedi_runtime_events.organization_id`
		: sql``;
	const activityOrganizationPredicate = organizationId
		? sql`AND act.organization_id = tedi_runtime_events.organization_id`
		: sql``;
	const approvalOrganizationPredicate = organizationId
		? sql`AND ar.organization_id = tedi_runtime_events.organization_id`
		: sql``;
	const approvalResolutionOrganizationPredicate = organizationId
		? sql`AND res.organization_id = tedi_runtime_events.organization_id`
		: sql``;
	const mappingOrganizationPredicate = organizationId
		? sql`AND map.organization_id = tedi_runtime_events.organization_id`
		: sql``;
	const mappedTerminalOrganizationPredicate = organizationId
		? sql`AND mapped_term.organization_id = tedi_runtime_events.organization_id`
		: sql``;
	const mappedActivityOrganizationPredicate = organizationId
		? sql`AND mapped_act.organization_id = tedi_runtime_events.organization_id`
		: sql``;
	const orphanCutoff = new Date(
		now.getTime() - orphanAgeMinutes * 60_000,
	).toISOString();
	const activityCutoff = new Date(
		now.getTime() - activityWindowMinutes * 60_000,
	).toISOString();
	const lookbackFloor = new Date(
		now.getTime() - lookbackDays * 24 * 60 * 60_000,
	).toISOString();

	const rows = await db.all<{
		id: string;
		tedi_id: string;
		organization_id: string;
		run_id: string;
		conversation_id: string | null;
		runtime_backend: string;
		runtime_external_id: string | null;
		created_at: string;
		succeeded_lost: number;
	}>(sql`
		SELECT id, tedi_id, organization_id, run_id, conversation_id,
			runtime_backend, runtime_external_id, created_at,
			EXISTS (
				SELECT 1 FROM tedi_runtime_events ok
				WHERE ok.tedi_id = tedi_runtime_events.tedi_id
					AND ok.run_id = tedi_runtime_events.run_id
					${okOrganizationPredicate}
					AND ok.kind = 'message.completed'
					AND COALESCE(LOWER(json_extract(ok.payload, '$.status')), '')
						NOT IN ('failed', 'error', 'canceled', 'cancelled')
					AND json_extract(ok.payload, '$.error') IS NULL
			) AS succeeded_lost
		FROM tedi_runtime_events
		WHERE kind = 'run.started'
			AND run_id IS NOT NULL
			${outerOrganizationPredicate}
			AND created_at < ${orphanCutoff}
			AND created_at > ${lookbackFloor}
			AND NOT EXISTS (
				SELECT 1 FROM tedi_runtime_events term
				WHERE term.tedi_id = tedi_runtime_events.tedi_id
					AND term.run_id = tedi_runtime_events.run_id
					${termOrganizationPredicate}
					AND term.kind IN ('run.completed', 'run.failed', 'run.canceled')
			)
			AND NOT EXISTS (
				SELECT 1 FROM tedi_runtime_events act
				WHERE act.tedi_id = tedi_runtime_events.tedi_id
					AND act.run_id = tedi_runtime_events.run_id
					${activityOrganizationPredicate}
					AND act.kind IN ('message.delta', 'tool.started', 'tool.completed', 'tool.failed', 'message.progress', 'step.completed', 'step.retry')
					AND act.created_at >= ${activityCutoff}
			)
			AND NOT EXISTS (
				SELECT 1 FROM tedi_runtime_events ar
				WHERE ar.tedi_id = tedi_runtime_events.tedi_id
					AND ar.run_id = tedi_runtime_events.run_id
					${approvalOrganizationPredicate}
					AND ar.kind = 'approval.requested'
					AND NOT EXISTS (
						SELECT 1 FROM tedi_runtime_events res
						WHERE res.tedi_id = ar.tedi_id
							AND res.run_id = ar.run_id
							${approvalResolutionOrganizationPredicate}
							AND res.kind = 'approval.resolved'
					)
			)
			AND NOT EXISTS (
				SELECT 1 FROM chat_dispatch_idempotency map
				WHERE map.tedi_id = tedi_runtime_events.tedi_id
					AND map.conversation_id = tedi_runtime_events.conversation_id
					AND map.idempotency_key = tedi_runtime_events.run_id
					${mappingOrganizationPredicate}
					AND map.run_id IS NOT NULL
					AND map.run_id != tedi_runtime_events.run_id
					AND (
						EXISTS (
							SELECT 1 FROM tedi_runtime_events mapped_term
							WHERE mapped_term.tedi_id = tedi_runtime_events.tedi_id
								AND mapped_term.run_id = map.run_id
								${mappedTerminalOrganizationPredicate}
								AND (
									mapped_term.kind IN ('run.completed', 'run.failed', 'run.canceled')
									OR (
										mapped_term.kind = 'message.completed'
										AND COALESCE(LOWER(json_extract(mapped_term.payload, '$.status')), '')
											NOT IN ('failed', 'error', 'canceled', 'cancelled')
										AND json_extract(mapped_term.payload, '$.error') IS NULL
									)
								)
						)
						OR EXISTS (
							SELECT 1 FROM tedi_runtime_events mapped_act
							WHERE mapped_act.tedi_id = tedi_runtime_events.tedi_id
								AND mapped_act.run_id = map.run_id
								${mappedActivityOrganizationPredicate}
								AND mapped_act.kind IN ('message.delta', 'tool.started', 'tool.completed', 'tool.failed', 'message.progress', 'step.completed', 'step.retry')
								AND mapped_act.created_at >= ${activityCutoff}
						)
					)
			)
		ORDER BY created_at ASC
		LIMIT ${limit}
	`);

	return rows.map((row) => ({
		tediId: row.tedi_id,
		organizationId: row.organization_id,
		runId: row.run_id,
		conversationId: row.conversation_id,
		runtimeBackend:
			(row.runtime_backend as TediRuntimeEventRow["runtimeBackend"]) ??
			"cloudflare-agents",
		runtimeExternalId: row.runtime_external_id,
		startedEventId: row.id,
		startedAt: row.created_at,
		succeededLost: row.succeeded_lost === 1,
	}));
}

export async function insertOrphanTerminalEvent(
	db: DbClient,
	input: TediRuntimeEventInsert,
): Promise<boolean> {
	return (await insertTediRuntimeEvent(db, input)) !== null;
}
