import { and, asc, desc, eq, inArray, like, sql } from "drizzle-orm";
import type { DbClient } from "../client";
import { auditEvents } from "../schema/audit-events";
import { tediRuntimeEvents } from "../schema/cognitive-runtime";
import { tediRationaleRecords } from "../schema/rationale-records";
import { chunkForBoundParams } from "../utils/batch";
import { readLogStores } from "../utils/log-store";

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

/** `subjectUserId`, restored where the row stores `subjectIsActor` (queries/audit.ts). */
const auditSubjectUserId = sql<
	string | null
>`coalesce(json_extract(${auditEvents.metadata}, '$.subjectUserId'), CASE WHEN json_extract(${auditEvents.metadata}, '$.subjectIsActor') = 1 THEN ${auditEvents.actorId} END)`;

/** Raw driver values: the timestamp stays epoch seconds, not a decoded Date. */
const auditTimestamp = sql<Date | number | string>`${auditEvents.timestamp}`;

/** `json_extract(metadata, '$.key') AS key`; D1 needs unique output names. */
function auditMetadata(key: string) {
	return sql<
		string | null
	>`json_extract(${auditEvents.metadata}, ${`$.${key}`})`.as(key);
}

function auditMetadataNumber(key: string) {
	return sql<
		number | null
	>`json_extract(${auditEvents.metadata}, ${`$.${key}`})`.as(key);
}

function auditMetadataNumeric(key: string) {
	return sql<
		number | string | null
	>`json_extract(${auditEvents.metadata}, ${`$.${key}`})`.as(key);
}

const auditOauthClientId = sql<
	string | null
>`coalesce(json_extract(${auditEvents.metadata}, '$.clientId'), json_extract(${auditEvents.metadata}, '$.oauthClientId'))`;

const auditActivityFields = {
	action: auditEvents.action,
	actorId: auditEvents.actorId,
	actorType: auditEvents.actorType,
	resourceId: auditEvents.resourceId,
	timestamp: auditTimestamp.as("timestamp"),
	appId: auditMetadata("appId"),
	durationMs: auditMetadataNumeric("durationMs"),
	errorCode: auditMetadata("errorCode"),
	executionId: auditMetadata("executionId"),
	traceId: auditMetadata("traceId"),
	clientId: auditMetadata("clientId"),
	subjectUserId: auditSubjectUserId.as("subjectUserId"),
	agentTediId: auditMetadata("agentTediId"),
	oauthClientId: auditOauthClientId.as("oauthClientId"),
	delegationMode: auditMetadata("delegationMode"),
	denialReason: auditMetadata("denialReason"),
	httpStatus: auditMetadataNumeric("httpStatus"),
	mcpMethod: auditMetadata("mcpMethod"),
	riskTier: auditMetadata("riskTier"),
};

function optionalOrganization(organizationId: string | undefined) {
	return organizationId
		? eq(auditEvents.organizationId, organizationId)
		: undefined;
}

function optionalActivityScope(input: {
	organizationId?: string;
	appId?: string;
	actorId?: string;
}) {
	return [
		optionalOrganization(input.organizationId),
		input.appId
			? sql`json_extract(${auditEvents.metadata}, '$.appId') = ${input.appId}`
			: undefined,
		input.actorId ? eq(auditEvents.actorId, input.actorId) : undefined,
	];
}

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
	const pages = await readLogStores(
		db,
		(store) => getAnalyticsAppFreshness(store, input),
		{
			from: new Date(input.windowStartSeconds * 1000).toISOString(),
			to: new Date(input.windowEndSeconds * 1000).toISOString(),
			order: "logs-first",
		},
	);
	if (pages) {
		const countsRow: AnalyticsFreshnessCountsRow = {
			totalEvents: 0,
			toolExecutions: 0,
			codeExecutions: 0,
			toolErrors: 0,
		};
		for (const page of pages) {
			for (const key of Object.keys(
				countsRow,
			) as (keyof AnalyticsFreshnessCountsRow)[])
				countsRow[key] =
					Number(countsRow[key]) + Number(page.countsRow?.[key] ?? 0);
		}
		const latestRow = pages
			.flatMap((page) => (page.latestRow ? [page.latestRow] : []))
			.sort((a, b) => Number(b.timestamp) - Number(a.timestamp))[0];
		return { countsRow, latestRow };
	}
	const appScope = and(
		eq(auditEvents.organizationId, input.organizationId),
		sql`json_extract(${auditEvents.metadata}, '$.appId') = ${input.appId}`,
	);
	const [countsRow] = await db
		.select({
			totalEvents: sql<number | null>`COUNT(*)`.as("totalEvents"),
			toolExecutions: sql<
				number | null
			>`SUM(CASE WHEN ${auditEvents.action} = 'mcp.tool.execute' THEN 1 ELSE 0 END)`.as(
				"toolExecutions",
			),
			codeExecutions: sql<
				number | null
			>`SUM(CASE WHEN ${auditEvents.action} = 'mcp.code.execute' THEN 1 ELSE 0 END)`.as(
				"codeExecutions",
			),
			toolErrors: sql<
				number | null
			>`SUM(CASE WHEN ${auditEvents.action} = 'mcp.tool.error' THEN 1 ELSE 0 END)`.as(
				"toolErrors",
			),
		})
		.from(auditEvents)
		.where(
			and(
				appScope,
				sql`${auditEvents.timestamp} >= ${input.windowStartSeconds}`,
				sql`${auditEvents.timestamp} <= ${input.windowEndSeconds}`,
			),
		);

	const [latestRow] = await db
		.select({
			action: auditEvents.action,
			resourceId: auditEvents.resourceId,
			timestamp: auditTimestamp.as("timestamp"),
			durationMs: auditMetadataNumber("durationMs"),
			executionId: auditMetadata("executionId"),
			traceId: auditMetadata("traceId"),
			toolCount: auditMetadataNumber("toolCount"),
			namespaceCount: auditMetadataNumber("namespaceCount"),
		})
		.from(auditEvents)
		.where(appScope)
		.orderBy(desc(auditEvents.timestamp))
		.limit(1);

	return { countsRow, latestRow };
}

export async function listAnalyticsExecutionAuditRows(
	db: DbClient,
	input: { executionId: string; organizationId?: string },
): Promise<AnalyticsAuditDrilldownRow[]> {
	const pages = await readLogStores(
		db,
		(store) => listAnalyticsExecutionAuditRows(store, input),
		{ order: "logs-first" },
	);
	if (pages) {
		const rows = pages
			.flat()
			.sort((a, b) => Number(a.timestamp) - Number(b.timestamp));
		return rows;
	}
	return db
		.select({
			action: auditEvents.action,
			actorId: auditEvents.actorId,
			actorType: auditEvents.actorType,
			resourceId: auditEvents.resourceId,
			timestamp: auditTimestamp.as("timestamp"),
			durationMs: auditMetadataNumeric("durationMs"),
			errorCode: auditMetadata("errorCode"),
			traceId: auditMetadata("traceId"),
			clientId: auditMetadata("clientId"),
			subjectUserId: auditSubjectUserId.as("subjectUserId"),
			agentTediId: auditMetadata("agentTediId"),
			oauthClientId: auditOauthClientId.as("oauthClientId"),
			delegationMode: auditMetadata("delegationMode"),
		})
		.from(auditEvents)
		.where(
			and(
				sql`json_extract(${auditEvents.metadata}, '$.executionId') = ${input.executionId}`,
				inArray(auditEvents.action, [
					"mcp.code.execute",
					"mcp.code.error",
					"mcp.tool.execute",
					"mcp.tool.error",
				]),
				optionalOrganization(input.organizationId),
			),
		)
		.orderBy(asc(auditEvents.timestamp));
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
	const pages = await readLogStores(
		db,
		(store) => listRecentAnalyticsAuditActivity(store, input),
		{ order: "logs-first" },
	);
	if (pages) {
		const rows = pages
			.flat()
			.sort((a, b) => -(Number(a.timestamp) - Number(b.timestamp)));
		return rows.slice(0, input.limit);
	}
	return db
		.select(auditActivityFields)
		.from(auditEvents)
		.where(
			and(like(auditEvents.action, "mcp.%"), ...optionalActivityScope(input)),
		)
		.orderBy(desc(auditEvents.timestamp))
		.limit(input.limit);
}

export async function listAnalyticsTraceActivity(
	db: DbClient,
	input: { traceId: string; organizationId?: string },
): Promise<AnalyticsAuditActivityRow[]> {
	const pages = await readLogStores(
		db,
		(store) => listAnalyticsTraceActivity(store, input),
		{ order: "logs-first" },
	);
	if (pages) {
		const rows = pages
			.flat()
			.sort((a, b) => Number(a.timestamp) - Number(b.timestamp));
		return rows;
	}
	return db
		.select(auditActivityFields)
		.from(auditEvents)
		.where(
			and(
				sql`json_extract(${auditEvents.metadata}, '$.traceId') = ${input.traceId}`,
				like(auditEvents.action, "mcp.%"),
				optionalOrganization(input.organizationId),
			),
		)
		.orderBy(asc(auditEvents.timestamp));
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
	const pages = await readLogStores(
		db,
		(store) => listAnalyticsAuditActivityWindow(store, input),
		{
			from: new Date(input.startSeconds * 1000).toISOString(),
			to: new Date(input.endSeconds * 1000).toISOString(),
			order: "logs-first",
		},
	);
	if (pages) {
		const rows = pages
			.flat()
			.sort((a, b) => -(Number(a.timestamp) - Number(b.timestamp)));
		return rows.slice(0, input.limit);
	}
	return db
		.select(auditActivityFields)
		.from(auditEvents)
		.where(
			and(
				like(auditEvents.action, "mcp.%"),
				sql`${auditEvents.timestamp} >= ${input.startSeconds}`,
				sql`${auditEvents.timestamp} <= ${input.endSeconds}`,
				...optionalActivityScope(input),
			),
		)
		.orderBy(desc(auditEvents.timestamp))
		.limit(input.limit);
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
		rows.push(
			...(await db
				.select({
					traceId: tediRuntimeEvents.traceId,
					kind: tediRuntimeEvents.kind,
					createdAt: tediRuntimeEvents.createdAt,
					runtimeBackend: tediRuntimeEvents.runtimeBackend,
					// Raw stored JSON text, as before; callers parse it.
					payload: sql<unknown>`${tediRuntimeEvents.payload}`.as("payload"),
				})
				.from(tediRuntimeEvents)
				.where(
					and(
						eq(tediRuntimeEvents.organizationId, input.organizationId),
						inArray(tediRuntimeEvents.traceId, traceIds),
					),
				)
				.orderBy(asc(tediRuntimeEvents.createdAt))
				.limit(input.limit ?? 2000)),
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
		rows.push(
			...(await db
				.select({
					id: tediRationaleRecords.id,
					category: tediRationaleRecords.category,
					outcomeStatus: tediRationaleRecords.outcomeStatus,
					confidence: tediRationaleRecords.confidence,
					evidence: sql<unknown>`${tediRationaleRecords.evidence}`.as(
						"evidence",
					),
					createdAt: tediRationaleRecords.createdAt,
					completedAt: tediRationaleRecords.completedAt,
				})
				.from(tediRationaleRecords)
				.where(
					and(
						eq(tediRationaleRecords.orgId, input.organizationId),
						inArray(tediRationaleRecords.id, decisionIds),
					),
				)),
		);
	}
	return rows;
}
