import { sql } from "drizzle-orm";
import type { DbClient } from "../client";
import { auditEvents } from "../schema/audit-events";
import { tediRuntimeEvents } from "../schema/cognitive-runtime";
import { tediRationaleRecords } from "../schema/rationale-records";
import { chunkForBoundParams } from "../utils/batch";

const D1_IN_LIST_CHUNK = 50;

export interface AnalyticsAuditActivityRow {
	action: string;
	actorId: string | null;
	actorType: string | null;
	resourceId: string | null;
	timestamp: Date | number | string;
	appId: string | null;
	durationMs: number | string | null;
	errorCode: string | null;
	executionId: string | null;
	traceId: string | null;
	clientId: string | null;
	subjectUserId?: string | null;
	agentTediId?: string | null;
	oauthClientId?: string | null;
	delegationMode?: string | null;
	denialReason?: string | null;
	httpStatus?: number | string | null;
	mcpMethod?: string | null;
	riskTier?: string | null;
}

export interface AnalyticsAuditDrilldownRow {
	action: string;
	actorId: string | null;
	actorType: string | null;
	resourceId: string | null;
	timestamp: Date | number | string;
	durationMs: number | string | null;
	errorCode: string | null;
	traceId: string | null;
	clientId: string | null;
	subjectUserId?: string | null;
	agentTediId?: string | null;
	oauthClientId?: string | null;
	delegationMode?: string | null;
}

export interface AnalyticsFreshnessCountsRow {
	codeExecutions: number | null;
	toolErrors: number | null;
	toolExecutions: number | null;
	totalEvents: number | null;
}

export interface AnalyticsLatestAuditRow {
	action: string;
	durationMs: number | null;
	executionId: string | null;
	namespaceCount: number | null;
	resourceId: string | null;
	timestamp: Date | number | string;
	toolCount: number | null;
	traceId: string | null;
}

export interface AnalyticsRuntimeTraceEvidenceRow {
	traceId: string | null;
	kind: string;
	createdAt?: Date | number | string | null;
	runtimeBackend: string;
	payload: unknown;
}

export interface AnalyticsRationaleEvidenceRow {
	id: string;
	category: string | null;
	outcomeStatus: string | null;
	confidence: number | null;
	evidence: unknown;
	createdAt: string;
	completedAt: string | null;
}

const auditActivityProjection = sql`
	${auditEvents.action} AS action,
	${auditEvents.actorId} AS actorId,
	${auditEvents.actorType} AS actorType,
	${auditEvents.resourceId} AS resourceId,
	${auditEvents.timestamp} AS timestamp,
	json_extract(${auditEvents.metadata}, '$.appId') AS appId,
	json_extract(${auditEvents.metadata}, '$.durationMs') AS durationMs,
	json_extract(${auditEvents.metadata}, '$.errorCode') AS errorCode,
	json_extract(${auditEvents.metadata}, '$.executionId') AS executionId,
	json_extract(${auditEvents.metadata}, '$.traceId') AS traceId,
	json_extract(${auditEvents.metadata}, '$.clientId') AS clientId,
	json_extract(${auditEvents.metadata}, '$.subjectUserId') AS subjectUserId,
	json_extract(${auditEvents.metadata}, '$.agentTediId') AS agentTediId,
	json_extract(${auditEvents.metadata}, '$.oauthClientId') AS oauthClientId,
	json_extract(${auditEvents.metadata}, '$.delegationMode') AS delegationMode,
	json_extract(${auditEvents.metadata}, '$.denialReason') AS denialReason,
	json_extract(${auditEvents.metadata}, '$.httpStatus') AS httpStatus,
	json_extract(${auditEvents.metadata}, '$.mcpMethod') AS mcpMethod,
	json_extract(${auditEvents.metadata}, '$.riskTier') AS riskTier
`;

export async function getAnalyticsAppFreshness(
	db: DbClient,
	input: {
		organizationId: string;
		appId: string;
		windowStartSeconds: number;
		windowEndSeconds: number;
	},
): Promise<{
	countsRow: AnalyticsFreshnessCountsRow | undefined;
	latestRow: AnalyticsLatestAuditRow | undefined;
}> {
	const [countsRow] = await db.all<AnalyticsFreshnessCountsRow>(sql`
		SELECT
			COUNT(*) AS totalEvents,
			SUM(CASE WHEN ${auditEvents.action} = 'mcp.tool.execute' THEN 1 ELSE 0 END) AS toolExecutions,
			SUM(CASE WHEN ${auditEvents.action} = 'mcp.code.execute' THEN 1 ELSE 0 END) AS codeExecutions,
			SUM(CASE WHEN ${auditEvents.action} = 'mcp.tool.error' THEN 1 ELSE 0 END) AS toolErrors
		FROM ${auditEvents}
		WHERE ${auditEvents.organizationId} = ${input.organizationId}
			AND json_extract(${auditEvents.metadata}, '$.appId') = ${input.appId}
			AND ${auditEvents.timestamp} >= ${input.windowStartSeconds}
			AND ${auditEvents.timestamp} <= ${input.windowEndSeconds}
	`);

	const [latestRow] = await db.all<AnalyticsLatestAuditRow>(sql`
		SELECT
			${auditEvents.action} AS action,
			${auditEvents.resourceId} AS resourceId,
			${auditEvents.timestamp} AS timestamp,
			json_extract(${auditEvents.metadata}, '$.durationMs') AS durationMs,
			json_extract(${auditEvents.metadata}, '$.executionId') AS executionId,
			json_extract(${auditEvents.metadata}, '$.traceId') AS traceId,
			json_extract(${auditEvents.metadata}, '$.toolCount') AS toolCount,
			json_extract(${auditEvents.metadata}, '$.namespaceCount') AS namespaceCount
		FROM ${auditEvents}
		WHERE ${auditEvents.organizationId} = ${input.organizationId}
			AND json_extract(${auditEvents.metadata}, '$.appId') = ${input.appId}
		ORDER BY ${auditEvents.timestamp} DESC
		LIMIT 1
	`);

	return { countsRow, latestRow };
}

export async function listAnalyticsExecutionAuditRows(
	db: DbClient,
	input: { executionId: string; organizationId?: string },
): Promise<AnalyticsAuditDrilldownRow[]> {
	const orgCondition = input.organizationId
		? sql`AND ${auditEvents.organizationId} = ${input.organizationId}`
		: sql``;
	return db.all<AnalyticsAuditDrilldownRow>(sql`
		SELECT
			${auditEvents.action} AS action,
			${auditEvents.actorId} AS actorId,
			${auditEvents.actorType} AS actorType,
			${auditEvents.resourceId} AS resourceId,
			${auditEvents.timestamp} AS timestamp,
			json_extract(${auditEvents.metadata}, '$.durationMs') AS durationMs,
			json_extract(${auditEvents.metadata}, '$.errorCode') AS errorCode,
			json_extract(${auditEvents.metadata}, '$.traceId') AS traceId,
			json_extract(${auditEvents.metadata}, '$.clientId') AS clientId,
			json_extract(${auditEvents.metadata}, '$.subjectUserId') AS subjectUserId,
			json_extract(${auditEvents.metadata}, '$.agentTediId') AS agentTediId,
			json_extract(${auditEvents.metadata}, '$.oauthClientId') AS oauthClientId,
			json_extract(${auditEvents.metadata}, '$.delegationMode') AS delegationMode
		FROM ${auditEvents}
		WHERE json_extract(${auditEvents.metadata}, '$.executionId') = ${input.executionId}
			AND ${auditEvents.action} IN ('mcp.code.execute', 'mcp.code.error', 'mcp.tool.execute', 'mcp.tool.error')
			${orgCondition}
		ORDER BY ${auditEvents.timestamp} ASC
	`);
}

export async function listRecentAnalyticsAuditActivity(
	db: DbClient,
	input: {
		organizationId?: string;
		appId?: string;
		actorId?: string;
		limit: number;
	},
): Promise<AnalyticsAuditActivityRow[]> {
	const orgCondition = input.organizationId
		? sql`AND ${auditEvents.organizationId} = ${input.organizationId}`
		: sql``;
	const appCondition = input.appId
		? sql`AND json_extract(${auditEvents.metadata}, '$.appId') = ${input.appId}`
		: sql``;
	const actorCondition = input.actorId
		? sql`AND ${auditEvents.actorId} = ${input.actorId}`
		: sql``;
	return db.all<AnalyticsAuditActivityRow>(sql`
		SELECT ${auditActivityProjection}
		FROM ${auditEvents}
		WHERE ${auditEvents.action} LIKE 'mcp.%'
			${orgCondition} ${appCondition} ${actorCondition}
		ORDER BY ${auditEvents.timestamp} DESC
		LIMIT ${input.limit}
	`);
}

export async function listAnalyticsTraceActivity(
	db: DbClient,
	input: { traceId: string; organizationId?: string },
): Promise<AnalyticsAuditActivityRow[]> {
	const orgCondition = input.organizationId
		? sql`AND ${auditEvents.organizationId} = ${input.organizationId}`
		: sql``;
	return db.all<AnalyticsAuditActivityRow>(sql`
		SELECT ${auditActivityProjection}
		FROM ${auditEvents}
		WHERE json_extract(${auditEvents.metadata}, '$.traceId') = ${input.traceId}
			AND ${auditEvents.action} LIKE 'mcp.%'
			${orgCondition}
		ORDER BY ${auditEvents.timestamp} ASC
	`);
}

export async function listAnalyticsAuditActivityWindow(
	db: DbClient,
	input: {
		organizationId?: string;
		appId?: string;
		actorId?: string;
		startSeconds: number;
		endSeconds: number;
		limit: number;
	},
): Promise<AnalyticsAuditActivityRow[]> {
	const orgCondition = input.organizationId
		? sql`AND ${auditEvents.organizationId} = ${input.organizationId}`
		: sql``;
	const appCondition = input.appId
		? sql`AND json_extract(${auditEvents.metadata}, '$.appId') = ${input.appId}`
		: sql``;
	const actorCondition = input.actorId
		? sql`AND ${auditEvents.actorId} = ${input.actorId}`
		: sql``;
	return db.all<AnalyticsAuditActivityRow>(sql`
		SELECT ${auditActivityProjection}
		FROM ${auditEvents}
		WHERE ${auditEvents.action} LIKE 'mcp.%'
			AND ${auditEvents.timestamp} >= ${input.startSeconds}
			AND ${auditEvents.timestamp} <= ${input.endSeconds}
			${orgCondition} ${appCondition} ${actorCondition}
		ORDER BY ${auditEvents.timestamp} DESC
		LIMIT ${input.limit}
	`);
}

export async function listAnalyticsRuntimeTraceEvidence(
	db: DbClient,
	input: { organizationId: string; traceIds: string[]; limit?: number },
): Promise<AnalyticsRuntimeTraceEvidenceRow[]> {
	const rows: AnalyticsRuntimeTraceEvidenceRow[] = [];
	for (const traceIds of chunkForBoundParams(
		[...new Set(input.traceIds)],
		D1_IN_LIST_CHUNK,
	)) {
		const traceList = sql.join(
			traceIds.map((traceId) => sql`${traceId}`),
			sql`, `,
		);
		rows.push(
			...(await db.all<AnalyticsRuntimeTraceEvidenceRow>(sql`
				SELECT
					${tediRuntimeEvents.traceId} AS traceId,
					${tediRuntimeEvents.kind} AS kind,
					${tediRuntimeEvents.createdAt} AS createdAt,
					${tediRuntimeEvents.runtimeBackend} AS runtimeBackend,
					${tediRuntimeEvents.payload} AS payload
				FROM ${tediRuntimeEvents}
				WHERE ${tediRuntimeEvents.organizationId} = ${input.organizationId}
					AND ${tediRuntimeEvents.traceId} IN (${traceList})
				ORDER BY ${tediRuntimeEvents.createdAt} ASC
				LIMIT ${input.limit ?? 2000}
			`)),
		);
	}
	return rows
		.sort((a, b) =>
			String(a.createdAt ?? "").localeCompare(String(b.createdAt ?? "")),
		)
		.slice(0, input.limit ?? 2000);
}

export async function listAnalyticsRationaleEvidence(
	db: DbClient,
	input: { organizationId: string; decisionIds: string[] },
): Promise<AnalyticsRationaleEvidenceRow[]> {
	const rows: AnalyticsRationaleEvidenceRow[] = [];
	for (const decisionIds of chunkForBoundParams(
		[...new Set(input.decisionIds)],
		D1_IN_LIST_CHUNK,
	)) {
		const decisionList = sql.join(
			decisionIds.map((decisionId) => sql`${decisionId}`),
			sql`, `,
		);
		rows.push(
			...(await db.all<AnalyticsRationaleEvidenceRow>(sql`
				SELECT
					${tediRationaleRecords.id} AS id,
					${tediRationaleRecords.category} AS category,
					${tediRationaleRecords.outcomeStatus} AS outcomeStatus,
					${tediRationaleRecords.confidence} AS confidence,
					${tediRationaleRecords.evidence} AS evidence,
					${tediRationaleRecords.createdAt} AS createdAt,
					${tediRationaleRecords.completedAt} AS completedAt
				FROM ${tediRationaleRecords}
				WHERE ${tediRationaleRecords.orgId} = ${input.organizationId}
					AND ${tediRationaleRecords.id} IN (${decisionList})
			`)),
		);
	}
	return rows;
}
