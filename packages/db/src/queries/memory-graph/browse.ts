import { and, asc, desc, eq, isNull, or, sql } from "drizzle-orm";
import type { DbQueryClient } from "../../query-client";
import { memoryFacts } from "../../schema/memory-graph";

interface BrowseMemoryParams {
	orgId: string;
	tediId?: string;
	view: "observations" | "stale" | "contradictions" | "gaps";
	search?: string;
	domainId?: string;
	minConfidence?: number;
	orderBy: "updated" | "confidence";
	limit: number;
	offset: number;
}

export async function browseMemory(
	db: DbQueryClient,
	input: BrowseMemoryParams,
) {
	const visible = input.tediId
		? sql`(${memoryFacts.visibility} IN ('org', 'shared') OR ${memoryFacts.tediId} = ${input.tediId})`
		: sql`${memoryFacts.visibility} IN ('org', 'shared')`;
	const filters = [eq(memoryFacts.organizationId, input.orgId), visible];
	if (input.view === "stale") {
		// Keep the same age boundary as memory health, independent of review status.
		const cutoff = new Date(
			Date.now() - 60 * 24 * 60 * 60 * 1000,
		).toISOString();
		filters.push(
			isNull(memoryFacts.archivedAt),
			sql`COALESCE(${memoryFacts.lastAccessedAt}, ${memoryFacts.createdAt}) < ${cutoff}`,
		);
	} else if (input.view === "contradictions") {
		// Both ends must be visible; never expose a private target via its edge.
		filters.push(sql`EXISTS (
			SELECT 1 FROM memory_edges e JOIN memory_facts target ON target.id = e.target_fact_id
			WHERE e.source_fact_id = ${memoryFacts.id} AND e.relation_type = 'contradicts'
			AND target.organization_id = ${input.orgId}
			AND (target.visibility IN ('org', 'shared') OR target.tedi_id = ${input.tediId ?? ""})
		)`);
	} else {
		filters.push(isNull(memoryFacts.archivedAt), isNull(memoryFacts.validTo));
		if (input.view === "gaps") filters.push(eq(memoryFacts.factType, "gap"));
		else
			filters.push(
				sql`${memoryFacts.source} IN ('consolidation://observation', 'consolidation://standing_summary')`,
				sql`json_extract(${memoryFacts.metadata}, '$.consolidation.isHistory') = 0`,
			);
	}
	if (input.search?.trim())
		filters.push(
			or(
				sql`instr(lower(${memoryFacts.content}), lower(${input.search.trim()})) > 0`,
				sql`instr(lower(coalesce(${memoryFacts.summary}, '')), lower(${input.search.trim()})) > 0`,
			)!,
		);
	if (input.domainId) filters.push(eq(memoryFacts.domainId, input.domainId));
	if (input.minConfidence !== undefined)
		filters.push(sql`${memoryFacts.confidence} >= ${input.minConfidence}`);
	const limit = Math.min(25, Math.max(1, input.limit));
	const facts = await db
		.select()
		.from(memoryFacts)
		.where(and(...filters))
		.orderBy(
			...(input.orderBy === "confidence" ? [desc(memoryFacts.confidence)] : []),
			desc(memoryFacts.updatedAt),
			asc(memoryFacts.id),
		)
		.limit(limit + 1)
		.offset(input.offset);
	return {
		facts: facts.slice(0, limit),
		nextOffset: facts.length > limit ? input.offset + limit : null,
	};
}
