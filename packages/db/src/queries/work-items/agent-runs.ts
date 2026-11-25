/**
 * The agent runs a tedi started from a chat: Work Items it stewards that are
 * assigned to an external agent and carry the conversation they came from.
 * One read gives each run's state, its newest step and the messages still
 * waiting, so a tedi can supervise several runs without reading each log.
 */

import {
	and,
	desc,
	eq,
	gt,
	inArray,
	isNotNull,
	isNull,
	or,
	sql,
} from "drizzle-orm";
import type { JsonValue } from "@tedix/api-contract/schemas/common";
import type { DbQueryClient } from "../../query-client";
import { tedis } from "../../schema/tedis";
import { workAdmissions } from "../../schema/work-factory";
import {
	type WorkAttempt,
	type WorkAttemptMessageRow,
	type WorkAttemptStepRow,
	type WorkItem,
	workAttemptMessages,
	workAttemptSteps,
	workAttempts,
	workItems,
} from "../../schema/work-items";
import { isWorkAttemptLive } from "./attempt-steps";

/** `metadata.source` of a Work Item that `start_agent_run` created. */
export const AGENT_RUN_SOURCE = "tedi.start_agent_run";
/** `metadata.source` of a run a person started in workspace chat. */
export const WORKSPACE_RUN_SOURCE = "os.workspace.start_run";
/** Runs started longer ago than this are not listed. */
export const AGENT_RUN_LIST_WINDOW_DAYS = 30;
/** Newest Work Items examined before the state filter is applied. */
const CANDIDATE_LIMIT = 200;
const ID_CHUNK = 50;

export type AgentRunState = "waiting_for_runner" | "running" | "ended";

export type AgentRunWorkItem = Pick<
	WorkItem,
	| "id"
	| "orgId"
	| "title"
	| "disposition"
	| "executorId"
	| "dispatchState"
	| "stewardId"
	| "sourceSessionKey"
	| "projectId"
	| "createdAt"
	| "metadata"
>;

export type AgentRunAttempt = Pick<
	WorkAttempt,
	| "id"
	| "workItemId"
	| "runtimeState"
	| "outcome"
	| "attemptNumber"
	| "startedAt"
	| "heartbeatAt"
	| "expiresAt"
	| "finishedAt"
	| "summary"
>;

export interface AgentRunRow {
	workItem: AgentRunWorkItem;
	state: AgentRunState;
	/** The newest Attempt; null while no runner has picked the task up. */
	attempt: AgentRunAttempt | null;
	attemptCount: number;
	lastStep: Pick<WorkAttemptStepRow, "seq" | "at" | "kind" | "text"> | null;
	/** Follow-ups sent to the newest Attempt that the runner has not applied. */
	pendingFollowUps: number;
	/**
	 * The newest refusal the platform recorded when a runner tried to start a
	 * run that is still waiting; null once a later start was admitted.
	 */
	refusedStart: { code: string; reason: string; decidedAt: string } | null;
	/** The newest stop sent to the newest Attempt, when there is one. */
	stop: Pick<
		WorkAttemptMessageRow,
		"senderType" | "senderId" | "createdAt"
	> | null;
}

/**
 * `running` while the newest Attempt holds a live lease. `ended` once the Work
 * Item is closed or its newest Attempt was settled. Everything else waits for
 * a runner: no Attempt yet, or one whose lease ran out without a settlement,
 * which a runner may still resume.
 */
export function agentRunState(
	workItem: Pick<WorkItem, "disposition">,
	attempt: Pick<WorkAttempt, "runtimeState" | "outcome" | "expiresAt"> | null,
	at: string,
): AgentRunState {
	if (attempt && isWorkAttemptLive(attempt, at)) return "running";
	if (
		workItem.disposition === "completed" ||
		workItem.disposition === "cancelled"
	)
		return "ended";
	if (!attempt || attempt.outcome === null || attempt.outcome === "expired")
		return "waiting_for_runner";
	return "ended";
}

export interface ListAgentRunsParams {
	orgId: string;
	/** Only runs this tedi stewards; omitted, the runs of every tedi. */
	stewardTediId?: string;
	state?: "live" | "ended" | "all";
	limit?: number;
	at?: string;
}

/** Newest first. `live` is every run that has not ended. */
export async function listAgentRuns(
	db: DbQueryClient,
	params: ListAgentRunsParams,
): Promise<AgentRunRow[]> {
	const at = params.at ?? new Date().toISOString();
	const limit = Math.min(Math.max(1, Math.trunc(params.limit ?? 20)), 50);
	const wanted = params.state ?? "live";
	const since = new Date(
		Date.parse(at) - AGENT_RUN_LIST_WINDOW_DAYS * 86_400_000,
	).toISOString();
	const candidates: AgentRunWorkItem[] = await db
		.select({
			id: workItems.id,
			orgId: workItems.orgId,
			title: workItems.title,
			disposition: workItems.disposition,
			executorId: workItems.executorId,
			dispatchState: workItems.dispatchState,
			stewardId: workItems.stewardId,
			sourceSessionKey: workItems.sourceSessionKey,
			projectId: workItems.projectId,
			createdAt: workItems.createdAt,
			metadata: workItems.metadata,
		})
		.from(workItems)
		.where(
			and(
				// Org, source and creation time match idx_work_items_metadata_source.
				eq(workItems.orgId, params.orgId),
				eq(workItems.metadataSource, AGENT_RUN_SOURCE),
				gt(workItems.createdAt, since),
				eq(workItems.executorType, "external_agent"),
				eq(workItems.stewardType, "tedi"),
				params.stewardTediId
					? eq(workItems.stewardId, params.stewardTediId)
					: isNotNull(workItems.stewardId),
				isNotNull(workItems.sourceSessionKey),
			),
		)
		.orderBy(desc(workItems.createdAt), desc(workItems.id))
		.limit(CANDIDATE_LIMIT);
	if (candidates.length === 0) return [];

	const newest = new Map<string, AgentRunAttempt>();
	const attemptCounts = new Map<string, number>();
	for (let offset = 0; offset < candidates.length; offset += ID_CHUNK) {
		const rows = await db
			.select({
				id: workAttempts.id,
				workItemId: workAttempts.workItemId,
				runtimeState: workAttempts.runtimeState,
				outcome: workAttempts.outcome,
				attemptNumber: workAttempts.attemptNumber,
				startedAt: workAttempts.startedAt,
				heartbeatAt: workAttempts.heartbeatAt,
				expiresAt: workAttempts.expiresAt,
				finishedAt: workAttempts.finishedAt,
				summary: workAttempts.summary,
			})
			.from(workAttempts)
			.where(
				and(
					eq(workAttempts.orgId, params.orgId),
					// bound-params: sliced to ID_CHUNK (50) Work Items per statement.
					inArray(
						workAttempts.workItemId,
						candidates.slice(offset, offset + ID_CHUNK).map((item) => item.id),
					),
				),
			);
		for (const row of rows) {
			attemptCounts.set(
				row.workItemId,
				(attemptCounts.get(row.workItemId) ?? 0) + 1,
			);
			const held = newest.get(row.workItemId);
			if (
				!held ||
				row.startedAt > held.startedAt ||
				(row.startedAt === held.startedAt && row.id > held.id)
			)
				newest.set(row.workItemId, row);
		}
	}

	const selected = candidates
		.map((workItem) => {
			const attempt = newest.get(workItem.id) ?? null;
			return { workItem, attempt, state: agentRunState(workItem, attempt, at) };
		})
		.filter(
			(run) =>
				wanted === "all" || (wanted === "ended") === (run.state === "ended"),
		)
		.slice(0, limit);
	const attemptIds = selected.flatMap((run) =>
		run.attempt ? [run.attempt.id] : [],
	);
	const lastSteps = new Map<string, AgentRunRow["lastStep"]>();
	const messages = new Map<string, WorkAttemptMessageRow[]>();
	if (attemptIds.length > 0) {
		const [first, ...rest] = attemptIds.map((attemptId) =>
			db
				.select({
					stepAttemptId: workAttemptSteps.attemptId,
					seq: workAttemptSteps.seq,
					at: workAttemptSteps.at,
					kind: workAttemptSteps.kind,
					text: workAttemptSteps.text,
				})
				.from(workAttemptSteps)
				.where(
					and(
						eq(workAttemptSteps.attemptId, attemptId),
						eq(workAttemptSteps.orgId, params.orgId),
					),
				)
				.orderBy(desc(workAttemptSteps.seq))
				.limit(1),
		);
		for (const [row] of await db.batch([first!, ...rest]))
			if (row) {
				const { stepAttemptId, ...step } = row;
				lastSteps.set(stepAttemptId, step);
			}
		const waiting = await db
			.select()
			.from(workAttemptMessages)
			.where(
				and(
					eq(workAttemptMessages.orgId, params.orgId),
					// bound-params: one Attempt per listed run, and `limit` is at most 50.
					inArray(workAttemptMessages.attemptId, attemptIds),
					or(
						eq(workAttemptMessages.kind, "stop"),
						isNull(workAttemptMessages.appliedAt),
					),
				),
			);
		for (const message of waiting)
			messages.set(message.attemptId, [
				...(messages.get(message.attemptId) ?? []),
				message,
			]);
	}

	const refused = new Map<string, AgentRunRow["refusedStart"]>();
	const waitingIds = selected
		.filter((run) => run.state === "waiting_for_runner")
		.map((run) => run.workItem.id);
	if (waitingIds.length > 0) {
		const [first, ...rest] = waitingIds.map((workItemId) =>
			db
				.select({
					admittedWorkItemId: workAdmissions.workItemId,
					decision: workAdmissions.decision,
					rejectionCode: workAdmissions.rejectionCode,
					rejectionReason: workAdmissions.rejectionReason,
					decidedAt: workAdmissions.decidedAt,
				})
				.from(workAdmissions)
				.where(
					and(
						eq(workAdmissions.orgId, params.orgId),
						eq(workAdmissions.workItemId, workItemId),
					),
				)
				.orderBy(desc(workAdmissions.createdAt))
				.limit(1),
		);
		for (const [row] of await db.batch([first!, ...rest]))
			if (row?.decision === "rejected")
				refused.set(row.admittedWorkItemId, {
					code: row.rejectionCode ?? "rejected",
					reason: row.rejectionReason ?? "",
					decidedAt: row.decidedAt,
				});
	}

	return selected.map(({ workItem, attempt, state }) => {
		const sent = attempt ? (messages.get(attempt.id) ?? []) : [];
		const stop = sent
			.filter((message) => message.kind === "stop")
			.sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
		return {
			workItem,
			state,
			attempt,
			attemptCount: attemptCounts.get(workItem.id) ?? 0,
			lastStep: attempt ? (lastSteps.get(attempt.id) ?? null) : null,
			refusedStart: refused.get(workItem.id) ?? null,
			pendingFollowUps: sent.filter(
				(message) => message.kind === "follow_up" && message.appliedAt === null,
			).length,
			stop: stop
				? {
						senderType: stop.senderType,
						senderId: stop.senderId,
						createdAt: stop.createdAt,
					}
				: null,
		};
	});
}

export interface AgentRunSupervisor {
	orgId: string;
	tediId: string;
	slug: string;
	runtimeOverrides: Record<string, JsonValue> | null;
}

/**
 * Active tedis with an accepted agent run started since `since`. Scheduled
 * dispatch restricts this read to the Work ids claimed from work_due.
 */
export async function listAgentRunSupervisors(
	db: DbQueryClient,
	params: { since: string; limit: number; dueIds?: string[] },
): Promise<AgentRunSupervisor[]> {
	return db
		.select({
			orgId: workItems.orgId,
			tediId: sql<string>`${tedis.id}`.as("supervisor_tedi_id"),
			slug: tedis.slug,
			runtimeOverrides: tedis.runtimeOverrides,
		})
		.from(workItems)
		.innerJoin(
			tedis,
			and(
				eq(tedis.id, workItems.stewardId),
				eq(tedis.organizationId, workItems.orgId),
				eq(tedis.status, "active"),
			),
		)
		.where(
			and(
				eq(workItems.disposition, "accepted"),
				eq(workItems.metadataSource, AGENT_RUN_SOURCE),
				gt(workItems.createdAt, params.since),
				// bound-params: internal selector from claimWorkDue, LIMIT 50.
				params.dueIds ? inArray(workItems.id, params.dueIds) : undefined,
				eq(workItems.executorType, "external_agent"),
				eq(workItems.stewardType, "tedi"),
				isNotNull(workItems.sourceSessionKey),
			),
		)
		.groupBy(workItems.orgId, tedis.id)
		.orderBy(workItems.orgId, tedis.id)
		.limit(params.limit);
}

/** What the last supervision round saw of one run. */
export interface AgentRunSupervisionState {
	/** Rounds this run has caused; capped per run. */
	rounds: number;
	lastRoundAt: string;
	/** The run's fingerprint in the last round's digest. */
	seen: string;
}

const SUPERVISION_KEY = "agentRunSupervision";

export function agentRunSupervisionState(
	metadata: Record<string, JsonValue> | null | undefined,
): AgentRunSupervisionState | null {
	const stored = metadata?.[SUPERVISION_KEY];
	if (!stored || typeof stored !== "object" || Array.isArray(stored))
		return null;
	const { rounds, lastRoundAt, seen } = stored;
	return typeof rounds === "number" &&
		Number.isInteger(rounds) &&
		rounds >= 0 &&
		typeof lastRoundAt === "string" &&
		typeof seen === "string"
		? { rounds, lastRoundAt, seen }
		: null;
}

/**
 * Stores what a supervision round saw of one run. Writes only when the stored
 * round count is still `expectedRounds`, so two ticks that planned the same
 * round count it once. Returns whether this call wrote.
 */
export async function recordAgentRunSupervisionRound(
	db: DbQueryClient,
	params: {
		orgId: string;
		workItemId: string;
		expectedRounds: number;
		state: AgentRunSupervisionState;
	},
): Promise<boolean> {
	const rows = await db
		.update(workItems)
		.set({
			metadata: sql<
				Record<string, JsonValue>
			>`json_set(COALESCE(${workItems.metadata}, '{}'), '$.agentRunSupervision', json(${JSON.stringify(params.state)}))`,
		})
		.where(
			and(
				eq(workItems.orgId, params.orgId),
				eq(workItems.id, params.workItemId),
				sql`COALESCE(json_extract(${workItems.metadata}, '$.agentRunSupervision.rounds'), 0) = ${params.expectedRounds}`,
			),
		)
		.returning({ id: workItems.id });
	return rows.length === 1;
}

/**
 * Marks that the supervising tedi sent the person an update about this run.
 * Returns false, and writes nothing, when the last update is newer than
 * `notBefore`, so a tedi cannot message the person about one run in a loop.
 */
export async function claimAgentRunPersonUpdate(
	db: DbQueryClient,
	params: { orgId: string; workItemId: string; at: string; notBefore: string },
): Promise<boolean> {
	const rows = await db
		.update(workItems)
		.set({
			metadata: sql<
				Record<string, JsonValue>
			>`json_set(COALESCE(${workItems.metadata}, '{}'), '$.agentRunUpdateAt', ${params.at})`,
		})
		.where(
			and(
				eq(workItems.orgId, params.orgId),
				eq(workItems.id, params.workItemId),
				sql`COALESCE(json_extract(${workItems.metadata}, '$.agentRunUpdateAt'), '') < ${params.notBefore}`,
			),
		)
		.returning({ id: workItems.id });
	return rows.length === 1;
}
