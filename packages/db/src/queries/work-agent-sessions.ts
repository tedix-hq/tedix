/**
 * Local agent session status board persistence.
 *
 * Every read and write is scoped to one organization and one user: a session
 * row is visible only to the human who reported it.
 */

import { and, desc, eq, gte, ne, or, sql } from "drizzle-orm";
import type { DbQueryClient } from "../query-client";
import {
	type WorkAgentSessionHarness,
	type WorkAgentSessionRow,
	type WorkAgentSessionState,
	workAgentSessions,
} from "../schema/work-agent-sessions";

/** Hard ceiling on rows the board returns for one user. */
export const WORK_AGENT_SESSION_LIST_LIMIT = 200;
/** Ended sessions older than this never reach the board. */
export const WORK_AGENT_SESSION_ENDED_RETENTION_MS = 24 * 60 * 60 * 1000;

export interface ReportWorkAgentSessionStatusParams {
	organizationId: string;
	userId: string;
	harness: WorkAgentSessionHarness;
	sessionKey: string;
	state: WorkAgentSessionState;
	summary: string;
	label: string;
	/** ISO 8601 observation time. */
	now: string;
}

export interface ReportWorkAgentSessionStatusResult {
	row: WorkAgentSessionRow;
	/** True when the session is new or its stored state differs. */
	changed: boolean;
}

/**
 * Upsert one session's latest status. `state_since` moves only when the state
 * changes; the conflict update decides that from the stored row, so a
 * concurrent report cannot reset it. An empty label keeps the stored one.
 */
export async function reportWorkAgentSessionStatus(
	db: DbQueryClient,
	params: ReportWorkAgentSessionStatusParams,
): Promise<ReportWorkAgentSessionStatusResult> {
	const identity = and(
		eq(workAgentSessions.organizationId, params.organizationId),
		eq(workAgentSessions.userId, params.userId),
		eq(workAgentSessions.harness, params.harness),
		eq(workAgentSessions.sessionKey, params.sessionKey),
	);
	const [existing] = await db
		.select({ state: workAgentSessions.state })
		.from(workAgentSessions)
		.where(identity)
		.limit(1);

	const [row] = await db
		.insert(workAgentSessions)
		.values({
			id: crypto.randomUUID(),
			organizationId: params.organizationId,
			userId: params.userId,
			harness: params.harness,
			sessionKey: params.sessionKey,
			label: params.label,
			state: params.state,
			summary: params.summary,
			stateSince: params.now,
			lastEventAt: params.now,
			createdAt: params.now,
			updatedAt: params.now,
		})
		.onConflictDoUpdate({
			target: [
				workAgentSessions.organizationId,
				workAgentSessions.userId,
				workAgentSessions.harness,
				workAgentSessions.sessionKey,
			],
			set: {
				label: sql`CASE WHEN excluded.label = '' THEN ${workAgentSessions.label} ELSE excluded.label END`,
				stateSince: sql`CASE WHEN ${workAgentSessions.state} = excluded.state THEN ${workAgentSessions.stateSince} ELSE excluded.state_since END`,
				state: sql`excluded.state`,
				summary: sql`excluded.summary`,
				lastEventAt: sql`excluded.last_event_at`,
				updatedAt: sql`excluded.updated_at`,
			},
		})
		.returning();
	if (!row) {
		throw new Error("Work agent session upsert returned no row");
	}
	return { row, changed: existing?.state !== params.state };
}

export interface ListWorkAgentSessionsParams {
	organizationId: string;
	userId: string;
	/** Include ended sessions reported within the last 24 hours. */
	includeEnded: boolean;
	/** ISO 8601 observation time. */
	now: string;
}

/** The caller's own sessions, newest report first, bounded. */
export async function listWorkAgentSessions(
	db: DbQueryClient,
	params: ListWorkAgentSessionsParams,
): Promise<WorkAgentSessionRow[]> {
	const endedCutoff = new Date(
		Date.parse(params.now) - WORK_AGENT_SESSION_ENDED_RETENTION_MS,
	).toISOString();
	const notEnded = ne(workAgentSessions.state, "ended");
	return db
		.select()
		.from(workAgentSessions)
		.where(
			and(
				eq(workAgentSessions.organizationId, params.organizationId),
				eq(workAgentSessions.userId, params.userId),
				params.includeEnded
					? or(notEnded, gte(workAgentSessions.lastEventAt, endedCutoff))
					: notEnded,
			),
		)
		.orderBy(desc(workAgentSessions.lastEventAt))
		.limit(WORK_AGENT_SESSION_LIST_LIMIT);
}
