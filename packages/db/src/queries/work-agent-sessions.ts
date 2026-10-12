/**
 * Local agent session status board persistence.
 *
 * Every read and write is scoped to one organization and one user: a session
 * row is visible only to the human who reported it.
 */

import {
	and,
	desc,
	eq,
	gte,
	inArray,
	isNotNull,
	ne,
	or,
	sql,
} from "drizzle-orm";
import type { DbQueryClient } from "../query-client";
import {
	type WorkAgentSessionHarness,
	type WorkAgentSessionRow,
	type WorkAgentSessionState,
	workAgentSessions,
} from "../schema/work-agent-sessions";
import { projects } from "../schema/projects";
import { workAttempts, workItems } from "../schema/work-items";

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
	/** Bound Work project; null keeps the stored binding. */
	projectId?: string | null;
	/** Selected Work Item; null keeps the stored selection. */
	workItemId?: string | null;
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
 * concurrent report cannot reset it. An empty label keeps the stored one, and
 * so does an absent project or Work Item; one outside the organization is
 * treated as absent.
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
	const [project] = params.projectId
		? await db
				.select({ id: projects.id })
				.from(projects)
				.where(
					and(
						eq(projects.orgId, params.organizationId),
						eq(projects.id, params.projectId),
					),
				)
				.limit(1)
		: [];
	const [workItem] = params.workItemId
		? await db
				.select({ id: workItems.id })
				.from(workItems)
				.where(
					and(
						eq(workItems.orgId, params.organizationId),
						eq(workItems.id, params.workItemId),
					),
				)
				.limit(1)
		: [];

	const [row] = await db
		.insert(workAgentSessions)
		.values({
			id: crypto.randomUUID(),
			organizationId: params.organizationId,
			userId: params.userId,
			harness: params.harness,
			sessionKey: params.sessionKey,
			label: params.label,
			projectId: project?.id ?? null,
			workItemId: workItem?.id ?? null,
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
				projectId: sql`COALESCE(excluded.project_id, ${workAgentSessions.projectId})`,
				workItemId: sql`COALESCE(excluded.work_item_id, ${workAgentSessions.workItemId})`,
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

/** Hard ceiling on session reports and Attempts read for one project. */
export const WORK_PROJECT_CONTRIBUTOR_SOURCE_LIMIT = 500;
/** Session keys per `IN (...)` lookup, under D1's bound-parameter limit. */
const SESSION_KEY_CHUNK = 80;

export interface WorkProjectSessionReport extends WorkAgentSessionRow {
	workItemTitle: string | null;
}

export interface WorkProjectAttemptSession {
	/** `<harness>:<host session id>`, as the Attempt stored it. */
	externalSessionKey: string;
	workItemId: string;
	workItemTitle: string;
	runtimeState: string;
	startedAt: string;
	heartbeatAt: string;
	finishedAt: string | null;
}

const sessionReportColumns = {
	id: workAgentSessions.id,
	organizationId: workAgentSessions.organizationId,
	userId: workAgentSessions.userId,
	harness: workAgentSessions.harness,
	sessionKey: workAgentSessions.sessionKey,
	label: workAgentSessions.label,
	projectId: workAgentSessions.projectId,
	workItemId: workAgentSessions.workItemId,
	state: workAgentSessions.state,
	summary: workAgentSessions.summary,
	stateSince: workAgentSessions.stateSince,
	lastEventAt: workAgentSessions.lastEventAt,
	createdAt: workAgentSessions.createdAt,
	updatedAt: workAgentSessions.updatedAt,
	workItemTitle: workItems.title,
};

/**
 * Everything known about the sessions that worked on one project: external
 * Attempts on its Work Items, plus every session report that is bound to the
 * project or comes from a session holding one of those Attempts. Ended
 * sessions are included; the caller derives state and merges per session.
 */
export async function listWorkProjectContributorSources(
	db: DbQueryClient,
	params: { organizationId: string; projectId: string },
): Promise<{
	reports: WorkProjectSessionReport[];
	attempts: WorkProjectAttemptSession[];
}> {
	const attempts = await db
		.select({
			externalSessionKey: sql<string>`${workAttempts.externalSessionKey}`,
			workItemId: workAttempts.workItemId,
			workItemTitle: workItems.title,
			runtimeState: workAttempts.runtimeState,
			startedAt: workAttempts.startedAt,
			heartbeatAt: workAttempts.heartbeatAt,
			finishedAt: workAttempts.finishedAt,
		})
		.from(workAttempts)
		.innerJoin(
			workItems,
			and(
				eq(workItems.orgId, workAttempts.orgId),
				eq(workItems.id, workAttempts.workItemId),
			),
		)
		.where(
			and(
				eq(workAttempts.orgId, params.organizationId),
				eq(workItems.projectId, params.projectId),
				isNotNull(workAttempts.externalSessionKey),
			),
		)
		.orderBy(desc(workAttempts.heartbeatAt))
		.limit(WORK_PROJECT_CONTRIBUTOR_SOURCE_LIMIT);

	const reportQuery = (where: ReturnType<typeof and>) =>
		db
			.select(sessionReportColumns)
			.from(workAgentSessions)
			.leftJoin(
				workItems,
				and(
					eq(workItems.orgId, workAgentSessions.organizationId),
					eq(workItems.id, workAgentSessions.workItemId),
				),
			)
			.where(where)
			.orderBy(desc(workAgentSessions.lastEventAt))
			.limit(WORK_PROJECT_CONTRIBUTOR_SOURCE_LIMIT);

	const reports = await reportQuery(
		and(
			eq(workAgentSessions.organizationId, params.organizationId),
			eq(workAgentSessions.projectId, params.projectId),
		),
	);
	const known = new Set(reports.map((row) => row.id));
	const hostIds = [
		...new Set(
			attempts
				.map((row) => row.externalSessionKey.split(":").slice(1).join(":"))
				.filter(Boolean),
		),
	];
	for (let index = 0; index < hostIds.length; index += SESSION_KEY_CHUNK) {
		const rows = await reportQuery(
			and(
				eq(workAgentSessions.organizationId, params.organizationId),
				inArray(
					workAgentSessions.sessionKey,
					hostIds.slice(index, index + SESSION_KEY_CHUNK),
				),
			),
		);
		for (const row of rows) {
			if (known.has(row.id)) continue;
			known.add(row.id);
			reports.push(row);
		}
	}
	return { reports, attempts };
}
