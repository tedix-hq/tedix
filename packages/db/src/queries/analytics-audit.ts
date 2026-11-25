import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import type { DbClient } from "../client";
import { coreTable } from "../core-store/client";
import {
	anyIds,
	booleanValue,
	coreStore,
	dateTime,
	jsonRead,
	likeText,
	unixTime,
} from "../core-store/dialect";
import { auditEvents as d1AuditEvents } from "../schema/audit-events";
import { auditMetadataRefs as d1AuditMetadataRefs } from "../schema/audit-metadata-refs";
import { isMissingAuditMetadataRefsTable } from "../utils/audit-metadata-refs";
import { tediRuntimeEvents as d1TediRuntimeEvents } from "../schema/cognitive-runtime";
import { tediRationaleRecords as d1TediRationaleRecords } from "../schema/rationale-records";
import { readLogStores } from "../utils/log-store";

function auditWindowTime(db: DbClient, seconds: number) {
	return coreStore(db) === "postgres"
		? dateTime(db, sql`${seconds}`)
		: sql`${seconds}`;
}

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

/**
 * Run a read that resolves compact identifiers through `audit_metadata_refs`.
 * A logs database that has not received that migration cannot hold compact
 * rows either, so the same read runs there against the inline identifiers.
 */
async function withAuditMetadataRefs<T>(
	read: (refs: boolean) => Promise<T>,
): Promise<T> {
	try {
		return await read(true);
	} catch (error) {
		if (!isMissingAuditMetadataRefsTable(error)) throw error;
		return read(false);
	}
}

function auditExpressions(db: DbClient) {
	const auditEvents = coreTable(db, d1AuditEvents);
	const auditMetadataRefs = coreTable(db, d1AuditMetadataRefs);
	const auditSubjectUserId = sql<string | null>`coalesce(
		${jsonRead(db, auditEvents.metadata, ["subjectUserId"])},
		CASE WHEN ${jsonRead(db, auditEvents.metadata, ["subjectIsActor"], "boolean")} = ${booleanValue(db, true)} THEN ${auditEvents.actorId} END
	)`;
	// Consumers merge log pages using epoch seconds, not decoded Dates.
	const auditTimestamp =
		sql<number>`${coreStore(db) === "postgres" ? unixTime(db, auditEvents.timestamp) : auditEvents.timestamp}`.mapWith(
			Number,
		);
	function auditMetadata(key: string) {
		return sql<string | null>`${jsonRead(db, auditEvents.metadata, [key])}`.as(
			key,
		);
	}
	function auditMetadataNumber(key: string) {
		return sql<
			number | null
		>`${jsonRead(db, auditEvents.metadata, [key], "json")}`
			.mapWith(Number)
			.as(key);
	}
	function auditMetadataNumeric(key: string) {
		return sql<
			number | string | null
		>`${jsonRead(db, auditEvents.metadata, [key], "json")}`.as(key);
	}
	function auditReferencedMetadata(
		refs: boolean,
		key: "appId" | "clientId",
		refKey: "a" | "c",
		kind: "app" | "client",
	) {
		if (!refs)
			return sql<string | null>`${jsonRead(db, auditEvents.metadata, [key])}`;
		return sql<string | null>`coalesce(
		${jsonRead(db, auditEvents.metadata, [key])},
		(
			select ${auditMetadataRefs.value}
			from ${auditMetadataRefs}
			where ${auditMetadataRefs.organizationId} = ${auditEvents.organizationId}
				and ${auditMetadataRefs.ref} = ${jsonRead(db, auditEvents.metadata, ["_r", refKey])}
				and ${auditMetadataRefs.kind} = ${kind}
		)
	)`;
	}

	function auditAppId(refs: boolean) {
		return auditReferencedMetadata(refs, "appId", "a", "app");
	}

	function auditClientId(refs: boolean) {
		return auditReferencedMetadata(refs, "clientId", "c", "client");
	}

	function auditAppMatches(refs: boolean, appId: string) {
		if (!refs)
			return sql`${jsonRead(db, auditEvents.metadata, ["appId"])} = ${appId}`;
		return sql`(
		${jsonRead(db, auditEvents.metadata, ["appId"])} = ${appId}
		or ${jsonRead(db, auditEvents.metadata, ["_r", "a"])} = (
			select ${auditMetadataRefs.ref}
			from ${auditMetadataRefs}
			where ${auditMetadataRefs.organizationId} = ${auditEvents.organizationId}
				and ${auditMetadataRefs.kind} = 'app'
				and ${auditMetadataRefs.value} = ${appId}
		)
	)`;
	}

	function auditOauthClientId(refs: boolean) {
		return sql<
			string | null
		>`coalesce(${auditClientId(refs)}, ${jsonRead(db, auditEvents.metadata, ["oauthClientId"])})`;
	}

	function auditActivityFields(refs: boolean) {
		return {
			action: auditEvents.action,
			actorId: auditEvents.actorId,
			actorType: auditEvents.actorType,
			resourceId: auditEvents.resourceId,
			timestamp: auditTimestamp.as("timestamp"),
			appId: auditAppId(refs).as("appId"),
			durationMs: auditMetadataNumeric("durationMs"),
			errorCode: auditMetadata("errorCode"),
			executionId: auditMetadata("executionId"),
			traceId: auditMetadata("traceId"),
			clientId: auditClientId(refs).as("clientId"),
			subjectUserId: auditSubjectUserId.as("subjectUserId"),
			agentTediId: auditMetadata("agentTediId"),
			oauthClientId: auditOauthClientId(refs).as("oauthClientId"),
			delegationMode: auditMetadata("delegationMode"),
			denialReason: auditMetadata("denialReason"),
			httpStatus: auditMetadataNumeric("httpStatus"),
			mcpMethod: auditMetadata("mcpMethod"),
			riskTier: auditMetadata("riskTier"),
		};
	}

	function optionalOrganization(organizationId: string | undefined) {
		return organizationId
			? eq(auditEvents.organizationId, organizationId)
			: undefined;
	}

	function optionalActivityScope(
		refs: boolean,
		input: {
			organizationId?: string;
			appId?: string;
			actorId?: string;
		},
	) {
		return [
			optionalOrganization(input.organizationId),
			input.appId ? auditAppMatches(refs, input.appId) : undefined,
			input.actorId ? eq(auditEvents.actorId, input.actorId) : undefined,
		];
	}
	return {
		auditEvents,
		auditSubjectUserId,
		auditTimestamp,
		auditMetadata,
		auditMetadataNumber,
		auditMetadataNumeric,
		auditAppMatches,
		auditClientId,
		auditOauthClientId,
		auditActivityFields,
		optionalOrganization,
		optionalActivityScope,
	};
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
	return withAuditMetadataRefs((refs) =>
		readAnalyticsAppFreshness(db, input, refs),
	);
}

async function readAnalyticsAppFreshness(
	db: DbClient,
	input: {
		organizationId: string;
		appId: string;
		windowStartSeconds: number;
		windowEndSeconds: number;
	},
	refs: boolean,
): Promise<{
	countsRow: AnalyticsFreshnessCountsRow | undefined;
	latestRow: AnalyticsLatestAuditRow | undefined;
}> {
	const {
		auditEvents,
		auditAppMatches,
		auditTimestamp,
		auditMetadataNumber,
		auditMetadata,
	} = auditExpressions(db);
	const appScope = and(
		eq(auditEvents.organizationId, input.organizationId),
		auditAppMatches(refs, input.appId),
	);
	const [countsRow] = await db
		.select({
			totalEvents: sql<number | null>`COUNT(*)`
				.mapWith(Number)
				.as("totalEvents"),
			toolExecutions: sql<
				number | null
			>`SUM(CASE WHEN ${auditEvents.action} = 'mcp.tool.execute' THEN 1 ELSE 0 END)`
				.mapWith(Number)
				.as("toolExecutions"),
			codeExecutions: sql<
				number | null
			>`SUM(CASE WHEN ${auditEvents.action} = 'mcp.code.execute' THEN 1 ELSE 0 END)`
				.mapWith(Number)
				.as("codeExecutions"),
			toolErrors: sql<
				number | null
			>`SUM(CASE WHEN ${auditEvents.action} = 'mcp.tool.error' THEN 1 ELSE 0 END)`
				.mapWith(Number)
				.as("toolErrors"),
		})
		.from(auditEvents)
		.where(
			and(
				appScope,
				sql`${auditEvents.timestamp} >= ${auditWindowTime(db, input.windowStartSeconds)}`,
				sql`${auditEvents.timestamp} <= ${auditWindowTime(db, input.windowEndSeconds)}`,
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
	const {
		auditEvents,
		auditTimestamp,
		auditMetadataNumeric,
		auditMetadata,
		auditClientId,
		auditSubjectUserId,
		auditOauthClientId,
		optionalOrganization,
	} = auditExpressions(db);
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
	return withAuditMetadataRefs((refs) =>
		db
			.select({
				action: auditEvents.action,
				actorId: auditEvents.actorId,
				actorType: auditEvents.actorType,
				resourceId: auditEvents.resourceId,
				timestamp: auditTimestamp.as("timestamp"),
				durationMs: auditMetadataNumeric("durationMs"),
				errorCode: auditMetadata("errorCode"),
				traceId: auditMetadata("traceId"),
				clientId: auditClientId(refs).as("clientId"),
				subjectUserId: auditSubjectUserId.as("subjectUserId"),
				agentTediId: auditMetadata("agentTediId"),
				oauthClientId: auditOauthClientId(refs).as("oauthClientId"),
				delegationMode: auditMetadata("delegationMode"),
			})
			.from(auditEvents)
			.where(
				and(
					sql`${jsonRead(db, auditEvents.metadata, ["executionId"])} = ${input.executionId}`,
					inArray(auditEvents.action, [
						"mcp.code.execute",
						"mcp.code.error",
						"mcp.tool.execute",
						"mcp.tool.error",
					]),
					optionalOrganization(input.organizationId),
				),
			)
			.orderBy(asc(auditEvents.timestamp)),
	);
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
	const { auditEvents, auditActivityFields, optionalActivityScope } =
		auditExpressions(db);
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
	return withAuditMetadataRefs((refs) =>
		db
			.select(auditActivityFields(refs))
			.from(auditEvents)
			.where(
				and(
					likeText(db, auditEvents.action, "mcp.%"),
					...optionalActivityScope(refs, input),
				),
			)
			.orderBy(desc(auditEvents.timestamp))
			.limit(input.limit),
	);
}

export async function listAnalyticsTraceActivity(
	db: DbClient,
	input: { traceId: string; organizationId?: string },
): Promise<AnalyticsAuditActivityRow[]> {
	const { auditEvents, auditActivityFields, optionalOrganization } =
		auditExpressions(db);
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
	return withAuditMetadataRefs((refs) =>
		db
			.select(auditActivityFields(refs))
			.from(auditEvents)
			.where(
				and(
					// The Pg scaffold does not yet generate trace_id; retain D1's index.
					coreStore(db) === "postgres"
						? sql`${jsonRead(db, auditEvents.metadata, ["traceId"])} = ${input.traceId}`
						: eq(auditEvents.traceId, input.traceId),
					likeText(db, auditEvents.action, "mcp.%"),
					optionalOrganization(input.organizationId),
				),
			)
			.orderBy(asc(auditEvents.timestamp)),
	);
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
	const { auditEvents, auditActivityFields, optionalActivityScope } =
		auditExpressions(db);
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
	return withAuditMetadataRefs((refs) =>
		db
			.select(auditActivityFields(refs))
			.from(auditEvents)
			.where(
				and(
					likeText(db, auditEvents.action, "mcp.%"),
					sql`${auditEvents.timestamp} >= ${auditWindowTime(db, input.startSeconds)}`,
					sql`${auditEvents.timestamp} <= ${auditWindowTime(db, input.endSeconds)}`,
					...optionalActivityScope(refs, input),
				),
			)
			.orderBy(desc(auditEvents.timestamp))
			.limit(input.limit),
	);
}

export async function listAnalyticsRuntimeTraceEvidence(
	db: DbClient,
	input: { organizationId: string; traceIds: string[]; limit?: number },
): Promise<AnalyticsRuntimeTraceEvidenceRow[]> {
	if (!input.traceIds.length) return [];
	const tediRuntimeEvents = coreTable(db, d1TediRuntimeEvents);
	return db
		.select({
			traceId: tediRuntimeEvents.traceId,
			kind: tediRuntimeEvents.kind,
			createdAt: tediRuntimeEvents.createdAt,
			runtimeBackend: tediRuntimeEvents.runtimeBackend,
			// Driver-native JSON: text on D1, decoded JSONB on Postgres.
			payload: sql<unknown>`${tediRuntimeEvents.payload}`.as("payload"),
		})
		.from(tediRuntimeEvents)
		.where(
			and(
				eq(tediRuntimeEvents.organizationId, input.organizationId),
				anyIds(db, tediRuntimeEvents.traceId, [...new Set(input.traceIds)]),
			),
		)
		.orderBy(asc(tediRuntimeEvents.createdAt))
		.limit(input.limit ?? 2000);
}

export async function listAnalyticsRationaleEvidence(
	db: DbClient,
	input: { organizationId: string; decisionIds: string[] },
): Promise<AnalyticsRationaleEvidenceRow[]> {
	if (!input.decisionIds.length) return [];
	const tediRationaleRecords = coreTable(db, d1TediRationaleRecords);
	return db
		.select({
			id: tediRationaleRecords.id,
			category: tediRationaleRecords.category,
			outcomeStatus: tediRationaleRecords.outcomeStatus,
			confidence: tediRationaleRecords.confidence,
			evidence: sql<unknown>`${tediRationaleRecords.evidence}`.as("evidence"),
			createdAt: tediRationaleRecords.createdAt,
			completedAt: tediRationaleRecords.completedAt,
		})
		.from(tediRationaleRecords)
		.where(
			and(
				eq(tediRationaleRecords.orgId, input.organizationId),
				anyIds(db, tediRationaleRecords.id, [...new Set(input.decisionIds)]),
			),
		);
}
