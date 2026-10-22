import {
	MCP_ANALYTICS_BLOB,
	MCP_CODEMODE_ANALYTICS_DOUBLE,
} from "@tedix/api-contract/schemas/mcp-analytics";
import { escapeSql, queryAE, toAEDatetime } from "./analytics-engine-query";

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
