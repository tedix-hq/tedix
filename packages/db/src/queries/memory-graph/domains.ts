/**
 * Memory Graph Query Helpers
 * CRUD operations for the knowledge graph — facts, edges, and domains.
 */

import { eq } from "drizzle-orm";
import type { DbClient } from "../../client";
import {
	type MemoryDomain,
	memoryDomains,
	type NewMemoryDomain,
} from "../../schema/memory-graph";

export async function getDomainByName(
	db: DbClient,
	orgId: string,
	name: string,
): Promise<MemoryDomain | undefined> {
	return db.query.memoryDomains.findFirst({
		where: { organizationId: orgId, name },
	});
}

export async function getOrCreateDomain(
	db: DbClient,
	orgId: string,
	name: string,
	description?: string,
): Promise<MemoryDomain> {
	const existing = await getDomainByName(db, orgId, name);
	if (existing) return existing;
	return createDomain(db, {
		id: crypto.randomUUID(),
		organizationId: orgId,
		name,
		description: description ?? null,
	});
}

export async function listDomains(
	db: DbClient,
	orgId: string,
): Promise<MemoryDomain[]> {
	return db
		.select()
		.from(memoryDomains)
		.where(eq(memoryDomains.organizationId, orgId));
}

async function createDomain(
	db: DbClient,
	domain: NewMemoryDomain,
): Promise<MemoryDomain> {
	const [created] = await db.insert(memoryDomains).values(domain).returning();
	if (!created) throw new Error(`Failed to create domain: ${domain.id}`);
	return created;
}
