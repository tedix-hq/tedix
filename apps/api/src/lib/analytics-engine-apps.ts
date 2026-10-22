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

export const MCP_EVENT = {
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

export function buildDirectAppWhere(
	appId: string,
	from: string,
	to: string,
): string {
	return `${MCP_ANALYTICS_BLOB.appId} = '${escapeSql(appId)}'
			AND timestamp >= toDateTime('${escapeSql(toAEDatetime(from))}')
			AND timestamp <= toDateTime('${escapeSql(toAEDatetime(to))}')`;
}

export async function buildCorrelatedToolWheres(
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
