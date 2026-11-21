import { sql } from "drizzle-orm";
import { workItems, type WorkItem } from "../../schema/work-items";

/** Shared by readiness, admission preview and the atomic Attempt INSERT. */
export function workAttemptLimitAvailable() {
	// Nest the expression so SELECT projections preserve correlated outer columns.
	return sql<boolean>`${sql`(
		(json_type(${workItems.metadata}, '$.factoryCycle') IS NULL AND (
			${workItems.maxAttempts} IS NULL OR (
				typeof(${workItems.maxAttempts}) = 'integer'
				AND ${workItems.maxAttempts} BETWEEN 1 AND 20
				AND (SELECT COUNT(*) FROM work_attempts AS prior
					WHERE prior.org_id = ${workItems.orgId}
					AND prior.work_item_id = ${workItems.id}
					AND (prior.outcome IS NULL OR prior.outcome NOT IN ('cancelled','rejected')))
					< ${workItems.maxAttempts} + (SELECT COUNT(*) FROM work_events AS grants
						WHERE grants.org_id = ${workItems.orgId}
						AND grants.work_item_id = ${workItems.id}
						AND grants.event_type = 'lane.attempt_granted')
			)
		)) OR (
			json_type(${workItems.metadata}, '$.factoryCycle') = 'object'
			AND typeof(${workItems.maxAttempts}) = 'integer'
			AND ${workItems.maxAttempts} BETWEEN 1 AND 5
			AND (SELECT COUNT(*) FROM work_attempts AS factory_prior
				WHERE factory_prior.org_id = ${workItems.orgId}
				AND factory_prior.work_item_id = ${workItems.id})
			< ${workItems.maxAttempts}
		))`}`;
}

export function workAttemptLimitReason(
	item: Pick<WorkItem, "id" | "maxAttempts" | "metadata">,
) {
	const factory = item.metadata?.factoryCycle !== undefined;
	const cap = item.maxAttempts;
	if (
		(cap !== null &&
			(!Number.isInteger(cap) || cap < 1 || cap > (factory ? 5 : 20))) ||
		(factory && cap === null)
	)
		return "Invalid Attempt retry limit; the owner must set a valid maxAttempts in the Work specification.";
	return factory
		? "Factory Attempt retry limit exhausted; the owner must create replacement factory Work."
		: `Attempt retry limit (${cap}) exhausted; the owner must grant one extra Attempt with work attempt-grant ${item.id}.`;
}
