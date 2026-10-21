import { sql } from "drizzle-orm";

/**
 * SQL predicate: the `skill_usage_events` row aliased `alias` is a REUSE —
 * some other execution of the same skill in the same org strictly precedes it
 * (created_at, with id as the tie-breaker for identical timestamps). Used by
 * the strategy-map daily skill-reuse rate (queries/strategy-map.ts).
 */
export function skillReusePriorEventSql(alias: string) {
	const usage = sql.raw(alias);
	return sql`EXISTS (
		SELECT 1 FROM skill_usage_events prior
		WHERE prior.organization_id = ${usage}.organization_id
			AND prior.skill_id = ${usage}.skill_id
			AND (prior.created_at < ${usage}.created_at
				OR (prior.created_at = ${usage}.created_at AND prior.id < ${usage}.id))
	)`;
}
