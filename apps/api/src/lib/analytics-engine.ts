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
} from "@tedix/api-contract/schemas/mcp-analytics";
import {
	escapeSql,
	normalizeAEDatetime,
	queryAE,
	toAEDatetime,
} from "./analytics-engine-query";
import {
	MCP_EVENT,
	buildDirectAppWhere,
	buildCorrelatedToolWheres,
} from "./analytics-engine-apps";

interface OrgToolCallMetrics {
	totalToolCalls: number;
	successfulToolCalls: number;
	failedToolCalls: number;
	successRate: number;
	uniqueSessions: number;
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
