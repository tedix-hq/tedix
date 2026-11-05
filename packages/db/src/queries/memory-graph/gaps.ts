/**
 * Memory Graph Query Helpers
 * CRUD operations for the knowledge graph — facts, edges, and domains.
 */

import { type TenantScope, normalizeTenantScope } from "../../tenant-scope";

import type { JsonValue } from "@tedix/api-contract/schemas/common";
import { and, desc, eq, isNull, not, sql } from "drizzle-orm";
import type { DbClient } from "../../client";
import {
	type MemoryFact,
	memoryDomains,
	memoryFacts,
} from "../../schema/memory-graph";
import { createEdge } from "./edges";
import { createFact, getFactById, updateFact } from "./facts";

export async function createGapFact(
	db: DbClient,
	params: {
		tediId?: string;
		domainId: string;
		content: string;
		metadata: Record<string, JsonValue>;
		confidence?: number;
	} & TenantScope,
): Promise<MemoryFact> {
	params = { ...params, ...normalizeTenantScope(params) };
	return createFact(db, {
		workspaceId: params.workspaceId,
		id: crypto.randomUUID(),
		organizationId: params.organizationId,
		tediId: params.tediId ?? null,
		domainId: params.domainId,
		content: params.content,
		factType: "gap",
		confidence: params.confidence ?? 0.8,
		metadata: params.metadata,
		visibility: params.tediId ? "private" : "org",
		accessCount: 0,
	});
}

export async function listGaps(
	db: DbClient,
	tenantScope: TenantScope,
	options?: {
		domainId?: string;
		severity?: string;
		tediId?: string;
		limit?: number;
	},
): Promise<MemoryFact[]> {
	const { organizationId: orgId } = normalizeTenantScope(tenantScope);
	const conditions = [
		eq(memoryFacts.organizationId, orgId),
		eq(memoryFacts.factType, "gap"),
		isNull(memoryFacts.archivedAt),
	];

	if (options?.domainId) {
		conditions.push(eq(memoryFacts.domainId, options.domainId));
	}
	if (options?.tediId) {
		conditions.push(eq(memoryFacts.tediId, options.tediId));
	}

	const gaps = await db
		.select()
		.from(memoryFacts)
		.where(and(...conditions))
		.orderBy(desc(memoryFacts.confidence), desc(memoryFacts.createdAt))
		.limit(options?.limit ?? 50);

	// Filter by severity in metadata if specified
	if (options?.severity) {
		return gaps.filter((g) => {
			const meta = g.metadata as Record<string, unknown> | null;
			return meta?.severity === options.severity;
		});
	}
	return gaps;
}

/** Both facts must belong to the supplied tenant before updating the gap or edge. */
export async function resolveGap(
	db: DbClient,
	tenantScope: TenantScope,
	gapId: string,
	resolvedByFactId: string,
): Promise<void> {
	const { organizationId: orgId } = normalizeTenantScope(tenantScope);
	const gap = await getFactById(db, tenantScope, gapId);
	if (!gap || gap.organizationId !== orgId) {
		throw new Error(`Gap not found: ${gapId}`);
	}
	const resolvedBy = await getFactById(db, tenantScope, resolvedByFactId);
	if (!resolvedBy || resolvedBy.organizationId !== orgId) {
		throw new Error(`Resolving fact not found: ${resolvedByFactId}`);
	}

	const now = new Date().toISOString();
	const meta = (gap.metadata as Record<string, unknown>) ?? {};

	await updateFact(db, tenantScope, gapId, {
		metadata: { ...meta, resolvedBy: resolvedByFactId, resolvedAt: now },
		archivedAt: now,
	});

	// Create edge linking gap to resolving fact
	await createEdge(db, tenantScope, {
		id: crypto.randomUUID(),
		sourceFactId: resolvedByFactId,
		targetFactId: gapId,
		relationType: "supersedes",
		strength: 0.9,
		context: "Resolves knowledge gap",
	});
}

export async function getGapStats(
	db: DbClient,
	tenantScope: TenantScope,
): Promise<{
	totalGaps: number;
	resolvedGaps: number;
	byDomain: Record<string, number>;
	bySeverity: Record<string, number>;
}> {
	const { organizationId: orgId } = normalizeTenantScope(tenantScope);
	// Run all independent reads in parallel
	const [totalGaps, resolvedGaps, byDomainRows, allGaps] = await Promise.all([
		// Total active gaps
		db.$count(
			memoryFacts,
			and(
				eq(memoryFacts.organizationId, orgId),
				eq(memoryFacts.factType, "gap"),
				isNull(memoryFacts.archivedAt),
			),
		),

		// Resolved gaps (archived gap facts)
		db.$count(
			memoryFacts,
			and(
				eq(memoryFacts.organizationId, orgId),
				eq(memoryFacts.factType, "gap"),
				not(isNull(memoryFacts.archivedAt)),
			),
		),

		// By domain
		db
			.select({
				domainName: memoryDomains.name,
				count: sql<number>`count(*)`,
			})
			.from(memoryFacts)
			.innerJoin(memoryDomains, eq(memoryFacts.domainId, memoryDomains.id))
			.where(
				and(
					eq(memoryFacts.organizationId, orgId),
					eq(memoryFacts.factType, "gap"),
					isNull(memoryFacts.archivedAt),
				),
			)
			.groupBy(memoryDomains.name),

		// All active gaps for severity breakdown
		listGaps(db, tenantScope),
	]);

	const byDomain: Record<string, number> = {};
	for (const row of byDomainRows) {
		byDomain[row.domainName] = row.count;
	}

	const bySeverity: Record<string, number> = {};
	for (const gap of allGaps) {
		const meta = gap.metadata as Record<string, unknown> | null;
		const severity = (meta?.severity as string) ?? "unknown";
		bySeverity[severity] = (bySeverity[severity] ?? 0) + 1;
	}

	return {
		totalGaps,
		resolvedGaps,
		byDomain,
		bySeverity,
	};
}

// ============================================================================
// Curiosity Queue
// ============================================================================
