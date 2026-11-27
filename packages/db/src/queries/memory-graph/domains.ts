/**
 * Memory Graph Query Helpers
 * CRUD operations for the knowledge graph — facts, edges, and domains.
 */

import { coreTable } from "../../core-store/client";
import { type TenantScope, normalizeTenantScope } from "../../tenant-scope";

import { eq } from "drizzle-orm";
import type { DbClient } from "../../client";
import {
	type MemoryDomain,
	memoryDomains as d1MemoryDomains,
	type NewMemoryDomain,
} from "../../schema/memory-graph";

export async function getDomainByName(
	db: DbClient,
	tenantScope: TenantScope,
	name: string,
): Promise<MemoryDomain | undefined> {
	const { organizationId: orgId } = normalizeTenantScope(tenantScope);
	return db.query.memoryDomains.findFirst({
		where: { organizationId: orgId, name },
	});
}

export async function getOrCreateDomain(
	db: DbClient,
	tenantScope: TenantScope,
	name: string,
	description?: string,
): Promise<MemoryDomain> {
	const { organizationId: orgId } = normalizeTenantScope(tenantScope);
	const existing = await getDomainByName(db, tenantScope, name);
	if (existing) return existing;
	return createDomain(db, {
		workspaceId: tenantScope.workspaceId,
		id: crypto.randomUUID(),
		organizationId: orgId,
		name,
		description: description ?? null,
	});
}

export async function listDomains(
	db: DbClient,
	tenantScope: TenantScope,
): Promise<MemoryDomain[]> {
	const memoryDomains = coreTable(db, d1MemoryDomains);
	const { organizationId: orgId } = normalizeTenantScope(tenantScope);
	return db
		.select()
		.from(memoryDomains)
		.where(eq(memoryDomains.organizationId, orgId));
}

async function createDomain(
	db: DbClient,
	domain: NewMemoryDomain & TenantScope,
): Promise<MemoryDomain> {
	const memoryDomains = coreTable(db, d1MemoryDomains);
	domain = { ...domain, ...normalizeTenantScope(domain) };
	const [created] = await db.insert(memoryDomains).values(domain).returning();
	if (!created) throw new Error(`Failed to create domain: ${domain.id}`);
	return created;
}
