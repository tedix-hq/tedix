import {
	and,
	asc,
	eq,
	gt,
	inArray,
	isNull,
	lte,
	or,
	sql,
	type SQL,
} from "drizzle-orm";
import type { DbQueryClient } from "../query-client";
import { coreTable } from "../core-store/client";
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

function retentionVictims(
	db: DbQueryClient,
	input: {
		organizationId: string;
		conversationId: string;
		now: string;
	},
): SQL {
	const table = coreTable(db, kernelToolResults);
	const conversation = and(
		eq(table.organizationId, input.organizationId),
		eq(table.conversationId, input.conversationId),
		isNull(table.evictedAt),
	);
	const ranked = db
		.select({
			id: table.id,
			keepRank:
				sql<number>`ROW_NUMBER() OVER (ORDER BY ${table.createdAt} DESC, ${table.id} DESC)`.as(
					"keep_rank",
				),
			runningBytes: sql<number>`SUM(${table.byteSize}) OVER (
				ORDER BY ${table.createdAt} DESC, ${table.id} DESC
				ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
			)`.as("running_bytes"),
		})
		.from(table)
		.where(and(conversation, gt(table.expiresAt, input.now)))
		.as("ranked");
	return or(
		inArray(
			table.id,
			db
				.select({ id: table.id })
				.from(table)
				.where(and(conversation, lte(table.expiresAt, input.now))),
		),
		inArray(
			table.id,
			db
				.select({ id: ranked.id })
				.from(ranked)
				.where(
					or(
						gt(ranked.keepRank, KERNEL_TOOL_RESULT_MAX_COUNT),
						gt(ranked.runningBytes, KERNEL_TOOL_RESULT_MAX_CONVERSATION_BYTES),
					),
				),
		),
	) as SQL;
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
	const table = coreTable(db, kernelToolResults);
	const conversations = coreTable(db, kernelConversations);
	const insert = db
		.insert(table)
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
				.from(conversations)
				.where(
					and(
						eq(conversations.organizationId, row.organizationId),
						eq(conversations.conversationId, row.conversationId),
						isNull(conversations.deletedAt),
					),
				)
				.limit(1),
		)
		.returning();
	const evict = db
		.update(table)
		.set({
			evictedAt: now,
			evictionReason: sql`CASE WHEN ${table.expiresAt} <= ${now} THEN 'expired' ELSE 'count' END`,
		})
		.where(
			and(
				eq(table.organizationId, input.organizationId),
				eq(table.conversationId, input.conversationId),
				isNull(table.evictedAt),
				retentionVictims(db, input),
			),
		)
		.returning({
			id: table.id,
			objectKey: table.objectKey,
			sha256: table.sha256,
			evictedAt: table.evictedAt,
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
	const table = coreTable(db, kernelToolResults);
	const [row] = await db
		.select()
		.from(table)
		.where(
			and(
				eq(table.id, input.id),
				eq(table.organizationId, input.organizationId),
				eq(table.conversationId, input.conversationId),
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
	const table = coreTable(db, kernelToolResults);
	const [row] = await db
		.select()
		.from(table)
		.where(
			and(
				eq(table.organizationId, input.organizationId),
				eq(table.conversationId, input.conversationId),
				eq(table.sourceKind, input.sourceKind),
				eq(table.sourceId, input.sourceId),
				isNull(table.evictedAt),
				sql`${table.expiresAt} > ${input.now}`,
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
	const table = coreTable(db, kernelToolResults);
	const [row] = await db
		.select()
		.from(table)
		.where(
			and(
				eq(table.id, input.id),
				eq(table.organizationId, input.organizationId),
				eq(table.conversationId, input.conversationId),
				eq(table.sha256, input.sha256),
				isNull(table.evictedAt),
				sql`${table.expiresAt} > ${input.now}`,
			),
		)
		.limit(1);
	return row ?? null;
}

export function buildEvictConversationToolResultsStatement(
	db: DbQueryClient,
	input: {
		organizationId: string;
		conversationId: string | string[];
		evictedAt: string;
	},
) {
	const table = coreTable(db, kernelToolResults);
	return db
		.update(table)
		.set({ evictedAt: input.evictedAt, evictionReason: "conversation_deleted" })
		.where(
			and(
				eq(table.organizationId, input.organizationId),
				typeof input.conversationId === "string"
					? eq(table.conversationId, input.conversationId)
					: // bound-params: callers pass at most KERNEL_CONVERSATION_PURGE_CHUNK ids
						inArray(table.conversationId, input.conversationId),
				isNull(table.evictedAt),
			),
		)
		.returning({
			id: table.id,
			objectKey: table.objectKey,
			sha256: table.sha256,
			evictedAt: table.evictedAt,
		});
}

export async function listKernelToolResultsForCleanup(
	db: DbQueryClient,
	input: { now: string; limit: number },
): Promise<EvictedKernelToolResult[]> {
	const table = coreTable(db, kernelToolResults);
	const expire = db
		.update(table)
		.set({ evictedAt: input.now, evictionReason: "expired" })
		.where(
			and(
				isNull(table.evictedAt),
				lte(table.expiresAt, input.now),
				sql`${table.id} IN (SELECT id FROM kernel_tool_results WHERE evicted_at IS NULL AND expires_at <= ${input.now} ORDER BY expires_at, id LIMIT ${input.limit})`,
			),
		)
		.returning({
			id: table.id,
			objectKey: table.objectKey,
			sha256: table.sha256,
			evictedAt: table.evictedAt,
		});
	await db.batch([expire]);
	return db
		.select({
			id: table.id,
			objectKey: table.objectKey,
			sha256: table.sha256,
			evictedAt: table.evictedAt,
		})
		.from(table)
		.where(sql`${table.evictedAt} IS NOT NULL`)
		.orderBy(asc(table.evictedAt), asc(table.id))
		.limit(input.limit) as Promise<EvictedKernelToolResult[]>;
}

export async function deleteEvictedKernelToolResult(
	db: DbQueryClient,
	input: { id: string; objectKey: string; evictedAt: string },
): Promise<boolean> {
	const table = coreTable(db, kernelToolResults);
	const rows = await db
		.delete(table)
		.where(
			and(
				eq(table.id, input.id),
				eq(table.objectKey, input.objectKey),
				eq(table.evictedAt, input.evictedAt),
			),
		)
		.returning({ id: table.id });
	return rows.length === 1;
}
