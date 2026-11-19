import { and, asc, desc, eq, gt, inArray, isNull, or, sql } from "drizzle-orm";
import type { DbQueryClient } from "../../query-client";
import {
	type WorkAttempt,
	type WorkAttemptMessageKind,
	type WorkAttemptMessageRow,
	type WorkAttemptMessageSenderType,
	type WorkAttemptStepKind,
	type WorkAttemptStepRow,
	workAttemptMessages,
	workAttemptSteps,
	workAttempts,
} from "../../schema/work-items";
import { getAuthoritativeWorkItemAttempt } from "./attempts";
import {
	ACTIVE_ATTEMPT_STATES,
	WorkFactoryError,
	type WorkExecutor,
} from "./factory-state";

/** Eight bound values per step row; D1 allows 100 per statement. */
const STEP_INSERT_CHUNK = 12;
const MESSAGE_LIST_LIMIT = 200;

export interface AppendWorkAttemptStepsParams {
	orgId: string;
	workItemId: string;
	attemptId: string;
	executor: WorkExecutor;
	sessionId?: string;
	externalSessionKey?: string;
	steps: { seq: number; at: number; kind: WorkAttemptStepKind; text: string }[];
	appliedMessageIds?: string[];
	at?: string;
}

export interface AppendWorkAttemptStepsResult {
	accepted: number;
	pending: WorkAttemptMessageRow[];
}

/** A run is live while its Attempt has no outcome and its lease has not expired. */
export function isWorkAttemptLive(
	attempt: Pick<WorkAttempt, "runtimeState" | "outcome" | "expiresAt">,
	at: string,
): boolean {
	return (
		attempt.outcome === null &&
		(ACTIVE_ATTEMPT_STATES as readonly string[]).includes(
			attempt.runtimeState,
		) &&
		attempt.expiresAt !== null &&
		attempt.expiresAt > at
	);
}

/**
 * Store the steps a runner reports and hand it the messages waiting for its
 * run. Only the runner holding the Attempt may call this: a stale or foreign
 * Attempt is refused with STALE_ATTEMPT, as for a heartbeat. A step whose
 * `seq` is already stored is ignored, so a retry is safe.
 *
 * `pending` holds every message the runner has not yet reported as applied,
 * whether or not an earlier answer already carried it: a lost answer or a
 * restarted runner gets it again, and the runner tells them apart by id. The
 * first hand-over sets `delivered_at`. When the same agent session resumes
 * under a fresh Attempt after an interruption, the unapplied messages of its
 * expired or failed Attempts on this Work Item come along.
 */
export async function appendWorkAttemptSteps(
	db: DbQueryClient,
	params: AppendWorkAttemptStepsParams,
): Promise<AppendWorkAttemptStepsResult> {
	const at = params.at ?? new Date().toISOString();
	const attempt = await getAuthoritativeWorkItemAttempt(db, {
		orgId: params.orgId,
		workItemId: params.workItemId,
		attemptId: params.attemptId,
		executor: params.executor,
		sessionId: params.sessionId,
		externalSessionKey: params.externalSessionKey,
		at,
	});
	if (
		(attempt.executorSessionId ?? undefined) !== params.sessionId ||
		(attempt.externalSessionKey ?? undefined) !== params.externalSessionKey
	)
		throw new WorkFactoryError(
			"STALE_ATTEMPT",
			`Attempt ${params.attemptId} is no longer authoritative`,
		);

	const rows = params.steps.map((step) => ({
		id: crypto.randomUUID(),
		orgId: params.orgId,
		workItemId: params.workItemId,
		attemptId: params.attemptId,
		seq: step.seq,
		at: step.at,
		kind: step.kind,
		text: step.text,
	}));
	const inserts = [];
	for (let index = 0; index < rows.length; index += STEP_INSERT_CHUNK) {
		inserts.push(
			db
				.insert(workAttemptSteps)
				.values(rows.slice(index, index + STEP_INSERT_CHUNK))
				.onConflictDoNothing({
					target: [workAttemptSteps.attemptId, workAttemptSteps.seq],
				})
				.returning({ stepId: workAttemptSteps.id }),
		);
	}
	const attemptMessages = and(
		eq(workAttemptMessages.orgId, params.orgId),
		eq(workAttemptMessages.workItemId, params.workItemId),
		params.externalSessionKey
			? // bound-params: a subquery with six bound values, not a caller list
				inArray(
					workAttemptMessages.attemptId,
					db
						.select({ runAttemptId: workAttempts.id })
						.from(workAttempts)
						.where(
							and(
								eq(workAttempts.orgId, params.orgId),
								eq(workAttempts.workItemId, params.workItemId),
								or(
									eq(workAttempts.id, params.attemptId),
									and(
										eq(
											workAttempts.externalSessionKey,
											params.externalSessionKey,
										),
										inArray(workAttempts.outcome, ["expired", "failed"]),
									),
								),
							),
						),
				)
			: eq(workAttemptMessages.attemptId, params.attemptId),
	);
	const appliedIds = [...new Set(params.appliedMessageIds ?? [])];
	const markApplied = db
		.update(workAttemptMessages)
		.set({ appliedAt: at })
		.where(
			and(
				attemptMessages,
				isNull(workAttemptMessages.appliedAt),
				// An empty list matches no row; the statement stays in the batch
				// so its shape does not depend on the input.
				inArray(workAttemptMessages.id, appliedIds),
			),
		)
		.returning({ appliedId: workAttemptMessages.id });
	// Runs after markApplied, so a message acknowledged in this call is not
	// handed over again.
	const handOver = db
		.update(workAttemptMessages)
		.set({
			deliveredAt: sql`coalesce(${workAttemptMessages.deliveredAt}, ${at})`,
		})
		.where(and(attemptMessages, isNull(workAttemptMessages.appliedAt)))
		.returning();

	const [, pending, ...inserted] = await db.batch([
		markApplied,
		handOver,
		...inserts,
	]);
	return {
		accepted: inserted.reduce((count, result) => count + result.length, 0),
		pending: [...pending].sort(
			(a, b) =>
				a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
		),
	};
}

async function findWorkAttemptForSteps(
	db: DbQueryClient,
	params: { orgId: string; workItemId: string; attemptId?: string },
): Promise<WorkAttempt | null> {
	const [attempt] = await db
		.select()
		.from(workAttempts)
		.where(
			and(
				eq(workAttempts.orgId, params.orgId),
				eq(workAttempts.workItemId, params.workItemId),
				params.attemptId ? eq(workAttempts.id, params.attemptId) : undefined,
			),
		)
		.orderBy(desc(workAttempts.attemptNumber))
		.limit(1);
	return attempt ?? null;
}

export interface ListWorkAttemptStepsParams {
	orgId: string;
	workItemId: string;
	/** Omitted, the newest Attempt of the Work Item is used. */
	attemptId?: string;
	afterSeq?: number;
	limit?: number;
	at?: string;
}

export interface ListWorkAttemptStepsResult {
	attemptId: string | null;
	live: boolean;
	steps: WorkAttemptStepRow[];
	messages: WorkAttemptMessageRow[];
}

/** Steps of one run, oldest first, with the messages sent to it. */
export async function listWorkAttemptSteps(
	db: DbQueryClient,
	params: ListWorkAttemptStepsParams,
): Promise<ListWorkAttemptStepsResult> {
	const at = params.at ?? new Date().toISOString();
	const attempt = await findWorkAttemptForSteps(db, params);
	if (!attempt) {
		if (params.attemptId)
			throw new WorkFactoryError(
				"NOT_FOUND",
				`Attempt ${params.attemptId} was not found on this Work Item`,
			);
		return { attemptId: null, live: false, steps: [], messages: [] };
	}
	const limit = Math.min(Math.max(1, Math.trunc(params.limit ?? 200)), 500);
	const [steps, messages] = await db.batch([
		db
			.select()
			.from(workAttemptSteps)
			.where(
				and(
					eq(workAttemptSteps.workItemId, params.workItemId),
					eq(workAttemptSteps.attemptId, attempt.id),
					eq(workAttemptSteps.orgId, params.orgId),
					params.afterSeq === undefined
						? undefined
						: gt(workAttemptSteps.seq, params.afterSeq),
				),
			)
			.orderBy(asc(workAttemptSteps.seq))
			.limit(limit),
		db
			.select()
			.from(workAttemptMessages)
			.where(
				and(
					eq(workAttemptMessages.attemptId, attempt.id),
					eq(workAttemptMessages.orgId, params.orgId),
					eq(workAttemptMessages.workItemId, params.workItemId),
				),
			)
			.orderBy(asc(workAttemptMessages.createdAt), asc(workAttemptMessages.id))
			.limit(MESSAGE_LIST_LIMIT),
	]);
	return {
		attemptId: attempt.id,
		live: isWorkAttemptLive(attempt, at),
		steps,
		messages,
	};
}

export interface SendWorkAttemptMessageParams {
	orgId: string;
	workItemId: string;
	kind: WorkAttemptMessageKind;
	body: string;
	sender: { type: WorkAttemptMessageSenderType; id: string };
	/** A follow-up that stops the agent's current turn instead of waiting for it. */
	interrupt?: boolean;
	at?: string;
}

/**
 * Queue a follow-up or a stop for the run in progress on a Work Item. Returns
 * null when no run is in progress; the runner picks the message up with its
 * next step report.
 */
export async function sendWorkAttemptMessage(
	db: DbQueryClient,
	params: SendWorkAttemptMessageParams,
): Promise<WorkAttemptMessageRow | null> {
	const at = params.at ?? new Date().toISOString();
	const attempt = await findWorkAttemptForSteps(db, params);
	if (!attempt || !isWorkAttemptLive(attempt, at)) return null;
	const [message] = await db
		.insert(workAttemptMessages)
		.values({
			id: crypto.randomUUID(),
			orgId: params.orgId,
			workItemId: params.workItemId,
			attemptId: attempt.id,
			kind: params.kind,
			body: params.body,
			senderType: params.sender.type,
			senderId: params.sender.id,
			interrupt: params.kind === "follow_up" && params.interrupt === true,
			createdAt: at,
		})
		.returning();
	return message ?? null;
}
