import { sql } from "drizzle-orm";

/** SQL prefilter for rationale evidence that cites durable brain facts. */
export function evidenceReferencesFactsSql() {
	return sql`(
		evidence LIKE '%"factId"%'
		OR evidence LIKE '%"fact_id"%'
		OR evidence LIKE '%"factIds"%'
		OR evidence LIKE '%"fact_ids"%'
		OR evidence LIKE '%"memoryFactId"%'
		OR evidence LIKE '%"memory_fact_id"%'
		OR evidence LIKE '%"memoryFactIds"%'
		OR evidence LIKE '%"memory_fact_ids"%'
		OR evidence LIKE '%"retrievedFactIds"%'
		OR evidence LIKE '%"retrieved_fact_ids"%'
		OR evidence LIKE '%"retrievedFacts"%'
		OR evidence LIKE '%"retrieved_facts"%'
		OR evidence LIKE '%"usedFactIds"%'
		OR evidence LIKE '%"used_fact_ids"%'
		OR evidence LIKE '%"ignoredFactIds"%'
		OR evidence LIKE '%"ignored_fact_ids"%'
		OR evidence LIKE '%"notUsedFactIds"%'
		OR evidence LIKE '%"not_used_fact_ids"%'
		OR evidence LIKE '%"failedFactIds"%'
		OR evidence LIKE '%"failed_fact_ids"%'
	)`;
}
