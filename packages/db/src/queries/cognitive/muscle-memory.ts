import { and, desc, eq, gte, isNotNull, or, sql } from "drizzle-orm";
import type { DbClient } from "../../client";
import {
	type MuscleMemoryKind,
	type MuscleMemoryOrigin,
	type NewTediMuscleMemoryItem,
	type TediMuscleMemoryItem,
	tediMuscleMemory,
} from "../../schema/cognitive";
import { SKILL_PROVEN_MIN_SUCCESSES } from "../skill-lifecycle";

export type { MuscleMemoryKind, MuscleMemoryOrigin };

export async function createMuscleMemory(
	db: DbClient,
	entry: NewTediMuscleMemoryItem,
): Promise<TediMuscleMemoryItem> {
	const id = entry.id ?? crypto.randomUUID();
	const [created] = await db
		.insert(tediMuscleMemory)
		.values({ ...entry, id })
		.returning();
	if (!created) throw new Error(`Failed to create muscle memory: ${id}`);
	return created;
}

export async function listMuscleMemory(
	db: DbClient,
	orgId: string,
	tediId: string,
	options?: {
		includeUnproven?: boolean;
		kind?: MuscleMemoryKind;
		limit?: number;
	},
): Promise<TediMuscleMemoryItem[]> {
	const conditions = [
		eq(tediMuscleMemory.organizationId, orgId),
		eq(tediMuscleMemory.tediId, tediId),
	];
	if (options?.kind) {
		conditions.push(eq(tediMuscleMemory.kind, options.kind));
	}
	if (!options?.includeUnproven) {
		conditions.push(
			or(
				isNotNull(tediMuscleMemory.sourceSkillId),
				and(
					gte(tediMuscleMemory.successCount, SKILL_PROVEN_MIN_SUCCESSES),
					eq(tediMuscleMemory.failureCount, 0),
				),
			)!,
		);
	}
	const requestedLimit = options?.limit ?? 50;
	const queryLimit = options?.includeUnproven
		? requestedLimit
		: Math.min(Math.max(requestedLimit * 3, requestedLimit), 200);
	const rows = await db
		.select()
		.from(tediMuscleMemory)
		.where(and(...conditions))
		.orderBy(
			desc(tediMuscleMemory.usageCount),
			desc(tediMuscleMemory.createdAt),
		)
		.limit(queryLimit);
	if (options?.includeUnproven) return rows;

	// Legacy ingestion could create the same named procedure more than once.
	// Keep the most-used/newest row from the ordering above in runtime recall,
	// while includeUnproven remains an exact administrative inventory.
	const seenNames = new Set<string>();
	return rows
		.filter((entry) => {
			if (seenNames.has(entry.name)) return false;
			seenNames.add(entry.name);
			return true;
		})
		.slice(0, requestedLimit);
}

/** Org-scoped single-entry read; returns undefined for foreign-org ids. */
export async function getMuscleMemoryById(
	db: DbClient,
	id: string,
	orgId: string,
): Promise<TediMuscleMemoryItem | undefined> {
	const rows = await db
		.select()
		.from(tediMuscleMemory)
		.where(
			and(
				eq(tediMuscleMemory.id, id),
				eq(tediMuscleMemory.organizationId, orgId),
			),
		)
		.limit(1);
	return rows[0];
}

/**
 * Increment a muscle entry's usage counters. The WHERE is org-scoped so a
 * foreign-org id is a guaranteed no-op (returns undefined, writes nothing) —
 * handler-layer scoping is the first gate, this is the backstop.
 */
export async function recordMuscleUsage(
	db: DbClient,
	id: string,
	success: boolean,
	organizationId: string,
): Promise<TediMuscleMemoryItem | undefined> {
	const now = new Date().toISOString();
	const [updated] = await db
		.update(tediMuscleMemory)
		.set({
			usageCount: sql`${tediMuscleMemory.usageCount} + 1`,
			successCount: success
				? sql`${tediMuscleMemory.successCount} + 1`
				: tediMuscleMemory.successCount,
			failureCount: success
				? tediMuscleMemory.failureCount
				: sql`${tediMuscleMemory.failureCount} + 1`,
			lastUsedAt: now,
			updatedAt: now,
		})
		.where(
			and(
				eq(tediMuscleMemory.id, id),
				eq(tediMuscleMemory.organizationId, organizationId),
			),
		)
		.returning();
	return updated;
}

export async function upsertMuscleMemory(
	db: DbClient,
	item: NewTediMuscleMemoryItem,
): Promise<TediMuscleMemoryItem> {
	// NOTE: D1's HTTP API rejects interactive transactions. Read-then-write
	// without wrapping. The (tedi_id, name) lookup before insert/update is a
	// best-effort race guard.
	const existing = await db.query.tediMuscleMemory.findFirst({
		where: { tediId: item.tediId, name: item.name },
	});

	if (existing) {
		const { id: _id, ...updates } = item;
		const [updated] = await db
			.update(tediMuscleMemory)
			.set({
				...updates,
				version: existing.version + 1,
				updatedAt: new Date().toISOString(),
			})
			.where(eq(tediMuscleMemory.id, existing.id))
			.returning();
		return updated!;
	}

	const id = item.id ?? crypto.randomUUID();
	const [created] = await db
		.insert(tediMuscleMemory)
		.values({ ...item, id })
		.returning();
	return created!;
}
