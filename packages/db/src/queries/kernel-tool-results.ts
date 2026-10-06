import { and, asc, eq, isNull, lte, sql } from "drizzle-orm";
import type { DbQueryClient } from "../query-client";
import {
	kernelConversations,
	kernelToolResults,
	type KernelToolResult,
	type NewKernelToolResult,
} from "../schema/cognitive-runtime";

export const KERNEL_TOOL_RESULT_MAX_COUNT = 20;
export const KERNEL_TOOL_RESULT_MAX_CONVERSATION_BYTES = 2 * 1024 * 1024;
export const KERNEL_TOOL_RESULT_MAX_BYTES = 1024 * 1024;

export type EvictedKernelToolResult = Pick<
	KernelToolResult,
	"id" | "objectKey" | "sha256" | "evictedAt"
>;

function retentionVictims(input: {
	organizationId: string;
	conversationId: string;
	now: string;
}) {
	return sql`WITH ranked AS (
		SELECT id,
			ROW_NUMBER() OVER (ORDER BY created_at DESC, id DESC) AS keep_rank,
			SUM(byte_size) OVER (
				ORDER BY created_at DESC, id DESC
				ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
			) AS running_bytes
		FROM kernel_tool_results
		WHERE organization_id = ${input.organizationId}
			AND conversation_id = ${input.conversationId}
			AND evicted_at IS NULL
			AND expires_at > ${input.now}
	), victims AS (
		SELECT id FROM kernel_tool_results
		WHERE organization_id = ${input.organizationId}
			AND conversation_id = ${input.conversationId}
			AND evicted_at IS NULL
			AND expires_at <= ${input.now}
		UNION
		SELECT id FROM ranked
		WHERE keep_rank > ${KERNEL_TOOL_RESULT_MAX_COUNT}
			OR running_bytes > ${KERNEL_TOOL_RESULT_MAX_CONVERSATION_BYTES}
	)
	SELECT id FROM victims`;
}

/** One D1 transaction: the insert must succeed before retention can commit. */
export async function insertKernelToolResultWithRetention(
	db: DbQueryClient,
	input: NewKernelToolResult & { now: string },
): Promise<{
	result: KernelToolResult;
	evicted: EvictedKernelToolResult[];
}> {
	const { now, ...row } = input;
	const insert = db
		.insert(kernelToolResults)
		.select(
			db
				.select({
					id: sql<string>`${row.id}`.as("id"),
					organizationId: sql<string>`${row.organizationId}`.as(
						"organization_id",
					),
					conversationId: sql<string>`${row.conversationId}`.as(
						"conversation_id",
					),
					runId: sql<string | null>`${row.runId ?? null}`.as("run_id"),
					sourceKind: sql<typeof row.sourceKind>`${row.sourceKind}`.as(
						"source_kind",
					),
					sourceId: sql<string>`${row.sourceId}`.as("source_id"),
					objectKey: sql<string>`${row.objectKey}`.as("object_key"),
					sha256: sql<string>`${row.sha256}`.as("sha256"),
					byteSize: sql<number>`${row.byteSize}`.as("byte_size"),
					contentType: sql<string>`${row.contentType ?? "application/json"}`.as(
						"content_type",
					),
					createdAt: sql<string>`${row.createdAt}`.as("created_at"),
					expiresAt: sql<string>`${row.expiresAt}`.as("expires_at"),
					evictedAt: sql<null>`NULL`.as("evicted_at"),
					evictionReason: sql<null>`NULL`.as("eviction_reason"),
				})
				.from(kernelConversations)
				.where(
					and(
						eq(kernelConversations.organizationId, row.organizationId),
						eq(kernelConversations.conversationId, row.conversationId),
						isNull(kernelConversations.deletedAt),
					),
				)
				.limit(1),
		)
		.returning();
	const evict = db
		.update(kernelToolResults)
		.set({
			evictedAt: now,
			evictionReason: sql`CASE WHEN ${kernelToolResults.expiresAt} <= ${now} THEN 'expired' ELSE 'count' END`,
		})
		.where(
			and(
				eq(kernelToolResults.organizationId, input.organizationId),
				eq(kernelToolResults.conversationId, input.conversationId),
				isNull(kernelToolResults.evictedAt),
				sql`${kernelToolResults.id} IN (${retentionVictims(input)})`,
			),
		)
		.returning({
			id: kernelToolResults.id,
			objectKey: kernelToolResults.objectKey,
			sha256: kernelToolResults.sha256,
			evictedAt: kernelToolResults.evictedAt,
		});
	const [inserted, evicted] = await db.batch([insert, evict]);
	if (!inserted[0])
		throw new Error("Kernel tool result conversation is unavailable");
	return {
		result: inserted[0],
		evicted: evicted.filter(
			(row): row is EvictedKernelToolResult => row.evictedAt !== null,
		),
	};
}

export async function getKernelToolResultById(
	db: DbQueryClient,
	input: { organizationId: string; conversationId: string; id: string },
): Promise<KernelToolResult | null> {
	const [row] = await db
		.select()
		.from(kernelToolResults)
		.where(
			and(
				eq(kernelToolResults.id, input.id),
				eq(kernelToolResults.organizationId, input.organizationId),
				eq(kernelToolResults.conversationId, input.conversationId),
			),
		)
		.limit(1);
	return row ?? null;
}

export async function getReadableKernelToolResultBySource(
	db: DbQueryClient,
	input: {
		organizationId: string;
		conversationId: string;
		sourceKind: "direct_read" | "approved_write";
		sourceId: string;
		now: string;
	},
): Promise<KernelToolResult | null> {
	const [row] = await db
		.select()
		.from(kernelToolResults)
		.where(
			and(
				eq(kernelToolResults.organizationId, input.organizationId),
				eq(kernelToolResults.conversationId, input.conversationId),
				eq(kernelToolResults.sourceKind, input.sourceKind),
				eq(kernelToolResults.sourceId, input.sourceId),
				isNull(kernelToolResults.evictedAt),
				sql`${kernelToolResults.expiresAt} > ${input.now}`,
			),
		)
		.limit(1);
	return row ?? null;
}

export async function getReadableKernelToolResult(
	db: DbQueryClient,
	input: {
		organizationId: string;
		conversationId: string;
		id: string;
		sha256: string;
		now: string;
	},
): Promise<KernelToolResult | null> {
	const [row] = await db
		.select()
		.from(kernelToolResults)
		.where(
			and(
				eq(kernelToolResults.id, input.id),
				eq(kernelToolResults.organizationId, input.organizationId),
				eq(kernelToolResults.conversationId, input.conversationId),
				eq(kernelToolResults.sha256, input.sha256),
				isNull(kernelToolResults.evictedAt),
				sql`${kernelToolResults.expiresAt} > ${input.now}`,
			),
		)
		.limit(1);
	return row ?? null;
}

export function buildEvictConversationToolResultsStatement(
	db: DbQueryClient,
	input: { organizationId: string; conversationId: string; evictedAt: string },
) {
	return db
		.update(kernelToolResults)
		.set({ evictedAt: input.evictedAt, evictionReason: "conversation_deleted" })
		.where(
			and(
				eq(kernelToolResults.organizationId, input.organizationId),
				eq(kernelToolResults.conversationId, input.conversationId),
				isNull(kernelToolResults.evictedAt),
			),
		)
		.returning({
			id: kernelToolResults.id,
			objectKey: kernelToolResults.objectKey,
			sha256: kernelToolResults.sha256,
			evictedAt: kernelToolResults.evictedAt,
		});
}

export async function listKernelToolResultsForCleanup(
	db: DbQueryClient,
	input: { now: string; limit: number },
): Promise<EvictedKernelToolResult[]> {
	const expire = db
		.update(kernelToolResults)
		.set({ evictedAt: input.now, evictionReason: "expired" })
		.where(
			and(
				isNull(kernelToolResults.evictedAt),
				lte(kernelToolResults.expiresAt, input.now),
				sql`${kernelToolResults.id} IN (SELECT id FROM kernel_tool_results WHERE evicted_at IS NULL AND expires_at <= ${input.now} ORDER BY expires_at, id LIMIT ${input.limit})`,
			),
		)
		.returning({
			id: kernelToolResults.id,
			objectKey: kernelToolResults.objectKey,
			sha256: kernelToolResults.sha256,
			evictedAt: kernelToolResults.evictedAt,
		});
	await db.batch([expire]);
	return db
		.select({
			id: kernelToolResults.id,
			objectKey: kernelToolResults.objectKey,
			sha256: kernelToolResults.sha256,
			evictedAt: kernelToolResults.evictedAt,
		})
		.from(kernelToolResults)
		.where(sql`${kernelToolResults.evictedAt} IS NOT NULL`)
		.orderBy(asc(kernelToolResults.evictedAt), asc(kernelToolResults.id))
		.limit(input.limit) as Promise<EvictedKernelToolResult[]>;
}

export async function deleteEvictedKernelToolResult(
	db: DbQueryClient,
	input: { id: string; objectKey: string; evictedAt: string },
): Promise<boolean> {
	const rows = await db
		.delete(kernelToolResults)
		.where(
			and(
				eq(kernelToolResults.id, input.id),
				eq(kernelToolResults.objectKey, input.objectKey),
				eq(kernelToolResults.evictedAt, input.evictedAt),
			),
		)
		.returning({ id: kernelToolResults.id });
	return rows.length === 1;
}
