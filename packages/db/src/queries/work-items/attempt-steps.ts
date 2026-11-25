import { and, asc, desc, eq, gt, inArray, isNull, or, sql } from "drizzle-orm";
import type { DbQueryClient } from "../../query-client";
import { externalAgentSessions } from "../../schema/external-agent-identity";
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
	workItems,
} from "../../schema/work-items";
import { getAuthoritativeWorkItemAttempt } from "./attempts";
import {
	ACTIVE_ATTEMPT_STATES,
	WorkFactoryError,
	type WorkExecutor,
} from "./factory-state";

/** Nine bound values per step row; D1 allows 100 per statement. */
const STEP_INSERT_CHUNK = 11;
const MESSAGE_LIST_LIMIT = 200;
/**
 * `attempt_id` of a follow-up sent before the Work Item's first Attempt. The
 * first runner to report steps takes these rows over as its own.
 */
const BEFORE_FIRST_ATTEMPT = "";

export interface AppendWorkAttemptStepsParams {
	orgId: string;
	workItemId: string;
	attemptId: string;
	executor: WorkExecutor;
	sessionId?: string;
	externalSessionKey?: string;
	steps: {
		seq: number;
		at: number;
		kind: WorkAttemptStepKind;
		text: string;
		choices?: string[];
	}[];
	appliedMessageIds?: string[];
	at?: string;
}

export interface AppendWorkAttemptStepsResult {
	accepted: number;
	/** The `seq` of every step this call stored; a retried step is not in it. */
	acceptedSeqs: number[];
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
 * expired or failed Attempts on this Work Item come along. Follow-ups sent
 * before the Work Item had an Attempt become this Attempt's messages here.
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

	if (params.steps.some((step) => step.kind === "question"))
		throw new WorkFactoryError(
			"NOT_READY",
			"Ask through a canonical Work Interaction, not a run step",
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
		choices:
			step.kind === "question" && step.choices?.length ? step.choices : null,
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
				.returning({
					stepId: workAttemptSteps.id,
					stepSeq: workAttemptSteps.seq,
				}),
		);
	}
	const attemptMessages = and(
		eq(workAttemptMessages.orgId, params.orgId),
		eq(workAttemptMessages.workItemId, params.workItemId),
		params.externalSessionKey
			? // bound-params: a fixed-size subquery
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
	// Runs first, so the statements below see these rows as this Attempt's.
	const adoptWaiting = db
		.update(workAttemptMessages)
		.set({ attemptId: params.attemptId })
		.where(
			and(
				eq(workAttemptMessages.orgId, params.orgId),
				eq(workAttemptMessages.workItemId, params.workItemId),
				eq(workAttemptMessages.attemptId, BEFORE_FIRST_ATTEMPT),
			),
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

	const [, , pending, ...inserted] = await db.batch([
		adoptWaiting,
		markApplied,
		handOver,
		...inserts,
	]);
	const acceptedSeqs = inserted.flatMap((result) =>
		result.map((row) => row.stepSeq),
	);
	return {
		accepted: acceptedSeqs.length,
		acceptedSeqs,
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
	/** How the Attempt ended; null while it has not, or when there is none. */
	outcome: WorkAttempt["outcome"];
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
		const messages = await db
			.select()
			.from(workAttemptMessages)
			.where(
				and(
					eq(workAttemptMessages.attemptId, BEFORE_FIRST_ATTEMPT),
					eq(workAttemptMessages.orgId, params.orgId),
					eq(workAttemptMessages.workItemId, params.workItemId),
				),
			)
			.orderBy(asc(workAttemptMessages.createdAt), asc(workAttemptMessages.id))
			.limit(MESSAGE_LIST_LIMIT);
		return {
			attemptId: null,
			live: false,
			outcome: null,
			steps: [],
			messages,
		};
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
		outcome: attempt.outcome,
		steps,
		messages,
	};
}

export interface SendWorkAttemptMessageParams {
	orgId: string;
	workItemId: string;
	attemptId?: string;
	kind: WorkAttemptMessageKind;
	body: string;
	sender: { type: WorkAttemptMessageSenderType; id: string };
	/** A follow-up that stops the agent's current turn instead of waiting for it. */
	interrupt?: boolean;
	at?: string;
}

/**
 * Store a follow-up for an accepted Work Item that has no Attempt yet. The
 * runner receives it with its first step report. Null when the Work Item is
 * not accepted or already has an Attempt.
 */
export async function queueWorkItemFollowUp(
	db: DbQueryClient,
	params: Pick<
		SendWorkAttemptMessageParams,
		"orgId" | "workItemId" | "body" | "sender" | "at"
	>,
): Promise<WorkAttemptMessageRow | null> {
	const [message] = await db
		.insert(workAttemptMessages)
		.select(
			db
				.select({
					id: sql<string>`${crypto.randomUUID()}`.as("message_id"),
					orgId: workItems.orgId,
					workItemId: workItems.id,
					attemptId: sql<string>`${BEFORE_FIRST_ATTEMPT}`.as("attempt_id"),
					kind: sql<WorkAttemptMessageKind>`'follow_up'`.as("message_kind"),
					body: sql<string>`${params.body}`.as("message_body"),
					senderType:
						sql<WorkAttemptMessageSenderType>`${params.sender.type}`.as(
							"sender_type",
						),
					senderId: sql<string>`${params.sender.id}`.as("sender_id"),
					interrupt: sql<boolean>`0`.as("interrupt"),
					createdAt: sql<string>`${params.at ?? new Date().toISOString()}`.as(
						"message_created_at",
					),
					deliveredAt: sql<null>`NULL`.as("delivered_at"),
					appliedAt: sql<null>`NULL`.as("applied_at"),
				})
				.from(workItems)
				.where(
					and(
						eq(workItems.id, params.workItemId),
						eq(workItems.orgId, params.orgId),
						eq(workItems.disposition, "accepted"),
						sql`NOT EXISTS (
							SELECT 1 FROM work_attempts first
							WHERE first.work_item_id = ${workItems.id}
							AND first.org_id = ${workItems.orgId}
						)`,
					),
				),
		)
		.returning();
	return message ?? null;
}

/** Queue steering on the newest live run. Answers belong to Work Interactions. */
export async function sendWorkAttemptMessage(
	db: DbQueryClient,
	params: SendWorkAttemptMessageParams,
): Promise<WorkAttemptMessageRow | null> {
	const at = params.at ?? new Date().toISOString();
	const id = crypto.randomUUID();
	const interrupt = params.kind === "follow_up" && params.interrupt === true;
	const live = sql`${workAttempts.outcome} IS NULL
		AND ${inArray(workAttempts.runtimeState, ACTIVE_ATTEMPT_STATES)}
		AND ${workAttempts.expiresAt} > ${at}`;
	const insert = db
		.insert(workAttemptMessages)
		.select(
			db
				.select({
					id: sql<string>`${id}`.as("message_id"),
					orgId: workAttempts.orgId,
					workItemId: workAttempts.workItemId,
					attemptId: workAttempts.id,
					kind: sql<WorkAttemptMessageKind>`${params.kind}`.as("message_kind"),
					body: sql<string>`${params.body}`.as("message_body"),
					senderType:
						sql<WorkAttemptMessageSenderType>`${params.sender.type}`.as(
							"sender_type",
						),
					senderId: sql<string>`${params.sender.id}`.as("sender_id"),
					interrupt: sql<boolean>`${interrupt}`.as("interrupt"),
					createdAt: sql<string>`${at}`.as("message_created_at"),
					deliveredAt: sql<null>`NULL`.as("delivered_at"),
					appliedAt: sql<null>`NULL`.as("applied_at"),
				})
				.from(workAttempts)
				.innerJoin(
					workItems,
					and(
						eq(workItems.id, workAttempts.workItemId),
						eq(workItems.orgId, workAttempts.orgId),
					),
				)
				.where(
					and(
						eq(workAttempts.orgId, params.orgId),
						eq(workAttempts.workItemId, params.workItemId),
						params.attemptId
							? eq(workAttempts.id, params.attemptId)
							: undefined,
						sql`NOT EXISTS (
					SELECT 1 FROM work_attempts successor
					WHERE successor.work_item_id = ${workAttempts.workItemId}
					AND successor.org_id = ${workAttempts.orgId}
					AND successor.attempt_number > ${workAttempts.attemptNumber}
				)`,
						interrupt
							? sql`(${live} AND NOT EXISTS (
							SELECT 1 FROM ${workAttemptMessages}
							WHERE ${workAttemptMessages.attemptId} = ${workAttempts.id}
							AND ${workAttemptMessages.kind} = 'stop'
						))`
							: live,
					),
				),
		)
		.returning();

	return (await insert)[0] ?? null;
}

/**
 * Runs in progress in an organization, newest first: each Attempt that is
 * live by {@link isWorkAttemptLive} with its Work Item and its newest step.
 * An Attempt whose lease ran out without a settlement is left out, so a run
 * whose runner went away does not show as running. Live Attempts are few;
 * two reads after the first, with no join over Attempt history.
 */
export async function listLiveWorkRuns(
	db: DbQueryClient,
	params: {
		orgId: string;
		projectIds?: string[] | null;
		at?: string;
		limit?: number;
	},
) {
	const at = params.at ?? new Date().toISOString();
	const limit = Math.min(Math.max(Math.trunc(params.limit ?? 50), 1), 50);
	const candidates = await db
		.select({
			attemptId: workAttempts.id,
			workItemId: workAttempts.workItemId,
			runtimeState: workAttempts.runtimeState,
			attemptExecutorType: workAttempts.executorType,
			attemptExecutorId: workAttempts.executorId,
			executorSessionId: workAttempts.executorSessionId,
			externalSessionKey: workAttempts.externalSessionKey,
			verifiedSessionId: sql<string>`${externalAgentSessions.id}`.as(
				"verified_session_id",
			),
			harness: externalAgentSessions.harness,
			harnessVersion: externalAgentSessions.harnessVersion,
			expiresAt: workAttempts.expiresAt,
			startedAt: workAttempts.startedAt,
			heartbeatAt: workAttempts.heartbeatAt,
		})
		.from(workAttempts)
		.leftJoin(
			externalAgentSessions,
			and(
				eq(workAttempts.executorType, "external_agent"),
				eq(externalAgentSessions.id, workAttempts.executorSessionId),
				eq(externalAgentSessions.organizationId, workAttempts.orgId),
				eq(externalAgentSessions.principalId, workAttempts.executorId),
				eq(
					externalAgentSessions.externalSessionKey,
					workAttempts.externalSessionKey,
				),
			),
		)
		.where(
			and(
				eq(workAttempts.orgId, params.orgId),
				inArray(workAttempts.runtimeState, [...ACTIVE_ATTEMPT_STATES]),
				isNull(workAttempts.outcome),
				gt(workAttempts.expiresAt, at),
				// Apply chat visibility before the limit; hidden projects cannot crowd out visible runs.
				sql`EXISTS (SELECT 1 FROM ${workItems} WHERE ${workItems.id} = ${workAttempts.workItemId} AND ${workItems.orgId} = ${params.orgId} ${params.projectIds == null ? sql`` : sql`AND ${workItems.projectId} IN (SELECT value FROM json_each(${JSON.stringify(params.projectIds)}))`})`,
			),
		)
		// See listLiveWorkAttemptHolders: `+started_at` keeps the planner on
		// the state index instead of walking every Attempt by start time.
		.orderBy(sql`+${workAttempts.startedAt} desc`, desc(workAttempts.id))
		.limit(limit + 1);
	const complete = candidates.length <= limit;
	const attempts = candidates.slice(0, limit);
	if (attempts.length === 0) return { complete, limit, runs: [] };
	const [items, steps] = await db.batch([
		db
			.select({
				id: workItems.id,
				title: workItems.title,
				projectId: workItems.projectId,
				itemExecutorId: workItems.executorId,
				accountableOwnerType: workItems.accountableOwnerType,
				accountableOwnerId: workItems.accountableOwnerId,
				sourceSessionKey: workItems.sourceSessionKey,
			})
			.from(workItems)
			.where(
				and(
					eq(workItems.orgId, params.orgId),
					// bound-params: at most 50 Attempts, the limit of the read above.
					inArray(
						workItems.id,
						attempts.map((attempt) => attempt.workItemId),
					),
				),
			),
		db
			.select({
				stepAttemptId: workAttemptSteps.attemptId,
				stepAt: workAttemptSteps.at,
				stepKind: workAttemptSteps.kind,
				stepText: workAttemptSteps.text,
			})
			.from(workAttemptSteps)
			.where(
				and(
					eq(workAttemptSteps.orgId, params.orgId),
					// bound-params: at most 50 Attempts, the limit of the read above.
					inArray(
						workAttemptSteps.attemptId,
						attempts.map((attempt) => attempt.attemptId),
					),
					eq(
						workAttemptSteps.seq,
						sql`(SELECT max(newest.seq) FROM work_attempt_steps newest WHERE newest.attempt_id = ${workAttemptSteps.attemptId})`,
					),
				),
			),
	]);
	const byId = new Map(items.map((item) => [item.id, item]));
	const lastStep = new Map(steps.map((step) => [step.stepAttemptId, step]));
	const runs = attempts.flatMap((attempt) => {
		const item = byId.get(attempt.workItemId);
		if (!item) return [];
		const step = lastStep.get(attempt.attemptId);
		return [
			{
				...attempt,
				title: item.title,
				projectId: item.projectId,
				itemExecutorId: item.itemExecutorId,
				accountableOwnerType: item.accountableOwnerType,
				accountableOwnerId: item.accountableOwnerId,
				sourceSessionKey: item.sourceSessionKey,
				lastStep: step
					? { at: step.stepAt, kind: step.stepKind, text: step.stepText }
					: null,
			},
		];
	});
	return { complete, limit, runs };
}
