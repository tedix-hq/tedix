import { and, desc, eq, sql } from "drizzle-orm";
import type { DbQueryClient } from "../../query-client";
import { type WorkItem, workAttempts } from "../../schema/work-items";
import { workAdmissions } from "../../schema/work-factory";

/** From this many failed Attempts in a row, the task waits before the next one. */
const FAILURES_BEFORE_WAIT = 4;

/**
 * The wait after failed Attempts in a row on one Work version, newest first.
 * A failed Attempt has outcome `failed` (the run broke) or `rejected` (the
 * runner settled a result that says the task is incomplete); a task that
 * cannot be finished produces both, mixed. A success, a landed result, a
 * deferral, an Attempt whose runner went away (`expired`) or a new Work
 * version ends the row.
 * The spacing is the one repeated deferrals get: 1, 4, then 24 hours.
 */
export function failedAttemptsWait(
	attempts: {
		outcome: string | null;
		finishedAt: string | null;
		workItemVersion: number;
	}[],
	version: number,
	now: string,
): string | undefined {
	let count = 0;
	for (const attempt of attempts) {
		if (
			(attempt.outcome !== "failed" && attempt.outcome !== "rejected") ||
			attempt.workItemVersion !== version
		)
			break;
		count++;
	}
	const finishedAt = attempts[0]?.finishedAt;
	if (count < FAILURES_BEFORE_WAIT || !finishedAt) return;
	const hours =
		count === FAILURES_BEFORE_WAIT
			? 1
			: count === FAILURES_BEFORE_WAIT + 1
				? 4
				: 24;
	const retryAt = Date.parse(finishedAt) + hours * 3_600_000;
	if (retryAt <= Date.parse(now)) return;
	return `Failed ${count} times in a row on this task version. Recheck at ${new Date(retryAt).toISOString()}; revising the task wakes it sooner.`;
}

/** Readiness uses durable history, including on runners without local receipts. */
export async function workDeferralWait(
	db: DbQueryClient,
	item: WorkItem,
	now: string,
): Promise<string | undefined> {
	const attempts = await db
		.select({
			outcome: workAttempts.outcome,
			metadata: workAttempts.metadata,
			startedAt: workAttempts.startedAt,
			finishedAt: workAttempts.finishedAt,
			workItemVersion: workAdmissions.workItemVersion,
		})
		.from(workAttempts)
		.innerJoin(
			workAdmissions,
			and(
				eq(workAdmissions.id, workAttempts.admissionId),
				eq(workAdmissions.orgId, workAttempts.orgId),
			),
		)
		.where(
			and(
				eq(workAttempts.orgId, item.orgId),
				eq(workAttempts.workItemId, item.id),
			),
		)
		.orderBy(desc(workAttempts.attemptNumber))
		.limit(FAILURES_BEFORE_WAIT + 2);
	const failed = failedAttemptsWait(attempts, item.version, now);
	if (failed) return failed;
	const latest = attempts[0];
	const result = latest?.metadata.laneResult;
	if (
		!latest ||
		latest.outcome !== "cancelled" ||
		!latest.finishedAt ||
		latest.workItemVersion !== item.version ||
		!result ||
		typeof result !== "object" ||
		Array.isArray(result) ||
		result.outcome !== "deferred" ||
		typeof result.reason !== "string"
	)
		return;
	const reason = result.reason.trim().replace(/\s+/g, " ");
	if (!reason) return;
	// Progress notes and runner heartbeats must not wake the task. Decisions,
	// dependency edits and approval changes do, even without a Work revision.
	const [change] = await db.select({
		at: sql<string | null>`max(at)`.as("deferral_change_at"),
	}).from(sql`(
		SELECT json_extract(metadata, '$.decisionContinuation.at') AS at FROM work_items WHERE org_id=${item.orgId} AND id=${item.id}
		UNION ALL SELECT max(coalesce(d.updated_at, d.created_at), r.created_at) FROM work_item_relations r JOIN work_items d ON d.org_id=r.org_id AND d.id=r.from_work_item_id WHERE r.org_id=${item.orgId} AND r.to_work_item_id=${item.id} AND r.relation_type='blocks'
		UNION ALL SELECT max(created_at, coalesce(resolved_at, created_at)) FROM work_approval_proposals WHERE org_id=${item.orgId} AND work_item_id=${item.id}
	)`);
	const changedAt = change?.at ?? "";
	if (changedAt > latest.startedAt) return;
	// Free-form explanations can paraphrase the same blocker on every run.
	// Only a relevant state change resets consecutive deferred Attempts.
	let count = 0;
	for (const attempt of attempts) {
		const previous = attempt.metadata.laneResult;
		if (
			attempt.outcome !== "cancelled" ||
			attempt.workItemVersion !== item.version ||
			attempt.startedAt < changedAt ||
			!previous ||
			typeof previous !== "object" ||
			Array.isArray(previous) ||
			previous.outcome !== "deferred" ||
			typeof previous.reason !== "string" ||
			!previous.reason.trim()
		)
			break;
		count++;
	}
	const hours = count <= 1 ? 1 : count === 2 ? 4 : 24;
	const declared =
		typeof result.notBefore === "string" ? result.notBefore : result.until;
	const declaredAt = typeof declared === "string" ? Date.parse(declared) : NaN;
	const retryAt =
		count <= 1 && Number.isFinite(declaredAt)
			? declaredAt
			: Math.max(
					Date.parse(latest.finishedAt) + hours * 3_600_000,
					Number.isFinite(declaredAt) ? declaredAt : 0,
				);
	if (retryAt <= Date.parse(now)) return;
	return `Deferred${count > 1 ? ` ${count} times without a task, dependency or approval change` : ""}: ${reason.slice(0, 1700)}. Recheck at ${new Date(retryAt).toISOString()}; task, dependency or approval changes wake it sooner.`;
}
