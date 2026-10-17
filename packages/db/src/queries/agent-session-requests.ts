/**
 * Request ledger persistence for local agent sessions.
 *
 * Every read and write is scoped to one organization and one user: a row is
 * visible only to the person whose message it came from.
 */

import {
	and,
	asc,
	desc,
	eq,
	gt,
	inArray,
	isNotNull,
	isNull,
	lt,
	notExists,
	or,
	sql,
} from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import type { DbQueryClient } from "../query-client";
import { chunkForBoundParams } from "../utils/batch";
import {
	type AgentSessionEventKind,
	type AgentSessionEventRow,
	agentSessionEvents,
	type AgentSessionRequestKind,
	type AgentSessionRequestRow,
	type AgentSessionRequestStatus,
	agentSessionRequests,
} from "../schema/agent-session-requests";
import type { WorkAgentSessionHarness } from "../schema/work-agent-sessions";

/** Hard ceiling on rows one read returns. */
export const AGENT_SESSION_REQUEST_LIST_LIMIT = 200;
/** Statuses that still need the agent or the person. */
export const AGENT_SESSION_REQUEST_ACTIVE_STATUSES = [
	"open",
	"in_progress",
	"waiting_on_user",
	"dropped_risk",
] as const satisfies readonly AgentSessionRequestStatus[];
/** Rows per multi-row INSERT, under D1's 100 bound parameters. */
const ROWS_PER_INSERT = 5;

export interface AgentSessionRequestOwner {
	organizationId: string;
	userId: string;
}

export interface RecordAgentSessionRequestsParams extends AgentSessionRequestOwner {
	harness: WorkAgentSessionHarness;
	sessionKey: string;
	repository: string | null;
	sourceAt: string;
	/** Stable per message; each request appends its index. */
	sourceKey: string;
	requests: ReadonlyArray<{ kind: AgentSessionRequestKind; text: string }>;
	now: string;
}

/**
 * Record requests as open rows and agent asks as waiting on the user. A repeated message (same source
 * key) records nothing new. Returns the rows that were inserted.
 */
export async function recordAgentSessionRequests(
	db: DbQueryClient,
	params: RecordAgentSessionRequestsParams,
): Promise<AgentSessionRequestRow[]> {
	const rows = params.requests.map((request, index) => ({
		id: crypto.randomUUID(),
		organizationId: params.organizationId,
		userId: params.userId,
		harness: params.harness,
		sessionKey: params.sessionKey,
		repository: params.repository,
		kind: request.kind,
		text: request.text,
		status:
			request.kind === "ask" ? ("waiting_on_user" as const) : ("open" as const),
		evidence: null,
		turnsUnaddressed: 0,
		laneRunning: request.kind === "open_loop",
		sourceAt: params.sourceAt,
		sourceKey: `${params.sourceKey}:${index}`,
		statusChangedAt: params.now,
		createdAt: params.now,
		updatedAt: params.now,
	}));
	const inserted: AgentSessionRequestRow[] = [];
	// 17 bound parameters per row: five rows stay under D1's 100.
	for (const chunk of chunkForBoundParams(rows, ROWS_PER_INSERT))
		inserted.push(
			...(await db
				.insert(agentSessionRequests)
				.values(chunk)
				.onConflictDoNothing({
					target: [
						agentSessionRequests.organizationId,
						agentSessionRequests.userId,
						agentSessionRequests.sourceKey,
					],
				})
				.returning()),
		);
	return inserted;
}

export interface ListAgentSessionRequestsParams extends AgentSessionRequestOwner {
	statuses?: readonly AgentSessionRequestStatus[];
	/** Only this session's rows (both fields required together). */
	harness?: WorkAgentSessionHarness;
	sessionKey?: string;
	limit?: number;
	/** Newest message first, so a bounded read keeps the latest rows. */
	newestFirst?: boolean;
}

/** The caller's own rows, oldest message first, bounded. */
export async function listAgentSessionRequests(
	db: DbQueryClient,
	params: ListAgentSessionRequestsParams,
): Promise<AgentSessionRequestRow[]> {
	return db
		.select()
		.from(agentSessionRequests)
		.where(
			and(
				eq(agentSessionRequests.organizationId, params.organizationId),
				eq(agentSessionRequests.userId, params.userId),
				params.statuses?.length
					? // bound-params: at most the six ledger statuses
						inArray(agentSessionRequests.status, [...params.statuses])
					: undefined,
				params.harness && params.sessionKey
					? and(
							eq(agentSessionRequests.harness, params.harness),
							eq(agentSessionRequests.sessionKey, params.sessionKey),
						)
					: undefined,
			),
		)
		.orderBy(
			(params.newestFirst ? desc : asc)(agentSessionRequests.sourceAt),
			(params.newestFirst ? desc : asc)(agentSessionRequests.sourceKey),
		)
		.limit(
			Math.min(
				params.limit ?? AGENT_SESSION_REQUEST_LIST_LIMIT,
				AGENT_SESSION_REQUEST_LIST_LIMIT,
			),
		);
}

/** Most events one upload may carry. */
export const AGENT_SESSION_EVENT_BATCH_LIMIT = 20;
/** A processing lease older than this may be taken over. */
const EVENT_LEASE_MS = 2 * 60_000;
/** Attempts before an event is left as failed. */
export const AGENT_SESSION_EVENT_MAX_ATTEMPTS = 3;

export interface RecordAgentSessionEventsParams extends AgentSessionRequestOwner {
	events: ReadonlyArray<{
		harness: WorkAgentSessionHarness;
		sessionKey: string;
		repository: string | null;
		kind: AgentSessionEventKind;
		body: string;
		activity: string | null;
		sourceAt: string;
		sourceKey: string;
	}>;
	now: string;
}

/** Store uploaded events as pending; a re-upload is ignored. Returns inserts. */
export async function recordAgentSessionEvents(
	db: DbQueryClient,
	params: RecordAgentSessionEventsParams,
): Promise<number> {
	const rows = params.events.map((event) => ({
		id: crypto.randomUUID(),
		organizationId: params.organizationId,
		userId: params.userId,
		...event,
		status: "pending" as const,
		attempts: 0,
		createdAt: params.now,
	}));
	let inserted = 0;
	// 15 bound parameters per row: five rows stay under D1's 100.
	for (const chunk of chunkForBoundParams(rows, ROWS_PER_INSERT)) {
		const result = await db
			.insert(agentSessionEvents)
			.values(chunk)
			.onConflictDoNothing({
				target: [
					agentSessionEvents.organizationId,
					agentSessionEvents.userId,
					agentSessionEvents.sourceKey,
				],
			})
			.returning({ id: agentSessionEvents.id });
		inserted += result.length;
	}
	return inserted;
}

/** Explicit retries never rewind a session past later completed or leased work. */
export async function retryFailedAgentSessionEvents(
	db: DbQueryClient,
	params: AgentSessionRequestOwner & { sourceKeys: readonly string[] },
): Promise<number> {
	const later = alias(agentSessionEvents, "later_session_event");
	let retried = 0;
	for (const keys of chunkForBoundParams(
		[...params.sourceKeys],
		AGENT_SESSION_EVENT_BATCH_LIMIT,
	)) {
		const rows = await db
			.update(agentSessionEvents)
			.set({
				status: "pending",
				attempts: 0,
				claimedAt: null,
				processedAt: null,
			})
			.where(
				and(
					eq(agentSessionEvents.organizationId, params.organizationId),
					eq(agentSessionEvents.userId, params.userId),
					inArray(agentSessionEvents.sourceKey, keys),
					eq(agentSessionEvents.status, "failed"),
					notExists(
						db
							.select({ id: later.id })
							.from(later)
							.where(
								and(
									eq(later.organizationId, agentSessionEvents.organizationId),
									eq(later.userId, agentSessionEvents.userId),
									eq(later.harness, agentSessionEvents.harness),
									eq(later.sessionKey, agentSessionEvents.sessionKey),
									or(eq(later.status, "processed"), isNotNull(later.claimedAt)),
									or(
										gt(later.sourceAt, agentSessionEvents.sourceAt),
										and(
											eq(later.sourceAt, agentSessionEvents.sourceAt),
											gt(later.id, agentSessionEvents.id),
										),
									),
								),
							),
					),
				),
			)
			.returning({ id: agentSessionEvents.id });
		retried += rows.length;
	}
	return retried;
}

/** A later event cannot overtake an earlier pending event in the same session. */
function noEarlierPendingEvent(db: DbQueryClient) {
	const earlier = alias(agentSessionEvents, "earlier_session_event");
	return notExists(
		db
			.select({ id: earlier.id })
			.from(earlier)
			.where(
				and(
					eq(earlier.organizationId, agentSessionEvents.organizationId),
					eq(earlier.userId, agentSessionEvents.userId),
					eq(earlier.harness, agentSessionEvents.harness),
					eq(earlier.sessionKey, agentSessionEvents.sessionKey),
					eq(earlier.status, "pending"),
					or(
						lt(earlier.sourceAt, agentSessionEvents.sourceAt),
						and(
							eq(earlier.sourceAt, agentSessionEvents.sourceAt),
							lt(earlier.id, agentSessionEvents.id),
						),
					),
				),
			),
	);
}

/** The caller's first pending event per session, including stale leases. */
export async function listPendingAgentSessionEvents(
	db: DbQueryClient,
	params: AgentSessionRequestOwner & { limit: number; now: string },
): Promise<AgentSessionEventRow[]> {
	const stale = new Date(Date.parse(params.now) - EVENT_LEASE_MS).toISOString();
	return db
		.select()
		.from(agentSessionEvents)
		.where(
			and(
				eq(agentSessionEvents.organizationId, params.organizationId),
				eq(agentSessionEvents.userId, params.userId),
				eq(agentSessionEvents.status, "pending"),
				noEarlierPendingEvent(db),
				or(
					isNull(agentSessionEvents.claimedAt),
					lt(agentSessionEvents.claimedAt, stale),
				),
			),
		)
		.orderBy(asc(agentSessionEvents.sourceAt), asc(agentSessionEvents.id))
		.limit(params.limit);
}

/** Take the processing lease of one event; false when another holds it. */
export async function claimAgentSessionEvent(
	db: DbQueryClient,
	params: AgentSessionRequestOwner & { id: string; now: string },
): Promise<boolean> {
	const stale = new Date(Date.parse(params.now) - EVENT_LEASE_MS).toISOString();
	const rows = await db
		.update(agentSessionEvents)
		.set({
			claimedAt: params.now,
			attempts: sql`${agentSessionEvents.attempts} + 1`,
		})
		.where(
			and(
				eq(agentSessionEvents.organizationId, params.organizationId),
				eq(agentSessionEvents.userId, params.userId),
				eq(agentSessionEvents.id, params.id),
				eq(agentSessionEvents.status, "pending"),
				noEarlierPendingEvent(db),
				or(
					isNull(agentSessionEvents.claimedAt),
					lt(agentSessionEvents.claimedAt, stale),
				),
			),
		)
		.returning({ id: agentSessionEvents.id });
	return rows.length === 1;
}

/**
 * Settle a claimed event: processed, or back to pending for another attempt
 * (failed once attempts are used up).
 */
export async function settleAgentSessionEvent(
	db: DbQueryClient,
	params: AgentSessionRequestOwner & {
		id: string;
		processed: boolean;
		now: string;
	},
): Promise<void> {
	await db
		.update(agentSessionEvents)
		.set(
			params.processed
				? { status: "processed", processedAt: params.now, claimedAt: null }
				: {
						status: sql`CASE WHEN ${agentSessionEvents.attempts} >= ${AGENT_SESSION_EVENT_MAX_ATTEMPTS} THEN 'failed' ELSE 'pending' END`,
						claimedAt: null,
					},
		)
		.where(
			and(
				eq(agentSessionEvents.organizationId, params.organizationId),
				eq(agentSessionEvents.userId, params.userId),
				eq(agentSessionEvents.id, params.id),
			),
		);
}

/** One of the caller's own rows, or undefined. */
export async function getAgentSessionRequest(
	db: DbQueryClient,
	params: AgentSessionRequestOwner & { id: string },
): Promise<AgentSessionRequestRow | undefined> {
	const [row] = await db
		.select()
		.from(agentSessionRequests)
		.where(
			and(
				eq(agentSessionRequests.organizationId, params.organizationId),
				eq(agentSessionRequests.userId, params.userId),
				eq(agentSessionRequests.id, params.id),
			),
		)
		.limit(1);
	return row;
}

export interface AgentSessionRequestUpdate {
	id: string;
	status: AgentSessionRequestStatus;
	evidence: string | null;
	turnsUnaddressed?: number;
	laneRunning?: boolean;
	lastReflectedAt?: string;
}

export async function getPreviousAgentSessionTurn(
	db: DbQueryClient,
	params: AgentSessionRequestOwner & {
		harness: WorkAgentSessionHarness;
		sessionKey: string;
		before: string;
		kind?: AgentSessionEventKind;
	},
): Promise<string | null> {
	const [row] = await db
		.select({ body: agentSessionEvents.body })
		.from(agentSessionEvents)
		.where(
			and(
				eq(agentSessionEvents.organizationId, params.organizationId),
				eq(agentSessionEvents.userId, params.userId),
				eq(agentSessionEvents.harness, params.harness),
				eq(agentSessionEvents.sessionKey, params.sessionKey),
				eq(agentSessionEvents.kind, params.kind ?? "turn"),
				lt(agentSessionEvents.sourceAt, params.before),
			),
		)
		.orderBy(
			desc(agentSessionEvents.sourceAt),
			desc(agentSessionEvents.sourceKey),
		)
		.limit(1);
	return row?.body ?? null;
}

/**
 * Apply status changes to the caller's own rows in one batch. A row whose
 * status changes gets a fresh `status_changed_at`. The counter resets unless
 * explicitly supplied; evidence and lane state persist unless updated.
 */
export async function updateAgentSessionRequests(
	db: DbQueryClient,
	params: AgentSessionRequestOwner & {
		updates: readonly AgentSessionRequestUpdate[];
		now: string;
	},
): Promise<void> {
	if (!params.updates.length) return;
	const statements = params.updates.map((update) =>
		db
			.update(agentSessionRequests)
			.set({
				statusChangedAt: sql`CASE WHEN ${agentSessionRequests.status} = ${update.status} THEN ${agentSessionRequests.statusChangedAt} ELSE ${params.now} END`,
				status: update.status,
				evidence: update.evidence
					? update.evidence
					: sql`${agentSessionRequests.evidence}`,
				turnsUnaddressed: update.turnsUnaddressed ?? 0,
				laneRunning:
					update.laneRunning ??
					(update.status === "done" || update.status === "cancelled"
						? false
						: sql`${agentSessionRequests.laneRunning}`),
				lastReflectedAt:
					update.lastReflectedAt ??
					sql`${agentSessionRequests.lastReflectedAt}`,
				updatedAt: params.now,
			})
			.where(
				and(
					eq(agentSessionRequests.organizationId, params.organizationId),
					eq(agentSessionRequests.userId, params.userId),
					eq(agentSessionRequests.id, update.id),
				),
			),
	);
	const [first, ...rest] = statements;
	await db.batch([first!, ...rest]);
}
