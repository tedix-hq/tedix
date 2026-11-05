import { and, asc, eq, isNull, lte, sql } from "drizzle-orm";
import {
	kernelConversations,
	kernelToolResults,
	type KernelToolResult,
	type NewKernelToolResult,
} from "../../schema/cognitive-runtime";
import {
	KERNEL_TOOL_RESULT_MAX_CONVERSATION_BYTES,
	KERNEL_TOOL_RESULT_MAX_COUNT,
	type EvictedKernelToolResult,
} from "../kernel-tool-results";
import type { TenantStoreDb } from "./tenant-store";

export async function insertKernelToolResultWithRetention(
	db: TenantStoreDb,
	input: NewKernelToolResult & { now: string },
): Promise<{
	result: KernelToolResult;
	evicted: EvictedKernelToolResult[];
}> {
	return db.transaction((tx) => {
		const [conversation] = tx
			.select({ id: kernelConversations.id })
			.from(kernelConversations)
			.where(
				and(
					eq(kernelConversations.organizationId, input.organizationId),
					eq(kernelConversations.conversationId, input.conversationId),
					isNull(kernelConversations.deletedAt),
				),
			)
			.limit(1)
			.all();
		if (!conversation)
			throw new Error("Kernel tool result conversation is unavailable");
		const { now, ...value } = input;
		const [result] = tx
			.insert(kernelToolResults)
			.values(value)
			.returning()
			.all();
		if (!result) throw new Error("Kernel tool result insert returned no row");
		const active = tx
			.select()
			.from(kernelToolResults)
			.where(
				and(
					eq(kernelToolResults.organizationId, input.organizationId),
					eq(kernelToolResults.conversationId, input.conversationId),
					isNull(kernelToolResults.evictedAt),
				),
			)
			.orderBy(
				sql`${kernelToolResults.createdAt} DESC`,
				sql`${kernelToolResults.id} DESC`,
			)
			.all();
		let bytes = 0;
		let count = 0;
		const victims = active.filter((row) => {
			if (row.expiresAt <= now) return true;
			count++;
			bytes += row.byteSize;
			return (
				count > KERNEL_TOOL_RESULT_MAX_COUNT ||
				bytes > KERNEL_TOOL_RESULT_MAX_CONVERSATION_BYTES
			);
		});
		const evicted: EvictedKernelToolResult[] = [];
		for (const victim of victims) {
			const [row] = tx
				.update(kernelToolResults)
				.set({
					evictedAt: now,
					evictionReason: victim.expiresAt <= now ? "expired" : "count",
				})
				.where(eq(kernelToolResults.id, victim.id))
				.returning({
					id: kernelToolResults.id,
					objectKey: kernelToolResults.objectKey,
					sha256: kernelToolResults.sha256,
					evictedAt: kernelToolResults.evictedAt,
				})
				.all();
			if (row?.evictedAt) evicted.push(row as EvictedKernelToolResult);
		}
		return { result, evicted };
	});
}

export async function getReadableKernelToolResultBySource(
	db: TenantStoreDb,
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

export async function getKernelToolResultById(
	db: TenantStoreDb,
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

export async function getReadableKernelToolResult(
	db: TenantStoreDb,
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

export async function evictConversationToolResults(
	db: TenantStoreDb,
	input: { organizationId: string; conversationId: string; evictedAt: string },
): Promise<EvictedKernelToolResult[]> {
	const rows = await db
		.update(kernelToolResults)
		.set({
			evictedAt: input.evictedAt,
			evictionReason: "conversation_deleted",
		})
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
	return rows.filter(
		(row): row is EvictedKernelToolResult => row.evictedAt !== null,
	);
}

export async function listKernelToolResultsForCleanup(
	db: TenantStoreDb,
	input: { now: string; limit: number },
): Promise<EvictedKernelToolResult[]> {
	return db.transaction((tx) => {
		const expired = tx
			.select({ id: kernelToolResults.id })
			.from(kernelToolResults)
			.where(
				and(
					isNull(kernelToolResults.evictedAt),
					lte(kernelToolResults.expiresAt, input.now),
				),
			)
			.orderBy(asc(kernelToolResults.expiresAt), asc(kernelToolResults.id))
			.limit(input.limit)
			.all();
		for (const row of expired)
			tx.update(kernelToolResults)
				.set({ evictedAt: input.now, evictionReason: "expired" })
				.where(eq(kernelToolResults.id, row.id))
				.run();
		return tx
			.select({
				id: kernelToolResults.id,
				objectKey: kernelToolResults.objectKey,
				sha256: kernelToolResults.sha256,
				evictedAt: kernelToolResults.evictedAt,
			})
			.from(kernelToolResults)
			.where(sql`${kernelToolResults.evictedAt} IS NOT NULL`)
			.orderBy(asc(kernelToolResults.evictedAt), asc(kernelToolResults.id))
			.limit(input.limit)
			.all()
			.filter((row): row is EvictedKernelToolResult => row.evictedAt !== null);
	});
}

export async function deleteEvictedKernelToolResult(
	db: TenantStoreDb,
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
