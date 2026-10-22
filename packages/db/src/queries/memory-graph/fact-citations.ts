import { and, eq, sql } from "drizzle-orm";
import type { DbQueryClient } from "../../query-client";
import { memoryFactCitationBackfills } from "../../schema/memory-fact-citations";

const SOURCES = [
	"consolidation://observation",
	"consolidation://standing_summary",
];
const PAGE_SIZE = 100;

async function progress(db: DbQueryClient, orgId: string) {
	const [row] = await db
		.select()
		.from(memoryFactCitationBackfills)
		.where(eq(memoryFactCitationBackfills.organizationId, orgId));
	return row;
}

/**
 * Only unindexed legacy facts may parse evidence, in bounded pages. Until the
 * org's backfill marker is done, `legacyPages` caps how many 100-fact pages one
 * call reads: a hot read passes a small budget and may miss a legacy dependent
 * past it; the mutation path walks every page.
 */
export async function findCitationDependents(
	db: DbQueryClient,
	orgId: string,
	citedIds: string[],
	options?: { legacyPages?: number },
) {
	if (!citedIds.length) return [];
	const checkpoint = await progress(db, orgId);
	const ids = new Set<string>();
	let pages = options?.legacyPages ?? Number.POSITIVE_INFINITY;
	if (!checkpoint?.done) {
		for (const source of SOURCES) {
			if (checkpoint && source < checkpoint.source) continue;
			let cursor = checkpoint?.source === source ? checkpoint.factId : "";
			while (pages-- > 0) {
				// Materialize the page before evaluating JSON; LIMIT after EXISTS would still
				// parse an unbounded number of candidates when evidence does not match.
				const page = await db.all<{
					id: string;
				}>(sql`SELECT id AS id FROM memory_facts INDEXED BY idx_memory_facts_org_source_id
    WHERE organization_id = ${orgId} AND source = ${source} AND id > ${cursor}
    AND NOT EXISTS (SELECT 1 FROM memory_fact_citations link WHERE link.consolidated_fact_id = memory_facts.id)
    ORDER BY id LIMIT ${PAGE_SIZE}`);
				if (!page.length) break;
				const matches = await db.all<{
					id: string;
				}>(sql`SELECT id AS id FROM memory_facts INDEXED BY sqlite_autoindex_memory_facts_1
    WHERE organization_id = ${orgId} AND id IN (SELECT value FROM json_each(${JSON.stringify(page.map((row) => row.id))}))
    AND NOT EXISTS (SELECT 1 FROM memory_fact_citations link WHERE link.consolidated_fact_id = memory_facts.id)
    AND json_type(memory_facts.metadata, '$.consolidation.evidence.sources') = 'array'
    AND EXISTS (SELECT 1 FROM json_each(memory_facts.metadata, '$.consolidation.evidence.sources') citation
     WHERE citation.type = 'object' AND json_extract(citation.value, '$.id') IN (SELECT value FROM json_each(${JSON.stringify(citedIds)})))`);
				for (const row of matches) ids.add(row.id);
				cursor = page.at(-1)!.id;
				if (page.length < PAGE_SIZE) break;
			}
		}
	}
	// Read links after the fallback: a concurrent backfill can move a fact out
	// of the missing-link set between page reads. The final seek includes it.
	const rows = await db.all<{
		id: string;
	}>(sql`SELECT DISTINCT consolidated_fact_id AS id
  FROM memory_fact_citations INDEXED BY idx_memory_fact_citations_org_cited
  WHERE organization_id = ${orgId} AND cited_fact_id IN (SELECT value FROM json_each(${JSON.stringify(citedIds)}))`);
	for (const row of rows) ids.add(row.id);
	return [...ids];
}

/** Atomic cursor and link repair; a crash replays at most one idempotent page. */
export async function backfillFactCitations(
	db: DbQueryClient,
	orgId: string,
	limit = PAGE_SIZE,
) {
	const checkpoint = await progress(db, orgId);
	if (checkpoint?.done) return 0;
	const size = Math.min(PAGE_SIZE, Math.max(1, Math.trunc(limit) || PAGE_SIZE));
	const page: Array<{ id: string; source: string }> = [];
	for (const source of SOURCES) {
		if (checkpoint && source < checkpoint.source) continue;
		const cursor = checkpoint?.source === source ? checkpoint.factId : "";
		page.push(
			...(await db.all<{
				id: string;
				source: string;
			}>(sql`SELECT id AS id, source AS source
   FROM memory_facts INDEXED BY idx_memory_facts_org_source_id
   WHERE organization_id = ${orgId} AND source = ${source} AND id > ${cursor}
   ORDER BY id LIMIT ${size - page.length}`)),
		);
		if (page.length === size) break;
	}
	const last = page.at(-1);
	const factIds = JSON.stringify(page.map((row) => row.id));
	await db.batch([
		// Read the persisted metadata inside the batch, never a stale pre-CAS snapshot.
		db.run(sql`INSERT OR IGNORE INTO memory_fact_citations(organization_id, cited_fact_id, consolidated_fact_id)
   SELECT f.organization_id, json_extract(citation.value, '$.id'), f.id
   FROM memory_facts f INDEXED BY sqlite_autoindex_memory_facts_1,
    json_each(f.metadata, '$.consolidation.evidence.sources') citation
   WHERE f.organization_id = ${orgId} AND f.id IN (SELECT value FROM json_each(${factIds}))
    AND json_type(f.metadata, '$.consolidation.evidence.sources') = 'array'
    AND citation.type = 'object' AND json_type(citation.value, '$.id') = 'text'`),
		db
			.insert(memoryFactCitationBackfills)
			.values({
				organizationId: orgId,
				source: last?.source ?? checkpoint?.source ?? SOURCES[0]!,
				factId: last?.id ?? checkpoint?.factId ?? "",
				done: page.length < size,
			})
			.onConflictDoUpdate({
				target: memoryFactCitationBackfills.organizationId,
				set: {
					source: last?.source ?? checkpoint?.source ?? SOURCES[0]!,
					factId: last?.id ?? checkpoint?.factId ?? "",
					done: page.length < size,
				},
				// Concurrent ticks may finish out of order; never move the watermark back.
				setWhere: and(
					eq(memoryFactCitationBackfills.done, false),
					sql`(${memoryFactCitationBackfills.source}, ${memoryFactCitationBackfills.factId}) <= (${last?.source ?? checkpoint?.source ?? SOURCES[0]!}, ${last?.id ?? checkpoint?.factId ?? ""})`,
				),
			}),
	]);
	return page.length;
}
