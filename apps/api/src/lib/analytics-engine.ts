/**
 * Analytics Engine SQL API Client
 *
 * Queries Cloudflare Analytics Engine via the REST SQL API.
 * AE is the sole source of truth for MCP tool call metrics.
 *
 * Inbound MCP data point schema (written by apps/mcp trackMcpEvent).
 * Slot constants live in @tedix/api-contract/schemas/mcp-analytics; use
 * MCP_ANALYTICS_BLOB below instead of hardcoding MCP blob positions.
 *
 *   blobs:   [eventType, appId, appSlug, orgId, toolName, errorCode, sessionId, userId, tediId, authType, executionId, traceId, registrationMethod]
 *            blob1       blob2  blob3    blob4  blob5     blob6      blob7      blob8   blob9   blob10   blob11       blob12   blob13
 *   doubles: [success(1/0), durationMs, toolInputSize, toolOutputSize, tokensUsed]
 *            double1        double2     double3        double4         double5
 *   indexes: [appId]
 *
 * Important: AE uses sampling at high volume. Always use `_sample_interval`
 * in aggregations to get accurate estimates:
 *   - COUNT → SUM(_sample_interval)
 *   - AVG(x) → SUM(_sample_interval * x) / SUM(_sample_interval)
 *
 * @see https://developers.cloudflare.com/analytics/analytics-engine/sql-api/
 */

import {
	MCP_ANALYTICS_BLOB,
	MCP_ANALYTICS_DOUBLE,
	MCP_CODEMODE_ANALYTICS_DOUBLE,
} from "@tedix/api-contract/schemas/mcp-analytics";

const MCP_EVENT = {
	codeExec: "code_exec",
	promptGet: "prompt_get",
	toolCall: "tool_call",
} as const;

const MCP_APP_EVENT_TYPES = [
	MCP_EVENT.toolCall,
	MCP_EVENT.promptGet,
	MCP_EVENT.codeExec,
] as const;

const MCP_APP_EVENT_TYPE_SQL = MCP_APP_EVENT_TYPES.map(
	(eventType) => `'${eventType}'`,
).join(", ");

const MCP_CALLER_AUTH_TYPES = new Set([
	"anonymous",
	"apiKey",
	"m2m",
	"oauth",
	"service",
	"tedi",
	"user",
]);

const UUID_LIKE =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface AEQueryResult<T = Record<string, unknown>> {
	data: T[];
	rows: number;
	rows_before_limit_at_least: number;
}

/**
 * Check if AE query env vars are configured.
 * Returns false during local dev when Worker secrets aren't available.
 */
export function hasAEConfig(env: CloudflareEnv): boolean {
	return !!(
		env.CF_ACCOUNT_ID &&
		env.CF_ANALYTICS_TOKEN &&
		env.ANALYTICS_ENGINE_DATASET
	);
}

export function hasWidgetAEConfig(env: CloudflareEnv): boolean {
	return !!(
		env.CF_ACCOUNT_ID &&
		env.CF_ANALYTICS_TOKEN &&
		env.WIDGET_ANALYTICS_DATASET
	);
}

export interface WidgetLifecycleHealth {
	from: string;
	to: string;
	status: "healthy" | "degraded" | "no_data";
	configured: true;
	hasData: boolean;
	latestEventAt: string | null;
	totalEvents: number;
	readyEvents: number;
	sessionAttempts: number;
	failedSessions: number;
	messageSubmissions: number;
	firstTokens: number;
	completedAnswers: number;
	cancelledAnswers: number;
	failedAnswers: number;
	avgReadyMs: number;
	avgSessionMs: number;
	avgFirstTokenMs: number;
	avgAnswerMs: number;
}

export async function getWidgetLifecycleHealthFromAE(
	env: CloudflareEnv,
	organizationId: string,
	from: string,
	to: string,
	installationId?: string,
): Promise<WidgetLifecycleHealth> {
	const result = await queryAE<{
		totalEvents: number;
		readyEvents: number;
		sessionAttempts: number;
		failedSessions: number;
		messageSubmissions: number;
		firstTokens: number;
		completedAnswers: number;
		cancelledAnswers: number;
		failedAnswers: number;
		avgReadyMs: number;
		avgSessionMs: number;
		avgFirstTokenMs: number;
		avgAnswerMs: number;
		latestEventAt: string;
	}>(
		env,
		`SELECT
			SUM(_sample_interval) AS totalEvents,
			SUM(IF(blob1 = 'performance' AND blob2 = 'ready', _sample_interval, 0)) AS readyEvents,
			SUM(IF(blob1 = 'performance' AND blob2 = 'session', _sample_interval, 0)) AS sessionAttempts,
			SUM(IF(blob1 = 'performance' AND blob2 = 'session' AND blob3 = 'failed', _sample_interval, 0)) AS failedSessions,
			SUM(IF(blob1 = 'message_submitted', _sample_interval, 0)) AS messageSubmissions,
			SUM(IF(blob1 = 'first_token', _sample_interval, 0)) AS firstTokens,
			SUM(IF(blob1 = 'answer_completed', _sample_interval, 0)) AS completedAnswers,
			SUM(IF(blob1 = 'answer_cancelled', _sample_interval, 0)) AS cancelledAnswers,
			SUM(IF(blob1 = 'answer_failed', _sample_interval, 0)) AS failedAnswers,
			IF(SUM(IF(blob1 = 'performance' AND blob2 = 'ready', _sample_interval, 0)) = 0, 0.0, SUM(IF(blob1 = 'performance' AND blob2 = 'ready', _sample_interval * double1, 0.0)) / SUM(IF(blob1 = 'performance' AND blob2 = 'ready', _sample_interval, 0))) AS avgReadyMs,
			IF(SUM(IF(blob1 = 'performance' AND blob2 = 'session', _sample_interval, 0)) = 0, 0.0, SUM(IF(blob1 = 'performance' AND blob2 = 'session', _sample_interval * double1, 0.0)) / SUM(IF(blob1 = 'performance' AND blob2 = 'session', _sample_interval, 0))) AS avgSessionMs,
			IF(SUM(IF(blob1 = 'first_token', _sample_interval, 0)) = 0, 0.0, SUM(IF(blob1 = 'first_token', _sample_interval * double1, 0.0)) / SUM(IF(blob1 = 'first_token', _sample_interval, 0))) AS avgFirstTokenMs,
			IF(SUM(IF(blob1 = 'answer_completed', _sample_interval, 0)) = 0, 0.0, SUM(IF(blob1 = 'answer_completed', _sample_interval * double1, 0.0)) / SUM(IF(blob1 = 'answer_completed', _sample_interval, 0))) AS avgAnswerMs,
			MAX(timestamp) AS latestEventAt
			FROM ${env.WIDGET_ANALYTICS_DATASET}
			WHERE blob4 = '${escapeSql(organizationId)}'
				AND blob7 = 'embedded_widget'
				AND blob9 != ''
				${installationId ? `AND blob9 = '${escapeSql(installationId)}'` : ""}
				AND timestamp >= toDateTime('${escapeSql(toAEDatetime(from))}')
			AND timestamp <= toDateTime('${escapeSql(toAEDatetime(to))}')`,
	);
	const row = result.data[0];
	const totalEvents = Math.round(Number(row?.totalEvents) || 0);
	const failedSessions = Math.round(Number(row?.failedSessions) || 0);
	return {
		from,
		to,
		status:
			totalEvents === 0
				? "no_data"
				: failedSessions > 0
					? "degraded"
					: "healthy",
		configured: true,
		hasData: totalEvents > 0,
		latestEventAt: normalizeAEDatetime(row?.latestEventAt),
		totalEvents,
		readyEvents: Math.round(Number(row?.readyEvents) || 0),
		sessionAttempts: Math.round(Number(row?.sessionAttempts) || 0),
		failedSessions,
		messageSubmissions: Math.round(Number(row?.messageSubmissions) || 0),
		firstTokens: Math.round(Number(row?.firstTokens) || 0),
		completedAnswers: Math.round(Number(row?.completedAnswers) || 0),
		cancelledAnswers: Math.round(Number(row?.cancelledAnswers) || 0),
		failedAnswers: Math.round(Number(row?.failedAnswers) || 0),
		avgReadyMs: Math.round(Number(row?.avgReadyMs) || 0),
		avgSessionMs: Math.round(Number(row?.avgSessionMs) || 0),
		avgFirstTokenMs: Math.round(Number(row?.avgFirstTokenMs) || 0),
		avgAnswerMs: Math.round(Number(row?.avgAnswerMs) || 0),
	};
}

/**
 * Execute a SQL query against Analytics Engine.
 * Returns typed rows or throws on error.
 */
async function queryAE<T = Record<string, unknown>>(
	env: CloudflareEnv,
	sql: string,
): Promise<AEQueryResult<T>> {
	const url = `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/analytics_engine/sql`;

	const response = await fetch(url, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${env.CF_ANALYTICS_TOKEN}`,
			"Content-Type": "text/plain",
		},
		body: sql,
	});

	if (!response.ok) {
		const text = await response.text();
		throw new Error(`AE SQL API error (${response.status}): ${text}`);
	}

	return response.json() as Promise<AEQueryResult<T>>;
}

// =============================================================================
// Pre-built queries
// =============================================================================

interface OrgToolCallMetrics {
	totalToolCalls: number;
	successfulToolCalls: number;
	failedToolCalls: number;
	successRate: number;
	uniqueSessions: number;
}

type UpstreamProtocolEra =
	| "modern_2026"
	| "legacy_streamable_2025"
	| "legacy_sse_2024";
type UpstreamProtocolBoundary = "external" | "first_party";
type UpstreamProtocolCallerClass =
	| "os"
	| "tedi_runtime"
	| "human_client"
	| "api_client"
	| "external_agent"
	| "internal_service"
	| "unknown"
	| "pre_attribution";

export interface UpstreamProtocolUsageSummary {
	from: string;
	to: string;
	configured: true;
	sampled: true;
	uses: Record<UpstreamProtocolBoundary, Record<UpstreamProtocolEra, number>>;
	callerClasses: Array<{
		callerClass: UpstreamProtocolCallerClass;
		boundary: UpstreamProtocolBoundary;
		protocolEra: UpstreamProtocolEra;
		estimatedUses: number;
	}>;
	attributionCoverage: {
		version: "caller_class_v1";
		attributedUses: number;
		unknownUses: number;
		preAttributionUses: number;
		attributedPercent: number;
	};
	legacyApps: Array<{
		slug: string;
		protocolEra: Exclude<UpstreamProtocolEra, "modern_2026">;
		estimatedUses: number;
		lastObservedAt: string | null;
	}>;
	legacyAppsTruncated: boolean;
}

/**
 * Read bounded compatibility-removal evidence from the content-free upstream
 * protocol datapoint. Counts are sampling-adjusted estimates, never billing or
 * audit authority. The writer emits these rows only after transport and
 * JSON-RPC success.
 */
export async function getUpstreamProtocolUsageFromAE(
	env: CloudflareEnv,
	from: string,
	to: string,
): Promise<UpstreamProtocolUsageSummary> {
	const [totalsResult, legacyAppsResult, callerClassesResult] =
		await Promise.all([
			queryAE<{
				protocolEra: string;
				boundary: string;
				estimatedUses: number;
			}>(
				env,
				`SELECT
				blob2 AS protocolEra,
				blob5 AS boundary,
				SUM(_sample_interval) AS estimatedUses
			FROM ${env.ANALYTICS_ENGINE_DATASET}
			WHERE blob1 = 'upstream_protocol'
				AND timestamp >= toDateTime('${escapeSql(toAEDatetime(from))}')
				AND timestamp <= toDateTime('${escapeSql(toAEDatetime(to))}')
			GROUP BY protocolEra, boundary`,
			),
			queryAE<{
				appSlug: string;
				protocolEra: string;
				estimatedUses: number;
				lastObservedAt: string;
			}>(
				env,
				`SELECT
				blob3 AS appSlug,
				blob2 AS protocolEra,
				SUM(_sample_interval) AS estimatedUses,
				MAX(timestamp) AS lastObservedAt
			FROM ${env.ANALYTICS_ENGINE_DATASET}
			WHERE blob1 = 'upstream_protocol'
				AND blob5 = 'external'
				AND blob2 IN ('legacy_streamable_2025', 'legacy_sse_2024')
				AND timestamp >= toDateTime('${escapeSql(toAEDatetime(from))}')
				AND timestamp <= toDateTime('${escapeSql(toAEDatetime(to))}')
			GROUP BY appSlug, protocolEra
			ORDER BY estimatedUses DESC, appSlug ASC
			LIMIT 26`,
			),
			queryAE<{
				callerClass: string;
				boundary: string;
				protocolEra: string;
				estimatedUses: number;
			}>(
				env,
				`SELECT
				if(
					empty(blob6),
					if(empty(blob7), 'pre_attribution', 'unknown'),
					if(blob6 IN ('os', 'tedi_runtime', 'human_client', 'api_client', 'external_agent', 'internal_service', 'unknown'), blob6, 'unknown')
				) AS callerClass,
				blob5 AS boundary,
				blob2 AS protocolEra,
				SUM(_sample_interval) AS estimatedUses
			FROM ${env.ANALYTICS_ENGINE_DATASET}
			WHERE blob1 = 'upstream_protocol'
				AND timestamp >= toDateTime('${escapeSql(toAEDatetime(from))}')
				AND timestamp <= toDateTime('${escapeSql(toAEDatetime(to))}')
			GROUP BY callerClass, boundary, protocolEra`,
			),
		]);

	const emptyEraCounts = (): Record<UpstreamProtocolEra, number> => ({
		modern_2026: 0,
		legacy_streamable_2025: 0,
		legacy_sse_2024: 0,
	});
	const uses = {
		external: emptyEraCounts(),
		first_party: emptyEraCounts(),
	};
	for (const row of totalsResult.data) {
		if (
			(row.boundary !== "external" && row.boundary !== "first_party") ||
			(row.protocolEra !== "modern_2026" &&
				row.protocolEra !== "legacy_streamable_2025" &&
				row.protocolEra !== "legacy_sse_2024")
		) {
			continue;
		}
		uses[row.boundary][row.protocolEra] = Math.max(
			0,
			Math.round(Number(row.estimatedUses) || 0),
		);
	}

	const legacyApps = legacyAppsResult.data
		.slice(0, 25)
		.filter(
			(
				row,
			): row is typeof row & {
				protocolEra: "legacy_streamable_2025" | "legacy_sse_2024";
			} =>
				row.protocolEra === "legacy_streamable_2025" ||
				row.protocolEra === "legacy_sse_2024",
		)
		.map((row) => ({
			slug: row.appSlug,
			protocolEra: row.protocolEra,
			estimatedUses: Math.max(0, Math.round(Number(row.estimatedUses) || 0)),
			lastObservedAt: normalizeAEDatetime(row.lastObservedAt),
		}));
	const validCallerClasses = new Set<UpstreamProtocolCallerClass>([
		"os",
		"tedi_runtime",
		"human_client",
		"api_client",
		"external_agent",
		"internal_service",
		"unknown",
		"pre_attribution",
	]);
	const callerClasses = callerClassesResult.data
		.filter(
			(
				row,
			): row is typeof row & {
				callerClass: UpstreamProtocolCallerClass;
				boundary: UpstreamProtocolBoundary;
				protocolEra: UpstreamProtocolEra;
			} =>
				validCallerClasses.has(
					row.callerClass as UpstreamProtocolCallerClass,
				) &&
				(row.boundary === "external" || row.boundary === "first_party") &&
				(row.protocolEra === "modern_2026" ||
					row.protocolEra === "legacy_streamable_2025" ||
					row.protocolEra === "legacy_sse_2024"),
		)
		.map((row) => ({
			callerClass: row.callerClass,
			boundary: row.boundary,
			protocolEra: row.protocolEra,
			estimatedUses: Math.max(0, Math.round(Number(row.estimatedUses) || 0)),
		}));
	const attributionCoverage = callerClasses.reduce(
		(coverage, row) => {
			if (row.callerClass === "pre_attribution") {
				coverage.preAttributionUses += row.estimatedUses;
			} else if (row.callerClass === "unknown") {
				coverage.unknownUses += row.estimatedUses;
			} else {
				coverage.attributedUses += row.estimatedUses;
			}
			return coverage;
		},
		{ attributedUses: 0, unknownUses: 0, preAttributionUses: 0 },
	);
	const coverageTotal =
		attributionCoverage.attributedUses +
		attributionCoverage.unknownUses +
		attributionCoverage.preAttributionUses;

	return {
		from,
		to,
		configured: true,
		sampled: true,
		uses,
		callerClasses,
		attributionCoverage: {
			version: "caller_class_v1",
			...attributionCoverage,
			attributedPercent:
				coverageTotal === 0
					? 0
					: Math.round(
							(attributionCoverage.attributedUses / coverageTotal) * 10_000,
						) / 100,
		},
		legacyApps,
		legacyAppsTruncated: legacyAppsResult.data.length > 25,
	};
}

export interface ExternalAgentValidationSlo {
	from: string;
	to: string;
	status: "healthy" | "degraded" | "no_data";
	configured: boolean;
	hasData: boolean;
	latestValidationAt: string | null;
	freshnessLagMs: number | null;
	totalValidations: number;
	successfulValidations: number;
	inactiveValidations: number;
	unavailableValidations: number;
	availabilityPercent: number;
	avgLatencyMs: number;
}

/** Query the org-scoped external-agent validation health signal. */
export async function getExternalAgentValidationSloFromAE(
	env: CloudflareEnv,
	organizationId: string,
	from: string,
	to: string,
): Promise<ExternalAgentValidationSlo> {
	const result = await queryAE<{
		totalValidations: number;
		successfulValidations: number;
		inactiveValidations: number;
		unavailableValidations: number;
		avgLatencyMs: number;
		latestValidationAt: string;
	}>(
		env,
		`SELECT
			SUM(_sample_interval) AS totalValidations,
			SUM(IF(${MCP_ANALYTICS_DOUBLE.success} = 1, _sample_interval, 0)) AS successfulValidations,
			SUM(IF(${MCP_ANALYTICS_BLOB.errorCode} = 'inactive', _sample_interval, 0)) AS inactiveValidations,
			SUM(IF(${MCP_ANALYTICS_BLOB.errorCode} = 'validation_unavailable', _sample_interval, 0)) AS unavailableValidations,
			SUM(_sample_interval * ${MCP_ANALYTICS_DOUBLE.durationMs}) / SUM(_sample_interval) AS avgLatencyMs,
			MAX(timestamp) AS latestValidationAt
		FROM ${env.ANALYTICS_ENGINE_DATASET}
		WHERE ${MCP_ANALYTICS_BLOB.eventType} = 'auth_validation'
			AND ${MCP_ANALYTICS_BLOB.organizationId} = '${escapeSql(organizationId)}'
			AND timestamp >= toDateTime('${escapeSql(toAEDatetime(from))}')
			AND timestamp <= toDateTime('${escapeSql(toAEDatetime(to))}')`,
	);
	const row = result.data[0];
	const total = Number(row?.totalValidations) || 0;
	const unavailable = Number(row?.unavailableValidations) || 0;
	const latestValidationAt = normalizeAEDatetime(row?.latestValidationAt);
	return {
		from,
		to,
		status: total === 0 ? "no_data" : unavailable > 0 ? "degraded" : "healthy",
		configured: true,
		hasData: total > 0,
		latestValidationAt,
		freshnessLagMs:
			latestValidationAt === null
				? null
				: Math.max(0, Date.parse(to) - Date.parse(latestValidationAt)),
		totalValidations: Math.round(total),
		successfulValidations: Math.round(Number(row?.successfulValidations) || 0),
		inactiveValidations: Math.round(Number(row?.inactiveValidations) || 0),
		unavailableValidations: Math.round(unavailable),
		availabilityPercent:
			total > 0 ? Math.round(((total - unavailable) / total) * 1000) / 10 : 0,
		avgLatencyMs: Math.round(Number(row?.avgLatencyMs) || 0),
	};
}

function normalizeAEDatetime(value: string | undefined): string | null {
	if (!value) return null;
	const normalized = value.includes("T")
		? value
		: `${value.replace(" ", "T")}Z`;
	const timestamp = Date.parse(normalized);
	return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

/**
 * Get org-level MCP tool call metrics from AE.
 * Used by the app analytics getMetrics endpoint.
 */
async function getOrgToolCallMetrics(
	env: CloudflareEnv,
	organizationId: string,
	from: string,
	to: string,
): Promise<OrgToolCallMetrics> {
	const dataset = env.ANALYTICS_ENGINE_DATASET;

	const result = await queryAE<{
		totalCalls: number;
		successCalls: number;
		failedCalls: number;
		uniqueSessions: number;
	}>(
		env,
		`SELECT
			SUM(_sample_interval) AS totalCalls,
			SUM(IF(${MCP_ANALYTICS_DOUBLE.success} = 1, _sample_interval, 0.0)) AS successCalls,
			SUM(IF(${MCP_ANALYTICS_DOUBLE.success} = 0, _sample_interval, 0.0)) AS failedCalls,
			COUNT(DISTINCT ${MCP_ANALYTICS_BLOB.sessionId}) AS uniqueSessions
		FROM ${dataset}
		WHERE
			${MCP_ANALYTICS_BLOB.eventType} = '${MCP_EVENT.toolCall}'
			AND ${MCP_ANALYTICS_BLOB.organizationId} = '${escapeSql(organizationId)}'
			AND timestamp >= toDateTime('${escapeSql(toAEDatetime(from))}')
			AND timestamp <= toDateTime('${escapeSql(toAEDatetime(to))}')`,
	);

	const row = result.data[0];
	if (!row) {
		return {
			totalToolCalls: 0,
			successfulToolCalls: 0,
			failedToolCalls: 0,
			successRate: 0,
			uniqueSessions: 0,
		};
	}

	const total = Number(row.totalCalls) || 0;
	const success = Number(row.successCalls) || 0;
	const failed = Number(row.failedCalls) || 0;

	return {
		totalToolCalls: Math.round(total),
		successfulToolCalls: Math.round(success),
		failedToolCalls: Math.round(failed),
		successRate: total > 0 ? Math.round((success / total) * 1000) / 10 : 0,
		uniqueSessions: Number(row.uniqueSessions) || 0,
	};
}

/**
 * App-scoped tool-call metrics. Mirrors getOrgToolCallMetrics but filters by
 * appId (blob2) via buildDirectAppWhere + correlated sub-app wheres, so an
 * aggregator app (e.g. `acme-unified`) counts its prefixed sub-app tool calls.
 * The org-scoped variant filtered organizationId (blob4), which does not match
 * the events for aggregated apps — that mismatch is why the OS session metrics
 * rendered 0 even with live traffic.
 */
async function getAppToolCallMetrics(
	env: CloudflareEnv,
	appId: string,
	from: string,
	to: string,
): Promise<OrgToolCallMetrics> {
	const dataset = env.ANALYTICS_ENGINE_DATASET;
	const correlatedWheres = await buildCorrelatedToolWheres(
		env,
		appId,
		from,
		to,
	);
	const wheres = [
		`${buildDirectAppWhere(appId, from, to)} AND ${MCP_ANALYTICS_BLOB.eventType} = '${MCP_EVENT.toolCall}'`,
		...correlatedWheres.map(
			(where) =>
				`${where} AND ${MCP_ANALYTICS_BLOB.eventType} = '${MCP_EVENT.toolCall}' AND ${MCP_ANALYTICS_BLOB.appId} != '${escapeSql(appId)}'`,
		),
	];

	const results = await Promise.all(
		wheres.map((where) =>
			queryAE<{
				totalCalls: number;
				successCalls: number;
				failedCalls: number;
				uniqueSessions: number;
			}>(
				env,
				`SELECT
					SUM(_sample_interval) AS totalCalls,
					SUM(IF(${MCP_ANALYTICS_DOUBLE.success} = 1, _sample_interval, 0.0)) AS successCalls,
					SUM(IF(${MCP_ANALYTICS_DOUBLE.success} = 0, _sample_interval, 0.0)) AS failedCalls,
					COUNT(DISTINCT ${MCP_ANALYTICS_BLOB.sessionId}) AS uniqueSessions
				FROM ${dataset}
				WHERE ${where}`,
			),
		),
	);

	let total = 0;
	let success = 0;
	let failed = 0;
	let sessions = 0;
	for (const result of results) {
		const row = result.data[0];
		if (!row) continue;
		total += Number(row.totalCalls) || 0;
		success += Number(row.successCalls) || 0;
		failed += Number(row.failedCalls) || 0;
		sessions += Number(row.uniqueSessions) || 0;
	}

	return {
		totalToolCalls: Math.round(total),
		successfulToolCalls: Math.round(success),
		failedToolCalls: Math.round(failed),
		successRate: total > 0 ? Math.round((success / total) * 1000) / 10 : 0,
		uniqueSessions: Math.round(sessions),
	};
}

/**
 * App-scoped metrics with period-over-period comparison (current vs previous
 * window of equal length).
 */
export async function getAppMetricsFromAE(
	env: CloudflareEnv,
	appId: string,
	from: string,
	to: string,
) {
	const fromDate = new Date(from);
	const toDate = new Date(to);
	const periodMs = toDate.getTime() - fromDate.getTime();
	const prevFrom = new Date(fromDate.getTime() - periodMs).toISOString();
	const prevTo = from;

	const [current, prev] = await Promise.all([
		getAppToolCallMetrics(env, appId, from, to),
		getAppToolCallMetrics(env, appId, prevFrom, prevTo),
	]);

	const calcChange = (curr: number, previous: number): number | undefined => {
		if (previous === 0) return curr > 0 ? 100 : undefined;
		return Math.round(((curr - previous) / previous) * 1000) / 10;
	};

	return {
		totalSessions: current.uniqueSessions,
		sessionsChange: calcChange(current.uniqueSessions, prev.uniqueSessions),
		// AE doesn't track messages per session — use tool calls per session
		avgMessages:
			current.totalToolCalls > 0
				? Math.round(
						(current.totalToolCalls / Math.max(current.uniqueSessions, 1)) * 10,
					) / 10
				: 0,
		avgMessagesChange:
			prev.totalToolCalls > 0
				? calcChange(
						current.totalToolCalls / Math.max(current.uniqueSessions, 1),
						prev.totalToolCalls / Math.max(prev.uniqueSessions, 1),
					)
				: undefined,
		successRate: current.successRate,
		successRateChange: calcChange(current.successRate, prev.successRate),
	};
}

/**
 * Get tool call metrics for a specific user (tedi) from AE.
 * Correlates via the userId slot, which contains the tedi's descopeUserId.
 */
export async function getUserToolCallMetrics(
	env: CloudflareEnv,
	userId: string,
	from: string,
	to: string,
): Promise<{ totalCalls: number; failedCalls: number }> {
	const dataset = env.ANALYTICS_ENGINE_DATASET;

	const result = await queryAE<{
		totalCalls: number;
		failedCalls: number;
	}>(
		env,
		`SELECT
			SUM(_sample_interval) AS totalCalls,
			SUM(IF(${MCP_ANALYTICS_DOUBLE.success} = 0, _sample_interval, 0.0)) AS failedCalls
		FROM ${dataset}
		WHERE
			${MCP_ANALYTICS_BLOB.eventType} = '${MCP_EVENT.toolCall}'
			AND ${MCP_ANALYTICS_BLOB.userId} = '${escapeSql(userId)}'
			AND timestamp >= toDateTime('${escapeSql(toAEDatetime(from))}')
			AND timestamp <= toDateTime('${escapeSql(toAEDatetime(to))}')`,
	);

	const row = result.data[0];
	return {
		totalCalls: Math.round(Number(row?.totalCalls) || 0),
		failedCalls: Math.round(Number(row?.failedCalls) || 0),
	};
}

/**
 * Get per-app tool breakdown from AE.
 * Returns tool-level stats (calls, success rate, avg latency) for a specific app.
 */
export async function getAppToolBreakdownFromAE(
	env: CloudflareEnv,
	appId: string,
	from: string,
	to: string,
	limit = 50,
): Promise<
	Array<{
		toolName: string;
		totalCalls: number;
		successCalls: number;
		failedCalls: number;
		successRate: number;
		avgDurationMs: number;
		maxDurationMs: number;
		avgInputBytes: number;
		avgOutputBytes: number;
	}>
> {
	const dataset = env.ANALYTICS_ENGINE_DATASET;
	const correlatedToolWheres = await buildCorrelatedToolWheres(
		env,
		appId,
		from,
		to,
	);

	type ToolBreakdownRow = {
		toolName: string;
		successValue: number;
		calls: number;
		durationSum: number;
		maxDuration: number;
		inputSizeSum: number;
		outputSizeSum: number;
	};

	const queries = [
		queryAE<ToolBreakdownRow>(
			env,
			`SELECT
				${MCP_ANALYTICS_BLOB.toolName} AS toolName,
				${MCP_ANALYTICS_DOUBLE.success} AS successValue,
				SUM(_sample_interval) AS calls,
				SUM(_sample_interval * ${MCP_ANALYTICS_DOUBLE.durationMs}) AS durationSum,
				MAX(${MCP_ANALYTICS_DOUBLE.durationMs}) AS maxDuration,
				SUM(_sample_interval * ${MCP_ANALYTICS_DOUBLE.toolInputSize}) AS inputSizeSum,
				SUM(_sample_interval * ${MCP_ANALYTICS_DOUBLE.toolOutputSize}) AS outputSizeSum
			FROM ${dataset}
			WHERE ${buildDirectAppWhere(appId, from, to)}
				AND ${MCP_ANALYTICS_BLOB.eventType} = '${MCP_EVENT.toolCall}'
				AND ${MCP_ANALYTICS_BLOB.toolName} != ''
			GROUP BY ${MCP_ANALYTICS_BLOB.toolName}, ${MCP_ANALYTICS_DOUBLE.success}`,
		),
		...correlatedToolWheres.map((where) =>
			queryAE<ToolBreakdownRow>(
				env,
				`SELECT
					${MCP_ANALYTICS_BLOB.toolName} AS toolName,
					${MCP_ANALYTICS_DOUBLE.success} AS successValue,
					SUM(_sample_interval) AS calls,
					SUM(_sample_interval * ${MCP_ANALYTICS_DOUBLE.durationMs}) AS durationSum,
					MAX(${MCP_ANALYTICS_DOUBLE.durationMs}) AS maxDuration,
					SUM(_sample_interval * ${MCP_ANALYTICS_DOUBLE.toolInputSize}) AS inputSizeSum,
					SUM(_sample_interval * ${MCP_ANALYTICS_DOUBLE.toolOutputSize}) AS outputSizeSum
				FROM ${dataset}
				WHERE ${where}
					AND ${MCP_ANALYTICS_BLOB.toolName} != ''
					AND ${MCP_ANALYTICS_BLOB.appId} != '${escapeSql(appId)}'
				GROUP BY ${MCP_ANALYTICS_BLOB.toolName}, ${MCP_ANALYTICS_DOUBLE.success}`,
			),
		),
	];

	const results = await Promise.all(queries);

	const rows = results.flatMap((result) => result.data);

	const byTool = new Map<
		string,
		{
			totalCalls: number;
			successCalls: number;
			failedCalls: number;
			durationSum: number;
			maxDurationMs: number;
			inputSizeSum: number;
			outputSizeSum: number;
		}
	>();

	for (const row of rows) {
		const calls = Number(row.calls) || 0;
		const bucket = byTool.get(row.toolName) ?? {
			totalCalls: 0,
			successCalls: 0,
			failedCalls: 0,
			durationSum: 0,
			maxDurationMs: 0,
			inputSizeSum: 0,
			outputSizeSum: 0,
		};
		bucket.totalCalls += calls;
		if (Number(row.successValue) === 1) bucket.successCalls += calls;
		else bucket.failedCalls += calls;
		bucket.durationSum += Number(row.durationSum) || 0;
		bucket.maxDurationMs = Math.max(
			bucket.maxDurationMs,
			Number(row.maxDuration) || 0,
		);
		bucket.inputSizeSum += Number(row.inputSizeSum) || 0;
		bucket.outputSizeSum += Number(row.outputSizeSum) || 0;
		byTool.set(row.toolName, bucket);
	}

	return Array.from(byTool.entries())
		.map(([toolName, bucket]) => {
			const total = Math.round(bucket.totalCalls);
			const success = Math.round(bucket.successCalls);
			return {
				toolName,
				totalCalls: total,
				successCalls: success,
				failedCalls: Math.round(bucket.failedCalls),
				successRate: total > 0 ? Math.round((success / total) * 1000) / 10 : 0,
				avgDurationMs:
					bucket.totalCalls > 0
						? Math.round(bucket.durationSum / bucket.totalCalls)
						: 0,
				maxDurationMs: Math.round(bucket.maxDurationMs),
				avgInputBytes:
					bucket.totalCalls > 0
						? Math.round(bucket.inputSizeSum / bucket.totalCalls)
						: 0,
				avgOutputBytes:
					bucket.totalCalls > 0
						? Math.round(bucket.outputSizeSum / bucket.totalCalls)
						: 0,
			};
		})
		.sort((left, right) => right.totalCalls - left.totalCalls)
		.slice(0, limit);
}

async function getAppSummaryRows(
	env: CloudflareEnv,
	dataset: string,
	appId: string,
	from: string,
	to: string,
): Promise<{
	eventRows: Array<{
		eventType: string;
		successValue: number;
		totalEvents: number;
		durationSum: number;
	}>;
	callerTypes: Set<string>;
	userIds: Set<string>;
}> {
	const correlatedToolWheres = await buildCorrelatedToolWheres(
		env,
		appId,
		from,
		to,
	);
	const directWhere = buildDirectAppWhere(appId, from, to);
	const eventWheres = [
		`${directWhere} AND ${MCP_ANALYTICS_BLOB.eventType} IN (${MCP_APP_EVENT_TYPE_SQL})`,
		...correlatedToolWheres.map(
			(where) =>
				`${where} AND ${MCP_ANALYTICS_BLOB.appId} != '${escapeSql(appId)}'`,
		),
	];

	const [eventResults, callerTypeResults, userResults] = await Promise.all([
		Promise.all(
			eventWheres.map((where) =>
				queryAE<{
					eventType: string;
					successValue: number;
					totalEvents: number;
					durationSum: number;
				}>(
					env,
					`SELECT
						${MCP_ANALYTICS_BLOB.eventType} AS eventType,
						${MCP_ANALYTICS_DOUBLE.success} AS successValue,
						SUM(_sample_interval) AS totalEvents,
						SUM(_sample_interval * ${MCP_ANALYTICS_DOUBLE.durationMs}) AS durationSum
					FROM ${dataset}
					WHERE ${where}
					GROUP BY ${MCP_ANALYTICS_BLOB.eventType}, ${MCP_ANALYTICS_DOUBLE.success}`,
				),
			),
		),
		Promise.all(
			eventWheres.map((where) =>
				queryAE<{ callerType: string }>(
					env,
					`SELECT ${MCP_ANALYTICS_BLOB.authType} AS callerType
					FROM ${dataset}
					WHERE ${where}
						AND ${MCP_ANALYTICS_BLOB.authType} != ''
					GROUP BY ${MCP_ANALYTICS_BLOB.authType}
					ORDER BY callerType`,
				),
			),
		),
		Promise.all(
			eventWheres.map((where) =>
				queryAE<{ userId: string }>(
					env,
					`SELECT ${MCP_ANALYTICS_BLOB.userId} AS userId
					FROM ${dataset}
					WHERE ${where}
						AND ${MCP_ANALYTICS_BLOB.userId} != ''
					GROUP BY ${MCP_ANALYTICS_BLOB.userId}`,
				),
			),
		),
	]);

	return {
		eventRows: eventResults.flatMap((result) => result.data),
		callerTypes: new Set(
			callerTypeResults.flatMap((result) =>
				result.data
					.map((row) => normalizeCallerType(row.callerType))
					.filter((callerType) => callerType !== null),
			),
		),
		userIds: new Set(
			userResults.flatMap((result) =>
				result.data.map((row) => row.userId).filter(Boolean),
			),
		),
	};
}

function normalizeCallerType(value: string | null | undefined): string | null {
	if (!value) return null;
	const trimmed = value.trim();
	if (!trimmed || UUID_LIKE.test(trimmed)) return null;

	const normalized =
		trimmed === "api_key" || trimmed === "apikey" ? "apiKey" : trimmed;
	return MCP_CALLER_AUTH_TYPES.has(normalized) ? normalized : null;
}

/**
 * Get per-app summary metrics from AE.
 * Covers all event types (tool_call, prompt_get, code_exec).
 */
export async function getAppSummaryFromAE(
	env: CloudflareEnv,
	appId: string,
	from: string,
	to: string,
): Promise<{
	totalEvents: number;
	toolCalls: number;
	promptCalls: number;
	codeExecs: number;
	successRate: number;
	avgDurationMs: number;
	uniqueUsers: number;
	uniqueCallerTypes: string[];
}> {
	const dataset = env.ANALYTICS_ENGINE_DATASET;
	const { eventRows, callerTypes, userIds } = await getAppSummaryRows(
		env,
		dataset,
		appId,
		from,
		to,
	);

	let totalEvents = 0;
	let totalSuccess = 0;
	let toolCalls = 0;
	let promptCalls = 0;
	let codeExecs = 0;
	let weightedDurationSum = 0;

	for (const row of eventRows) {
		const events = Math.round(Number(row.totalEvents) || 0);
		const success = Number(row.successValue) === 1 ? events : 0;
		totalEvents += events;
		totalSuccess += success;
		weightedDurationSum += Number(row.durationSum) || 0;

		if (row.eventType === "tool_call") toolCalls += events;
		else if (row.eventType === "prompt_get") promptCalls += events;
		else if (row.eventType === "code_exec") codeExecs += events;
	}

	return {
		totalEvents,
		toolCalls,
		promptCalls,
		codeExecs,
		successRate:
			totalEvents > 0
				? Math.round((totalSuccess / totalEvents) * 1000) / 10
				: 0,
		avgDurationMs:
			totalEvents > 0 ? Math.round(weightedDurationSum / totalEvents) : 0,
		uniqueUsers: userIds.size,
		uniqueCallerTypes: Array.from(callerTypes),
	};
}

/**
 * Drill into a single Code Mode execution by executionId.
 * Returns the parent code_exec event + all inner tool_call events
 * correlated via blob11 (executionId).
 */
export async function getExecutionDrilldownFromAE(
	env: CloudflareEnv,
	executionId: string,
	organizationId?: string,
): Promise<{
	execution: {
		toolName: string;
		success: boolean;
		durationMs: number;
		timestamp: string;
		eventType: string;
		appSlug: string;
	} | null;
	toolCalls: Array<{
		toolName: string;
		success: boolean;
		durationMs: number;
		timestamp: string;
		eventType: string;
		appSlug: string;
	}>;
}> {
	const dataset = env.ANALYTICS_ENGINE_DATASET;

	const result = await queryAE<{
		toolName: string;
		success: number;
		durationMs: number;
		timestamp: string;
		eventType: string;
		appSlug: string;
	}>(
		env,
		`SELECT
			${MCP_ANALYTICS_BLOB.toolName} AS toolName,
			${MCP_ANALYTICS_DOUBLE.success} AS success,
			${MCP_ANALYTICS_DOUBLE.durationMs} AS durationMs,
			timestamp,
			${MCP_ANALYTICS_BLOB.eventType} AS eventType,
			${MCP_ANALYTICS_BLOB.appSlug} AS appSlug
		FROM ${dataset}
		WHERE
			${MCP_ANALYTICS_BLOB.executionId} = '${escapeSql(executionId)}'
			AND ${MCP_ANALYTICS_BLOB.eventType} IN ('${MCP_EVENT.codeExec}', '${MCP_EVENT.toolCall}')
			${organizationId ? `AND ${MCP_ANALYTICS_BLOB.organizationId} = '${escapeSql(organizationId)}'` : ""}
		ORDER BY timestamp ASC`,
	);

	let execution: {
		toolName: string;
		success: boolean;
		durationMs: number;
		timestamp: string;
		eventType: string;
		appSlug: string;
	} | null = null;

	const toolCalls: Array<{
		toolName: string;
		success: boolean;
		durationMs: number;
		timestamp: string;
		eventType: string;
		appSlug: string;
	}> = [];

	for (const row of result.data) {
		const mapped = {
			toolName: row.toolName,
			success: Number(row.success) === 1,
			durationMs: Math.round(Number(row.durationMs) || 0),
			timestamp: String(row.timestamp),
			eventType: row.eventType,
			appSlug: row.appSlug,
		};

		if (row.eventType === MCP_EVENT.codeExec) {
			execution = mapped;
		} else {
			toolCalls.push(mapped);
		}
	}

	return { execution, toolCalls };
}

/**
 * Get time-series event metrics for a specific app from AE.
 * Buckets events by hour or day, covering tool_call, prompt_get, and code_exec.
 */
export async function getAppTimeSeriesFromAE(
	env: CloudflareEnv,
	appId: string,
	from: string,
	to: string,
	granularity: "hour" | "day" = "day",
): Promise<
	Array<{
		bucket: string;
		totalEvents: number;
		successEvents: number;
		failedEvents: number;
		avgDurationMs: number;
	}>
> {
	const dataset = env.ANALYTICS_ENGINE_DATASET;
	const bucketFn = granularity === "hour" ? "toStartOfHour" : "toStartOfDay";
	const correlatedToolWheres = await buildCorrelatedToolWheres(
		env,
		appId,
		from,
		to,
	);
	const eventWheres = [
		`${buildDirectAppWhere(appId, from, to)} AND ${MCP_ANALYTICS_BLOB.eventType} IN (${MCP_APP_EVENT_TYPE_SQL})`,
		...correlatedToolWheres.map(
			(where) =>
				`${where} AND ${MCP_ANALYTICS_BLOB.appId} != '${escapeSql(appId)}'`,
		),
	];

	type TimeSeriesRow = {
		bucket: string;
		successValue: number;
		totalEvents: number;
		durationSum: number;
	};

	const results = await Promise.all(
		eventWheres.map((where) =>
			queryAE<TimeSeriesRow>(
				env,
				`SELECT
					${bucketFn}(timestamp) AS bucket,
					${MCP_ANALYTICS_DOUBLE.success} AS successValue,
					SUM(_sample_interval) AS totalEvents,
					SUM(_sample_interval * ${MCP_ANALYTICS_DOUBLE.durationMs}) AS durationSum
				FROM ${dataset}
				WHERE ${where}
				GROUP BY bucket, ${MCP_ANALYTICS_DOUBLE.success}
				ORDER BY bucket ASC`,
			),
		),
	);

	const rows = results.flatMap((result) => result.data);
	const byBucket = new Map<
		string,
		{
			totalEvents: number;
			successEvents: number;
			failedEvents: number;
			durationSum: number;
		}
	>();

	for (const row of rows) {
		const bucketName = String(row.bucket);
		const events = Number(row.totalEvents) || 0;
		const bucket = byBucket.get(bucketName) ?? {
			totalEvents: 0,
			successEvents: 0,
			failedEvents: 0,
			durationSum: 0,
		};
		bucket.totalEvents += events;
		if (Number(row.successValue) === 1) bucket.successEvents += events;
		else bucket.failedEvents += events;
		bucket.durationSum += Number(row.durationSum) || 0;
		byBucket.set(bucketName, bucket);
	}

	return Array.from(byBucket.entries()).map(([bucket, row]) => ({
		bucket,
		totalEvents: Math.round(row.totalEvents),
		successEvents: Math.round(row.successEvents),
		failedEvents: Math.round(row.failedEvents),
		avgDurationMs:
			row.totalEvents > 0 ? Math.round(row.durationSum / row.totalEvents) : 0,
	}));
}

/**
 * Get recent code_exec events for an app from AE.
 * Returns individual execution rows with executionId for drill-down navigation.
 */
export async function getRecentExecutionsFromAE(
	env: CloudflareEnv,
	appId: string,
	from: string,
	to: string,
	limit = 20,
): Promise<
	Array<{
		executionId: string;
		success: boolean;
		durationMs: number;
		timestamp: string;
		toolCount: number;
	}>
> {
	const dataset = env.ANALYTICS_ENGINE_DATASET;

	const result = await queryAE<{
		executionId: string;
		success: number;
		durationMs: number;
		timestamp: string;
	}>(
		env,
		`SELECT
			${MCP_ANALYTICS_BLOB.executionId} AS executionId,
			${MCP_ANALYTICS_DOUBLE.success} AS success,
			${MCP_ANALYTICS_DOUBLE.durationMs} AS durationMs,
			timestamp
		FROM ${dataset}
		WHERE
			${MCP_ANALYTICS_BLOB.eventType} = '${MCP_EVENT.codeExec}'
			AND ${MCP_ANALYTICS_BLOB.appId} = '${escapeSql(appId)}'
			AND ${MCP_ANALYTICS_BLOB.executionId} != ''
			AND timestamp >= toDateTime('${escapeSql(toAEDatetime(from))}')
			AND timestamp <= toDateTime('${escapeSql(toAEDatetime(to))}')
		ORDER BY timestamp DESC
		LIMIT ${limit}`,
	);

	if (result.data.length === 0) return [];

	const executionIds = result.data
		.map((r) => `'${escapeSql(r.executionId)}'`)
		.join(",");
	const toolCounts = await queryAE<{
		executionId: string;
		cnt: number;
	}>(
		env,
		`SELECT
			${MCP_ANALYTICS_BLOB.executionId} AS executionId,
			COUNT() AS cnt
		FROM ${dataset}
		WHERE
			${MCP_ANALYTICS_BLOB.eventType} = '${MCP_EVENT.toolCall}'
			AND ${MCP_ANALYTICS_BLOB.executionId} IN (${executionIds})
			AND timestamp >= toDateTime('${escapeSql(toAEDatetime(from))}')
			AND timestamp <= toDateTime('${escapeSql(toAEDatetime(to))}')
		GROUP BY ${MCP_ANALYTICS_BLOB.executionId}`,
	);

	const countMap = new Map(
		toolCounts.data.map((r) => [r.executionId, Math.round(Number(r.cnt) || 0)]),
	);

	return result.data.map((row) => ({
		executionId: row.executionId,
		success: Number(row.success) === 1,
		durationMs: Math.round(Number(row.durationMs) || 0),
		timestamp: String(row.timestamp),
		toolCount: countMap.get(row.executionId) ?? 0,
	}));
}

async function getCodeExecutionIdsForApp(
	env: CloudflareEnv,
	appId: string,
	from: string,
	to: string,
	limit = 1000,
): Promise<string[]> {
	const dataset = env.ANALYTICS_ENGINE_DATASET;
	const result = await queryAE<{ executionId: string }>(
		env,
		`SELECT
			${MCP_ANALYTICS_BLOB.executionId} AS executionId,
			timestamp
		FROM ${dataset}
		WHERE
			${MCP_ANALYTICS_BLOB.eventType} = '${MCP_EVENT.codeExec}'
			AND ${MCP_ANALYTICS_BLOB.appId} = '${escapeSql(appId)}'
			AND ${MCP_ANALYTICS_BLOB.executionId} != ''
			AND timestamp >= toDateTime('${escapeSql(toAEDatetime(from))}')
			AND timestamp <= toDateTime('${escapeSql(toAEDatetime(to))}')
		ORDER BY timestamp DESC
		LIMIT ${limit}`,
	);

	return Array.from(
		new Set(
			result.data
				.map((row) => row.executionId)
				.filter(
					(executionId) => typeof executionId === "string" && executionId,
				),
		),
	);
}

function buildDirectAppWhere(appId: string, from: string, to: string): string {
	return `${MCP_ANALYTICS_BLOB.appId} = '${escapeSql(appId)}'
			AND timestamp >= toDateTime('${escapeSql(toAEDatetime(from))}')
			AND timestamp <= toDateTime('${escapeSql(toAEDatetime(to))}')`;
}

async function buildCorrelatedToolWheres(
	env: CloudflareEnv,
	appId: string,
	from: string,
	to: string,
): Promise<string[]> {
	const executionIds = await getCodeExecutionIdsForApp(env, appId, from, to);
	return chunkArray(executionIds, 80).map(
		(chunk) => `${MCP_ANALYTICS_BLOB.eventType} = '${MCP_EVENT.toolCall}'
			AND ${MCP_ANALYTICS_BLOB.executionId} IN (${chunk.map((id) => `'${escapeSql(id)}'`).join(",")})
			AND timestamp >= toDateTime('${escapeSql(toAEDatetime(from))}')
			AND timestamp <= toDateTime('${escapeSql(toAEDatetime(to))}')`,
	);
}

function chunkArray<T>(items: T[], size: number): T[][] {
	const chunks: T[][] = [];
	for (let index = 0; index < items.length; index += size) {
		chunks.push(items.slice(index, index + size));
	}
	return chunks;
}

// =============================================================================
// Code Mode Analytics (tedix_codemode_analytics_{development,production} dataset)
// =============================================================================

/**
 * Code Mode AE datapoint schema. Rows are written directly by apps/mcp.
 *
 *   blobs:  same positional layout as MCP_ANALYTICS_BLOB
 *           blob1=eventType ("rpc"|"exec"), blob2=appId, blob3=appSlug,
 *           blob4=organizationId, blob5=toolName ("ns.tool" for rpc, "code" for exec),
 *           blob8=userId, blob9=tediId, blob11=executionId, blob12=traceId
 *   doubles: MCP_CODEMODE_ANALYTICS_DOUBLE
 *            double1=success, double2=durationMs, double3=codeLength,
 *            double4=toolCount, double5=namespaceCount
 *   indexes: [appId]
 */

/**
 * Resolve the codemode Analytics Engine dataset name from the base analytics
 * env var.  The datasets share the same _development / _production suffix pattern:
 *   tedix_analytics_development   → tedix_codemode_analytics_development
 *   tedix_analytics_production → tedix_codemode_analytics_production
 * Falls back to env.CODEMODE_ANALYTICS_DATASET when present (future-proof).
 */
function codemodeDataset(env: CloudflareEnv): string | undefined {
	if (env.CODEMODE_ANALYTICS_DATASET) return env.CODEMODE_ANALYTICS_DATASET;
	const base = env.ANALYTICS_ENGINE_DATASET;
	if (!base) return undefined;
	// tedix_analytics_{suffix} → tedix_codemode_analytics_{suffix}
	return base.replace(/^tedix_analytics_/, "tedix_codemode_analytics_");
}

/**
 * Check if the codemode AE config is available.
 * Requires the same account credentials as the main analytics dataset.
 */
export function hasCodemodeAEConfig(env: CloudflareEnv): boolean {
	return !!(
		env.CF_ACCOUNT_ID &&
		env.CF_ANALYTICS_TOKEN &&
		codemodeDataset(env)
	);
}

export interface CodemodeRpcToolStat {
	/** "ns.tool" string written by the MCP Code Mode telemetry producer. */
	toolName: string;
	namespace: string;
	totalCalls: number;
	successCalls: number;
	failedCalls: number;
	successRate: number;
	avgDurationMs: number;
	p50DurationMs: number;
}

export interface CodemodeExecStat {
	totalExecs: number;
	successExecs: number;
	failedExecs: number;
	successRate: number;
	avgDurationMs: number;
	avgToolCount: number;
	avgNamespaceCount: number;
}

export interface CodemodeAnalyticsSummary {
	/** Per-namespace aggregate (rpc events only) */
	byNamespace: Array<{
		namespace: string;
		totalCalls: number;
		successCalls: number;
		failedCalls: number;
		successRate: number;
		avgDurationMs: number;
	}>;
	/** Top tool-level breakdown (rpc events, sorted by totalCalls desc) */
	topTools: CodemodeRpcToolStat[];
	/** Execution-level summary (exec events) */
	execSummary: CodemodeExecStat;
}

/**
 * Query the codemode Analytics Engine dataset for aggregated summary stats.
 *
 * Returns:
 * - Per-namespace RPC call counts, success rate, avg/p50 latency
 * - Top-N tool-level breakdown within those namespaces
 * - Execution-level summary (total execs, avg tool count, avg namespace count)
 *
 * Scoped by organizationId when provided; platform-principal callers may omit
 * it for cross-org reads (matching the pattern used by other analytics reads).
 */
export async function queryCodemodeAnalyticsSummary(
	env: CloudflareEnv,
	from: string,
	to: string,
	options: {
		organizationId?: string;
		appId?: string;
		limit?: number;
	} = {},
): Promise<CodemodeAnalyticsSummary> {
	const dataset = codemodeDataset(env);
	if (!dataset) {
		return emptyCodemodeAnalyticsSummary();
	}

	const { organizationId, appId, limit = 50 } = options;

	const timeWhere = `timestamp >= toDateTime('${escapeSql(toAEDatetime(from))}')
		AND timestamp <= toDateTime('${escapeSql(toAEDatetime(to))}')`;

	const orgWhere = organizationId
		? `AND ${MCP_ANALYTICS_BLOB.organizationId} = '${escapeSql(organizationId)}'`
		: "";

	const appWhere = appId
		? `AND ${MCP_ANALYTICS_BLOB.appId} = '${escapeSql(appId)}'`
		: "";

	const baseWhere = `${timeWhere} ${orgWhere} ${appWhere}`;

	// Run the three queries concurrently: per-tool rpc, per-namespace rpc, exec
	const [rpcByToolResult, execResult] = await Promise.all([
		// Per-tool RPC breakdown (blob1 = "rpc")
		queryAE<{
			toolName: string;
			successValue: number;
			calls: number;
			durationSum: number;
			p50Duration: number;
		}>(
			env,
			`SELECT
				${MCP_ANALYTICS_BLOB.toolName} AS toolName,
				${MCP_CODEMODE_ANALYTICS_DOUBLE.success} AS successValue,
				SUM(_sample_interval) AS calls,
				SUM(_sample_interval * ${MCP_CODEMODE_ANALYTICS_DOUBLE.durationMs}) AS durationSum,
				quantileExactWeighted(0.5)(${MCP_CODEMODE_ANALYTICS_DOUBLE.durationMs}, _sample_interval) AS p50Duration
			FROM ${dataset}
			WHERE ${MCP_ANALYTICS_BLOB.eventType} = 'rpc'
				AND ${MCP_ANALYTICS_BLOB.toolName} != ''
				AND ${baseWhere}
			GROUP BY ${MCP_ANALYTICS_BLOB.toolName}, ${MCP_CODEMODE_ANALYTICS_DOUBLE.success}
			ORDER BY calls DESC`,
		),

		// Exec summary (blob1 = "exec")
		queryAE<{
			successValue: number;
			totalExecs: number;
			durationSum: number;
			toolCountSum: number;
			namespaceCountSum: number;
		}>(
			env,
			`SELECT
				${MCP_CODEMODE_ANALYTICS_DOUBLE.success} AS successValue,
				SUM(_sample_interval) AS totalExecs,
				SUM(_sample_interval * ${MCP_CODEMODE_ANALYTICS_DOUBLE.durationMs}) AS durationSum,
				SUM(_sample_interval * ${MCP_CODEMODE_ANALYTICS_DOUBLE.toolCount}) AS toolCountSum,
				SUM(_sample_interval * ${MCP_CODEMODE_ANALYTICS_DOUBLE.namespaceCount}) AS namespaceCountSum
			FROM ${dataset}
			WHERE ${MCP_ANALYTICS_BLOB.eventType} = 'exec'
				AND ${baseWhere}
			GROUP BY ${MCP_CODEMODE_ANALYTICS_DOUBLE.success}`,
		),
	]);

	// Aggregate rpc rows → per-tool stats then fold into per-namespace
	type ToolBucket = {
		totalCalls: number;
		successCalls: number;
		failedCalls: number;
		durationSum: number;
		p50DurationMs: number;
	};
	const byTool = new Map<string, ToolBucket>();

	for (const row of rpcByToolResult.data) {
		const calls = Number(row.calls) || 0;
		const isSuccess = Number(row.successValue) === 1;
		const existing = byTool.get(row.toolName) ?? {
			totalCalls: 0,
			successCalls: 0,
			failedCalls: 0,
			durationSum: 0,
			p50DurationMs: 0,
		};
		existing.totalCalls += calls;
		if (isSuccess) existing.successCalls += calls;
		else existing.failedCalls += calls;
		existing.durationSum += Number(row.durationSum) || 0;
		// Take the p50 from the success bucket (dominant), or any bucket
		if (isSuccess || existing.p50DurationMs === 0) {
			existing.p50DurationMs = Math.round(Number(row.p50Duration) || 0);
		}
		byTool.set(row.toolName, existing);
	}

	// Build top-tools list (sorted by totalCalls desc, capped at limit)
	const topTools: CodemodeRpcToolStat[] = Array.from(byTool.entries())
		.map(([toolName, bucket]) => {
			const total = Math.round(bucket.totalCalls);
			const success = Math.round(bucket.successCalls);
			// namespace is the part before the first "." in "ns.tool"
			const dotIndex = toolName.indexOf(".");
			const namespace = dotIndex > 0 ? toolName.slice(0, dotIndex) : toolName;
			return {
				toolName,
				namespace,
				totalCalls: total,
				successCalls: success,
				failedCalls: Math.round(bucket.failedCalls),
				successRate: total > 0 ? Math.round((success / total) * 1000) / 10 : 0,
				avgDurationMs:
					bucket.totalCalls > 0
						? Math.round(bucket.durationSum / bucket.totalCalls)
						: 0,
				p50DurationMs: bucket.p50DurationMs,
			};
		})
		.sort((a, b) => b.totalCalls - a.totalCalls)
		.slice(0, limit);

	// Fold top-tools into per-namespace aggregates
	type NsBucket = {
		totalCalls: number;
		successCalls: number;
		failedCalls: number;
		durationSum: number;
	};
	const byNamespaceMap = new Map<string, NsBucket>();
	for (const tool of topTools) {
		const existing = byNamespaceMap.get(tool.namespace) ?? {
			totalCalls: 0,
			successCalls: 0,
			failedCalls: 0,
			durationSum: 0,
		};
		existing.totalCalls += tool.totalCalls;
		existing.successCalls += tool.successCalls;
		existing.failedCalls += tool.failedCalls;
		existing.durationSum +=
			tool.totalCalls > 0 ? tool.avgDurationMs * tool.totalCalls : 0;
		byNamespaceMap.set(tool.namespace, existing);
	}

	const byNamespace = Array.from(byNamespaceMap.entries())
		.map(([namespace, bucket]) => ({
			namespace,
			totalCalls: bucket.totalCalls,
			successCalls: bucket.successCalls,
			failedCalls: bucket.failedCalls,
			successRate:
				bucket.totalCalls > 0
					? Math.round((bucket.successCalls / bucket.totalCalls) * 1000) / 10
					: 0,
			avgDurationMs:
				bucket.totalCalls > 0
					? Math.round(bucket.durationSum / bucket.totalCalls)
					: 0,
		}))
		.sort((a, b) => b.totalCalls - a.totalCalls);

	// Aggregate exec rows
	let totalExecs = 0;
	let successExecs = 0;
	let failedExecs = 0;
	let execDurationSum = 0;
	let execToolCountSum = 0;
	let execNamespaceCountSum = 0;

	for (const row of execResult.data) {
		const execs = Number(row.totalExecs) || 0;
		totalExecs += execs;
		if (Number(row.successValue) === 1) successExecs += execs;
		else failedExecs += execs;
		execDurationSum += Number(row.durationSum) || 0;
		execToolCountSum += Number(row.toolCountSum) || 0;
		execNamespaceCountSum += Number(row.namespaceCountSum) || 0;
	}

	const execSummary: CodemodeExecStat = {
		totalExecs: Math.round(totalExecs),
		successExecs: Math.round(successExecs),
		failedExecs: Math.round(failedExecs),
		successRate:
			totalExecs > 0 ? Math.round((successExecs / totalExecs) * 1000) / 10 : 0,
		avgDurationMs:
			totalExecs > 0 ? Math.round(execDurationSum / totalExecs) : 0,
		avgToolCount:
			totalExecs > 0
				? Math.round((execToolCountSum / totalExecs) * 10) / 10
				: 0,
		avgNamespaceCount:
			totalExecs > 0
				? Math.round((execNamespaceCountSum / totalExecs) * 10) / 10
				: 0,
	};

	return { byNamespace, topTools, execSummary };
}

function emptyCodemodeAnalyticsSummary(): CodemodeAnalyticsSummary {
	return {
		byNamespace: [],
		topTools: [],
		execSummary: {
			totalExecs: 0,
			successExecs: 0,
			failedExecs: 0,
			successRate: 0,
			avgDurationMs: 0,
			avgToolCount: 0,
			avgNamespaceCount: 0,
		},
	};
}

// =============================================================================
// Helpers
// =============================================================================

/**
 * SQL string escaping for AE queries (ClickHouse dialect).
 * Prevents injection by escaping quotes and backslashes.
 */
function escapeSql(value: string): string {
	return value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

/**
 * Convert ISO 8601 datetime to AE-compatible format.
 * AE's toDateTime() requires 'YYYY-MM-DD HH:MM:SS' — rejects millis and 'Z'.
 */
function toAEDatetime(iso: string): string {
	return iso
		.replace("T", " ")
		.replace(/\.\d{3}Z$/, "")
		.replace(/Z$/, "");
}
