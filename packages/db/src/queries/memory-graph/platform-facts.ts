/**
 * Memory Graph Query Helpers
 * CRUD operations for the knowledge graph — facts, edges, and domains.
 */

import { and, desc, eq, isNull, or } from "drizzle-orm";
import type { DbClient } from "../../client";
import {
	type MemoryFact,
	memoryDomains,
	memoryFacts,
} from "../../schema/memory-graph";

export async function getTopPlatformFacts(
	db: DbClient,
	orgId: string,
	options?: { tediId?: string; limit?: number },
): Promise<Array<{ fact: MemoryFact; domainName: string | null }>> {
	const limit = options?.limit ?? 30;

	// One query PER priority instead of `OR`-ing the two and re-ranking with
	// `CASE WHEN priority = 'core' THEN 0 ELSE 1 END`. That CASE was the whole
	// cost: it is not an indexable ordering, so SQLite materialised every
	// core/active fact in the organization into a temp B-tree just to take 30 of
	// them -- 79,204 rows and 4,960ms on production, on EVERY Home turn, because
	// context assembly calls this per turn. Adding an index alone does not fix it
	// (verified against the planner: the temp B-tree survives while the CASE is
	// there); the ordering has to become index-shaped first.
	//
	// Splitting is exactly equivalent. The old ORDER BY emitted every `core` row
	// ahead of every `active` row, each group already sorted by confidence then
	// last-accessed, so concatenating the two groups and truncating reproduces
	// the same sequence. Each half is now a plain equality lookup that
	// `idx_memory_facts_priority_rank` serves in order, so D1 stops at the LIMIT.
	const selectByPriority = (priority: "core" | "active") => {
		const conditions = [
			eq(memoryFacts.organizationId, orgId),
			eq(memoryFacts.priority, priority),
			isNull(memoryFacts.archivedAt),
		];
		if (options?.tediId) {
			// Include both tedi-specific and org-wide (null tediId) facts
			conditions.push(
				or(eq(memoryFacts.tediId, options.tediId), isNull(memoryFacts.tediId))!,
			);
		}
		return db
			.select({
				fact: memoryFacts,
				domainName: memoryDomains.name,
			})
			.from(memoryFacts)
			.leftJoin(memoryDomains, eq(memoryFacts.domainId, memoryDomains.id))
			.where(and(...conditions))
			.orderBy(desc(memoryFacts.confidence), desc(memoryFacts.lastAccessedAt))
			.limit(limit);
	};

	// Batched so the split still costs one D1 round trip, not two.
	const [core, active] = await db.batch([
		selectByPriority("core"),
		selectByPriority("active"),
	]);

	return [...core, ...active].slice(0, limit);
}
