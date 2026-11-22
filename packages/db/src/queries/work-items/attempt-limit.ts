import { sql } from "drizzle-orm";
import { workItems, type WorkItem } from "../../schema/work-items";

/** A successful run of this Work version must be closed or explicitly revised. */
export function laneDispatchHasNoSettledResult() {
	return sql<boolean>`${sql`NOT EXISTS (
		SELECT 1 FROM work_attempts AS result
		JOIN work_admissions AS admission ON admission.id = result.admission_id
			AND admission.org_id = result.org_id AND admission.work_item_id = result.work_item_id
		WHERE result.org_id = ${workItems.orgId} AND result.work_item_id = ${workItems.id}
			AND result.outcome IN ('succeeded', 'landed_unverified')
			AND admission.decision = 'admitted'
			AND admission.work_item_version = ${workItems.version}
			AND admission.admission_spec_revision = ${workItems.admissionSpecRevision}
			AND coalesce(json_extract(${workItems.metadata}, '$.decisionContinuation.at'), '') <= coalesce(result.finished_at, '')
			AND NOT EXISTS (SELECT 1 FROM work_attempts AS newer
				WHERE newer.org_id = result.org_id AND newer.work_item_id = result.work_item_id
				AND newer.attempt_number > result.attempt_number)
	)`}`;
}

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
