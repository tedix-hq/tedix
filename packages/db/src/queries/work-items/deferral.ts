import { and, eq, lte, sql, type SQL } from "drizzle-orm";
import { isRecord } from "@tedix/api-contract/utils/is-record";
import type { DbQueryClient } from "../../query-client";
import { coreTable } from "../../core-store/client";
import { anyIds, coreStore, jsonRead } from "../../core-store/dialect";
import {
	type WorkItem,
	workAttempts as d1WorkAttempts,
	workItems as d1WorkItems,
} from "../../schema/work-items";
import { workAdmissions as d1WorkAdmissions } from "../../schema/work-factory";

/** From this many failed Attempts in a row, the task waits before the next one. */
const FAILURES_BEFORE_WAIT = 4;

/** SQLite's two-argument max(); Postgres spells it greatest(). */
function latestOf(db: DbQueryClient, a: SQL, b: SQL): SQL {
	return coreStore(db) === "postgres"
		? sql`greatest(${a}, ${b})`
		: sql`max(${a}, ${b})`;
}

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

const RUN_ANSWER_MESSAGE_ID_RE =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The wait a run leaves when it ends on a question: the newest Attempt for this
 * Work version settled `cancelled` carrying a `runQuestion`, and no answer was
 * recorded in `questionContinuation`. This mirrors the dispatcher's
 * `runQuestionAnswer` check so readiness names the same wait the lane enforces
 * instead of reporting the item ready while the dispatcher skips it.
 */
export function unansweredRunQuestionWait(
	item: Pick<WorkItem, "version" | "metadata">,
	attempt: {
		id: string;
		outcome: string | null;
		metadata: unknown;
		workItemVersion: number;
	},
): string | undefined {
	if (
		attempt.outcome !== "cancelled" ||
		attempt.workItemVersion !== item.version ||
		!isRecord(attempt.metadata) ||
		!isRecord(attempt.metadata.runQuestion) ||
		attempt.metadata.dispatchVersion !== item.version
	)
		return;
	const continuation = isRecord(item.metadata)
		? item.metadata.questionContinuation
		: undefined;
	if (
		isRecord(continuation) &&
		continuation.attemptId === attempt.id &&
		typeof continuation.messageId === "string" &&
		RUN_ANSWER_MESSAGE_ID_RE.test(continuation.messageId)
	)
		return;
	const question = attempt.metadata.runQuestion;
	const text =
		typeof question.text === "string"
			? question.text.trim().replace(/\s+/g, " ").slice(0, 300)
			: "";
	return `Waiting for an answer to the run's question${text ? `: "${text}"` : ""}. This ended run cannot accept answer messages. An organization owner/admin or the item's tedi owner/steward must record the answer in the Work description with update_work_item. The revised task can start a fresh Attempt; a Work comment alone does not resume it.`;
}

/** Six newest admitted Attempts per Work, suitable for a readiness batch. */
export function buildWorkDeferralHistoryStatement(
	db: DbQueryClient,
	orgId: string,
	workItemIds: string[],
) {
	const workAttempts = coreTable(db, d1WorkAttempts);
	const workAdmissions = coreTable(db, d1WorkAdmissions);
	const ranked = db.$with("readiness_attempt_history").as(
		db
			.select({
				id: workAttempts.id,
				workItemId: workAttempts.workItemId,
				rank: sql<number>`row_number() OVER (PARTITION BY ${workAttempts.workItemId} ORDER BY ${workAttempts.attemptNumber} DESC)`.as(
					"attempt_history_rank",
				),
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
					eq(workAttempts.orgId, orgId),
					anyIds(db, workAttempts.workItemId, workItemIds),
				),
			),
	);
	return db
		.with(ranked)
		.select()
		.from(ranked)
		.where(lte(ranked.rank, FAILURES_BEFORE_WAIT + 2))
		.orderBy(ranked.workItemId, ranked.rank);
}

export function workDeferralChangedAt(
	db: DbQueryClient,
	item: Pick<WorkItem, "orgId" | "id"> | typeof d1WorkItems,
) {
	return sql<string | null>`${sql`(SELECT max(at) FROM (
		SELECT ${jsonRead(db, sql`deferred_item.metadata`, ["decisionContinuation", "at"])} AS at FROM work_items deferred_item WHERE deferred_item.org_id=${item.orgId} AND deferred_item.id=${item.id}
		UNION ALL SELECT ${latestOf(db, sql`coalesce(d.updated_at, d.created_at)`, sql`r.created_at`)} FROM work_item_relations r JOIN work_items d ON d.org_id=r.org_id AND d.id=r.from_work_item_id WHERE r.org_id=${item.orgId} AND r.to_work_item_id=${item.id} AND r.relation_type='blocks'
		UNION ALL SELECT ${latestOf(db, sql`created_at`, sql`coalesce(resolved_at, created_at)`)} FROM work_approval_proposals WHERE org_id=${item.orgId} AND work_item_id=${item.id}
	) changes)`}`;
}

/** Readiness uses durable history, including on runners without local receipts. */
export async function workDeferralWait(
	db: DbQueryClient,
	item: WorkItem,
	now: string,
): Promise<string | undefined> {
	const attempts = await buildWorkDeferralHistoryStatement(db, item.orgId, [
		item.id,
	]);
	return evaluateWorkDeferralWait(item, now, attempts, async () => {
		const [change] = await db
			.select({
				at: workDeferralChangedAt(db, item).as("deferral_change_at"),
			})
			.from(sql`(SELECT 1) AS deferral_change`);
		return change?.at ?? "";
	});
}

export async function evaluateWorkDeferralWait(
	item: WorkItem,
	now: string,
	attempts: Awaited<ReturnType<typeof buildWorkDeferralHistoryStatement>>,
	getChangedAt: () => Promise<string>,
): Promise<string | undefined> {
	const failed = failedAttemptsWait(attempts, item.version, now);
	if (failed) return failed;
	const latest = attempts[0];
	const questionWait = latest
		? unansweredRunQuestionWait(item, latest)
		: undefined;
	if (questionWait) return questionWait;
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
	// Only decisions, dependency edits and approval changes wake a deferred run.
	const changedAt = await getChangedAt();
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
