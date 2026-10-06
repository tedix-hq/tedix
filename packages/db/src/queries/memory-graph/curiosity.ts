import { and, desc, eq } from "drizzle-orm";
import type { DbClient } from "../../client";
import {
	type CuriositySource,
	type CuriosityStatus,
	type NewTediCuriosityItem,
	type TediCuriosityItem,
	tediCuriosityQueue,
} from "../../schema/memory-graph";

export type { CuriositySource, CuriosityStatus };

export async function createCuriosityItem(
	db: DbClient,
	item: NewTediCuriosityItem,
): Promise<TediCuriosityItem> {
	const id = item.id ?? crypto.randomUUID();
	const [created] = await db
		.insert(tediCuriosityQueue)
		.values({ ...item, id })
		.returning();
	if (!created) throw new Error(`Failed to create curiosity item: ${id}`);
	return created;
}

export async function listCuriosityQueue(
	db: DbClient,
	orgId: string,
	options?: { tediId?: string; status?: CuriosityStatus; limit?: number },
): Promise<TediCuriosityItem[]> {
	const conditions = [eq(tediCuriosityQueue.organizationId, orgId)];

	if (options?.tediId) {
		conditions.push(eq(tediCuriosityQueue.tediId, options.tediId));
	}
	if (options?.status) {
		conditions.push(eq(tediCuriosityQueue.status, options.status));
	}

	return db
		.select()
		.from(tediCuriosityQueue)
		.where(and(...conditions))
		.orderBy(
			desc(tediCuriosityQueue.priority),
			desc(tediCuriosityQueue.createdAt),
		)
		.limit(options?.limit ?? 50);
}

export async function updateCuriosityStatus(
	db: DbClient,
	id: string,
	status: CuriosityStatus,
	results?: { factsLearned?: number; gapsFound?: number },
): Promise<void> {
	const now = new Date().toISOString();
	await db
		.update(tediCuriosityQueue)
		.set({
			status,
			...(results?.factsLearned !== undefined
				? { factsLearned: results.factsLearned }
				: {}),
			...(results?.gapsFound !== undefined
				? { gapsFound: results.gapsFound }
				: {}),
			...(status === "completed" ? { completedAt: now } : {}),
			updatedAt: now,
		})
		.where(eq(tediCuriosityQueue.id, id));
}

export async function getNextCuriosityItem(
	db: DbClient,
	orgId: string,
	tediId?: string,
): Promise<TediCuriosityItem | undefined> {
	const conditions = [
		eq(tediCuriosityQueue.organizationId, orgId),
		eq(tediCuriosityQueue.status, "queued"),
	];
	if (tediId) {
		conditions.push(eq(tediCuriosityQueue.tediId, tediId));
	}

	const [result] = await db
		.select()
		.from(tediCuriosityQueue)
		.where(and(...conditions))
		.orderBy(
			desc(tediCuriosityQueue.priority),
			desc(tediCuriosityQueue.createdAt),
		)
		.limit(1);
	return result;
}

// ============================================================================
// Extended Health
// ============================================================================
