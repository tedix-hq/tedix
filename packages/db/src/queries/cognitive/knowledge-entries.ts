import { and, desc, eq, like, or } from "drizzle-orm";
import type { DbClient } from "../../client";
import {
	type KnowledgeEntry,
	type KnowledgeEntryType,
	knowledgeEntries,
	type NewKnowledgeEntry,
} from "../../schema/cognitive";

export type { KnowledgeEntryType };

export async function createKnowledgeEntry(
	db: DbClient,
	entry: NewKnowledgeEntry,
): Promise<KnowledgeEntry> {
	const id = entry.id ?? crypto.randomUUID();
	const [created] = await db
		.insert(knowledgeEntries)
		.values({ ...entry, id })
		.returning();
	if (!created) throw new Error(`Failed to create knowledge entry: ${id}`);
	return created;
}

export async function getKnowledgeEntry(
	db: DbClient,
	id: string,
	orgId?: string,
): Promise<KnowledgeEntry | undefined> {
	const conditions = [eq(knowledgeEntries.id, id)];
	if (orgId) {
		conditions.push(eq(knowledgeEntries.organizationId, orgId));
	}
	const rows = await db
		.select()
		.from(knowledgeEntries)
		.where(and(...conditions))
		.limit(1);
	return rows[0];
}

export async function listKnowledgeByDomain(
	db: DbClient,
	orgId: string,
	domainId: string,
	options?: { limit?: number; entryType?: KnowledgeEntryType },
): Promise<KnowledgeEntry[]> {
	const conditions = [
		eq(knowledgeEntries.organizationId, orgId),
		eq(knowledgeEntries.domainId, domainId),
	];
	if (options?.entryType) {
		conditions.push(eq(knowledgeEntries.entryType, options.entryType));
	}
	return db
		.select()
		.from(knowledgeEntries)
		.where(and(...conditions))
		.orderBy(
			desc(knowledgeEntries.confidence),
			desc(knowledgeEntries.createdAt),
		)
		.limit(options?.limit ?? 50);
}

export async function listKnowledgeByTedi(
	db: DbClient,
	orgId: string,
	tediId: string,
	options?: { limit?: number; domainId?: string },
): Promise<KnowledgeEntry[]> {
	const conditions = [
		eq(knowledgeEntries.organizationId, orgId),
		eq(knowledgeEntries.tediId, tediId),
	];
	if (options?.domainId) {
		conditions.push(eq(knowledgeEntries.domainId, options.domainId));
	}
	return db
		.select()
		.from(knowledgeEntries)
		.where(and(...conditions))
		.orderBy(
			desc(knowledgeEntries.confidence),
			desc(knowledgeEntries.createdAt),
		)
		.limit(options?.limit ?? 50);
}

export async function searchKnowledge(
	db: DbClient,
	orgId: string,
	query: string,
	options?: { tediId?: string; domainId?: string; limit?: number },
): Promise<KnowledgeEntry[]> {
	const searchTerm = `%${query}%`;
	const conditions = [
		eq(knowledgeEntries.organizationId, orgId),
		or(
			like(knowledgeEntries.title, searchTerm),
			like(knowledgeEntries.content, searchTerm),
		)!,
	];
	if (options?.tediId) {
		conditions.push(eq(knowledgeEntries.tediId, options.tediId));
	}
	if (options?.domainId) {
		conditions.push(eq(knowledgeEntries.domainId, options.domainId));
	}
	return db
		.select()
		.from(knowledgeEntries)
		.where(and(...conditions))
		.orderBy(
			desc(knowledgeEntries.confidence),
			desc(knowledgeEntries.createdAt),
		)
		.limit(options?.limit ?? 20);
}
