import { sql } from "drizzle-orm";
import { coreStore } from "../../core-store/dialect";

/**
 * SQL prefilter for rationale evidence that cites durable brain facts.
 * Pass the client so Postgres matches jsonb as text, case-insensitively like SQLite LIKE.
 */
export function evidenceReferencesFactsSql(db: object) {
	const postgres = coreStore(db) === "postgres";
	const evidence = postgres ? sql`CAST(evidence AS text)` : sql`evidence`;
	const like = postgres ? sql`ILIKE` : sql`LIKE`;
	return sql`(
		${evidence} ${like} '%"factId"%'
		OR ${evidence} ${like} '%"fact_id"%'
		OR ${evidence} ${like} '%"factIds"%'
		OR ${evidence} ${like} '%"fact_ids"%'
		OR ${evidence} ${like} '%"memoryFactId"%'
		OR ${evidence} ${like} '%"memory_fact_id"%'
		OR ${evidence} ${like} '%"memoryFactIds"%'
		OR ${evidence} ${like} '%"memory_fact_ids"%'
		OR ${evidence} ${like} '%"retrievedFactIds"%'
		OR ${evidence} ${like} '%"retrieved_fact_ids"%'
		OR ${evidence} ${like} '%"retrievedFacts"%'
		OR ${evidence} ${like} '%"retrieved_facts"%'
		OR ${evidence} ${like} '%"usedFactIds"%'
		OR ${evidence} ${like} '%"used_fact_ids"%'
		OR ${evidence} ${like} '%"ignoredFactIds"%'
		OR ${evidence} ${like} '%"ignored_fact_ids"%'
		OR ${evidence} ${like} '%"notUsedFactIds"%'
		OR ${evidence} ${like} '%"not_used_fact_ids"%'
		OR ${evidence} ${like} '%"failedFactIds"%'
		OR ${evidence} ${like} '%"failed_fact_ids"%'
	)`;
}
