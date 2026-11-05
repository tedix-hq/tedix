import { and, eq, exists, lt, or, sql } from "drizzle-orm";
import {
	type AnySQLiteColumn,
	alias,
	QueryBuilder,
} from "drizzle-orm/sqlite-core";
import { skillUsageEvents } from "../../schema/cognitive";

/**
 * SQL predicate: the `skill_usage_events` row `usage` is a REUSE — some other
 * execution of the same skill in the same org strictly precedes it
 * (created_at, with id as the tie-breaker for identical timestamps). Used by
 * the strategy-map daily skill-reuse rate (queries/strategy-map.ts).
 */
export function skillReusePriorEventSql(
	usage: Record<
		"id" | "organizationId" | "skillId" | "createdAt",
		AnySQLiteColumn
	>,
) {
	const prior = alias(skillUsageEvents, "prior");
	return exists(
		new QueryBuilder()
			.select({ one: sql`1` })
			.from(prior)
			.where(
				and(
					eq(prior.organizationId, usage.organizationId),
					eq(prior.skillId, usage.skillId),
					or(
						lt(prior.createdAt, usage.createdAt),
						and(eq(prior.createdAt, usage.createdAt), lt(prior.id, usage.id)),
					),
				),
			),
	);
}
