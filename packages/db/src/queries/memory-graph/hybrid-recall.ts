import { and, desc, eq, sql, type SQL } from "drizzle-orm";
import type { DbQueryClient } from "../../query-client";
import { memoryFacts, type MemoryFact } from "../../schema/memory-graph";
import { prefixedColumns } from "../../utils/select";
import { filterEvidenceBackedLessons } from "./agent-lessons";

export interface RecallScope {
	orgId: string;
	tediId?: string;
	domainIds?: string[];
	factTypes?: string[];
	minConfidence?: number;
	includeGraphAnchors?: boolean;
	now?: string;
}
export interface RecallCandidate {
	factId: string;
	score: number;
}
export function recallTerms(query: string): string[] {
	return [
		...new Set(
			query
				.normalize("NFKC")
				.toLowerCase()
				.match(/[\p{L}\p{N}_-]+/gu) ?? [],
		),
	]
		.filter((term) => term.length >= 2)
		.slice(0, 24);
}

/** Applied before each arm's LIMIT, and again when hydrating external IDs. */
function eligible(scope: RecallScope): SQL {
	const now = scope.now ?? new Date().toISOString();
	const f = memoryFacts;
	return and(
		eq(f.organizationId, scope.orgId),
		sql`${f.archivedAt} IS NULL`,
		sql`coalesce(json_extract(${f.metadata}, '$.learningFeed.evidence.state'), '') != 'held'`,
		sql`(${f.validTo} IS NULL OR datetime(${f.validTo}) > datetime(${now}))`,
		sql`(${f.validFrom} IS NULL OR datetime(${f.validFrom}) <= datetime(${now}))`,
		sql`coalesce(${f.reviewStatus}, '') NOT IN ('restricted','rejected','superseded','stale','disputed')`,
		sql`(${f.visibility} IN ('org','shared') OR (${f.visibility} = 'private' AND ${f.tediId} = ${scope.tediId ?? ""}))`,
		sql`${f.confidence} >= ${scope.minConfidence ?? 0.3}`,
		scope.includeGraphAnchors
			? undefined
			: sql`coalesce(${f.memoryScope}, '') != 'graph' AND coalesce(${f.usePolicy}, '') != 'do_not_inject_automatically'`,
		scope.domainIds?.length
			? sql`${f.domainId} IN (SELECT value FROM json_each(${JSON.stringify(scope.domainIds)}))`
			: undefined,
		scope.factTypes?.length
			? sql`${f.factType} IN (SELECT value FROM json_each(${JSON.stringify(scope.factTypes)}))`
			: undefined,
		sql`(json_extract(${f.metadata}, '$.expiresAt') IS NULL OR datetime(json_extract(${f.metadata}, '$.expiresAt')) > datetime(${now}))`,
		// Edge direction is newer/source -> older/target for supersedes. For a
		// contradiction either direction is allowed; actual validity time wins.
		sql`NOT EXISTS (
			SELECT 1 FROM memory_edges e JOIN memory_facts newer
			ON newer.organization_id = ${scope.orgId}
			AND newer.id = CASE WHEN e.target_fact_id = ${f.id} THEN e.source_fact_id ELSE e.target_fact_id END
			WHERE ((e.relation_type = 'supersedes' AND e.target_fact_id = ${f.id})
			OR (e.relation_type = 'contradicts' AND (e.source_fact_id = ${f.id} OR e.target_fact_id = ${f.id})
			AND newer.archived_at IS NULL AND (newer.valid_to IS NULL OR datetime(newer.valid_to) > datetime(${now}))
			AND NOT EXISTS (SELECT 1 FROM memory_edges replacement WHERE replacement.relation_type = 'supersedes' AND replacement.source_fact_id = ${f.id} AND replacement.target_fact_id = newer.id)
			AND (datetime(coalesce(newer.valid_from,newer.created_at)) > datetime(coalesce(${f.validFrom},${f.createdAt}))
			OR (datetime(coalesce(newer.valid_from,newer.created_at)) = datetime(coalesce(${f.validFrom},${f.createdAt})) AND newer.id > ${f.id}))))
		)`,
	)!;
}

export async function lexicalRecall(
	db: DbQueryClient,
	scope: RecallScope,
	query: string,
): Promise<RecallCandidate[]> {
	const terms = recallTerms(query);
	if (!terms.length) return [];
	const match = terms.map((term) => `"${term}"`).join(" OR ");
	// Explicit historical clocks need the full index: recall projection expiry
	// follows wall time. Graph-anchor searches also keep their complete corpus.
	const index = sql.identifier(
		scope.includeGraphAnchors || scope.now
			? "memory_fact_fts"
			: "memory_fact_fts_recall",
	);
	return (
		db
			.select({
				factId: memoryFacts.id,
				score: sql<number>`-${index}.rank`.as("lexical_score"),
			})
			// Native rank streams BM25 matches; CROSS JOIN forces rowid lookups
			// instead of scanning all active facts. Filter before LIMIT so invalid
			// high-ranking matches cannot crowd out usable facts.
			.from(sql`${index}`)
			.crossJoin(memoryFacts)
			.where(
				and(
					eligible(scope),
					sql`${memoryFacts}.rowid = ${index}.rowid`,
					sql`${index} MATCH ${match}`,
					sql`${index}.organization_id = ${scope.orgId}`,
					sql`${index}.rank MATCH 'bm25(0,0,1,2)'`,
				),
			)
			.orderBy(sql`${index}.rank`)
			.limit(40)
	);
}

export async function graphRecall(
	db: DbQueryClient,
	scope: RecallScope,
	query: string,
): Promise<RecallCandidate[]> {
	const terms = recallTerms(query);
	if (!terms.length) return [];
	// Resolve entities from the query, then traverse one fact edge from their
	// accepted mentions. Every hop independently fences organization ownership.
	const matched = sql`WITH seeds AS (
		SELECT DISTINCT m.source_fact_id AS fact_id FROM memory_entities ent
		JOIN memory_entity_resolutions r ON r.entity_id = ent.id AND r.organization_id = ${scope.orgId} AND r.status = 'active' AND r.valid_to IS NULL
		JOIN memory_entity_mentions m ON m.id = r.mention_id AND m.organization_id = ${scope.orgId}
		JOIN memory_facts seed ON seed.id = m.source_fact_id AND seed.organization_id = ${scope.orgId}
		WHERE ent.organization_id = ${scope.orgId} AND ent.status = 'active'
		AND EXISTS (SELECT 1 FROM ${memoryFacts} WHERE ${memoryFacts.id} = seed.id AND ${eligible({ ...scope, domainIds: undefined, factTypes: undefined, includeGraphAnchors: true, minConfidence: 0 })})
		AND instr(${` ${terms.join(" ")} `}, ' ' || ent.normalized_name || ' ') > 0
		LIMIT 40
	) SELECT fact_id FROM seeds UNION SELECT CASE WHEN e.source_fact_id = seeds.fact_id THEN e.target_fact_id ELSE e.source_fact_id END AS fact_id
	FROM seeds JOIN memory_edges e ON e.source_fact_id = seeds.fact_id OR e.target_fact_id = seeds.fact_id`;
	return db
		.select({
			factId: sql<string>`${memoryFacts.id}`.as("graph_fact_id"),
			score: sql<number>`${memoryFacts.confidence}`.as("graph_score"),
		})
		.from(sql`${memoryFacts} INDEXED BY sqlite_autoindex_memory_facts_1`)
		.where(and(eligible(scope), sql`${memoryFacts.id} IN (${matched})`))
		.orderBy(desc(memoryFacts.confidence), memoryFacts.id)
		.limit(40);
}

export interface RecallWindow {
	from: string;
	to: string;
}
/** UTC calendar cues; an explicit date wins over relative wording. */
export function recallWindow(
	query: string,
	now = new Date(),
): RecallWindow | undefined {
	const date = query.match(/\b\d{4}-\d{2}-\d{2}\b/)?.[0];
	let end = new Date(
		Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1),
	);
	let days = 1;
	if (date) {
		const start = new Date(`${date}T00:00:00.000Z`);
		if (
			!Number.isFinite(start.getTime()) ||
			start.toISOString().slice(0, 10) !== date
		)
			return undefined;
		return {
			from: start.toISOString(),
			to: new Date(start.getTime() + 86_400_000).toISOString(),
		};
	}
	if (/\byesterday\b/i.test(query)) end = new Date(end.getTime() - 86_400_000);
	else if (/\b(last|past) week\b/i.test(query)) days = 7;
	else if (/\b(last|past) month\b/i.test(query)) days = 30;
	else if (!/\b(today|recent|recently|latest)\b/i.test(query)) return undefined;
	return {
		from: new Date(end.getTime() - days * 86_400_000).toISOString(),
		to: end.toISOString(),
	};
}
export async function temporalRecall(
	db: DbQueryClient,
	scope: RecallScope,
	query: string,
): Promise<RecallCandidate[]> {
	const window = recallWindow(query, new Date(scope.now ?? Date.now()));
	if (!window) return [];
	const time = sql`coalesce(${memoryFacts.validFrom}, ${memoryFacts.createdAt})`;
	const decay = sql<number>`1.0 / (1.0 + max(0, julianday(${scope.now ?? new Date().toISOString()}) - julianday(${time})))`;
	return db
		.select({
			factId: sql<string>`${memoryFacts.id}`.as("temporal_fact_id"),
			score: decay.as("temporal_score"),
		})
		.from(sql`${memoryFacts} INDEXED BY sqlite_autoindex_memory_facts_1`)
		.where(
			and(
				eligible(scope),
				// Separate time ranges let SQLite use each tenant/time index before
				// evaluating lifecycle predicates on just the matching fact IDs.
				sql`${memoryFacts.id} IN (
				SELECT id FROM memory_facts WHERE organization_id = ${scope.orgId}
				AND datetime(coalesce(valid_from, created_at)) >= datetime(${window.from})
				AND datetime(coalesce(valid_from, created_at)) < datetime(${window.to})
				UNION SELECT id FROM memory_facts WHERE organization_id = ${scope.orgId}
				AND datetime(valid_to) >= datetime(${window.from}) AND datetime(valid_to) < datetime(${window.to})
				)`,
			),
		)
		.orderBy(desc(decay), memoryFacts.id)
		.limit(40);
}

export async function hydrateRecall(
	db: DbQueryClient,
	scope: RecallScope,
	ids: string[],
): Promise<Array<MemoryFact & { replacesFactIds: string[] }>> {
	if (!ids.length) return [];
	const rows = await db
		.select({
			...prefixedColumns(memoryFacts, "fact"),
			replacesFactIds: sql<string>`(
			SELECT coalesce(json_group_array(older.id), '[]') FROM memory_edges edge
			JOIN memory_facts older ON older.organization_id = ${scope.orgId}
		AND older.id = CASE WHEN edge.source_fact_id = memory_facts.id THEN edge.target_fact_id ELSE edge.source_fact_id END
			WHERE (older.visibility IN ('org','shared') OR (older.visibility = 'private' AND older.tedi_id = ${scope.tediId ?? ""}))
			AND ((edge.relation_type = 'supersedes' AND edge.source_fact_id = memory_facts.id)
			OR (edge.relation_type = 'contradicts' AND (edge.source_fact_id = memory_facts.id OR edge.target_fact_id = memory_facts.id)
			AND (datetime(coalesce(older.valid_from,older.created_at)), older.id) < (datetime(coalesce(memory_facts.valid_from,memory_facts.created_at)), memory_facts.id)))
		)`
				.mapWith((value: string) => JSON.parse(value) as string[])
				.as("replaces_fact_ids"),
		})
		// D1 otherwise chooses archived_at and scans the whole active corpus
		// even for one ID. Keep ownership/lifecycle predicates on a PK lookup.
		.from(sql`${memoryFacts} INDEXED BY sqlite_autoindex_memory_facts_1`)
		.where(
			and(
				eligible(scope),
				sql`${memoryFacts.id} IN (SELECT value FROM json_each(${JSON.stringify(ids)}))`,
			),
		);
	return filterEvidenceBackedLessons(db, scope.orgId, rows);
}
export async function fallbackRecall(
	db: DbQueryClient,
	scope: RecallScope,
): Promise<MemoryFact[]> {
	const rows = await db
		.select()
		.from(memoryFacts)
		.where(eligible(scope))
		.orderBy(desc(memoryFacts.confidence), desc(memoryFacts.createdAt))
		.limit(100);
	return filterEvidenceBackedLessons(db, scope.orgId, rows);
}

/** Repair old rows in bounded, repeatable chunks; new writes are trigger-synced. */
export async function backfillFactSearch(
	db: DbQueryClient,
	orgId: string,
	limit = 500,
): Promise<number> {
	const results = await db.batch([
		db.run(sql`INSERT OR REPLACE INTO memory_fact_fts(rowid, fact_id, organization_id, text, entity_names)
		SELECT rowid, fact_id, organization_id, text, entity_names FROM memory_fact_search_documents d
		WHERE d.organization_id = ${orgId} AND NOT EXISTS (SELECT 1 FROM memory_fact_fts x WHERE x.rowid = d.rowid)
		ORDER BY d.rowid LIMIT ${Math.min(500, Math.max(1, limit))}`),
		db.get<{ changed: number }>(sql`SELECT changes() AS changed`),
		db.run(sql`DELETE FROM memory_fact_fts_recall WHERE rowid IN (
		SELECT rowid FROM memory_fact_fts_recall x WHERE x.organization_id = ${orgId}
		AND NOT EXISTS (SELECT 1 FROM memory_fact_recall_documents d WHERE d.rowid = x.rowid)
		ORDER BY rowid LIMIT ${Math.min(500, Math.max(1, limit))})`),
		db.get<{ changed: number }>(sql`SELECT changes() AS changed`),
		db.run(sql`INSERT OR REPLACE INTO memory_fact_fts_recall(rowid, fact_id, organization_id, text, entity_names)
		SELECT rowid, fact_id, organization_id, text, entity_names FROM memory_fact_recall_documents d
		WHERE d.organization_id = ${orgId} AND NOT EXISTS (SELECT 1 FROM memory_fact_fts_recall x WHERE x.rowid = d.rowid)
		ORDER BY d.rowid LIMIT ${Math.min(500, Math.max(1, limit))}`),
		db.get<{ changed: number }>(sql`SELECT changes() AS changed`),
	]);
	return (
		(results[1]?.changed ?? 0) +
		(results[3]?.changed ?? 0) +
		(results[5]?.changed ?? 0)
	);
}
