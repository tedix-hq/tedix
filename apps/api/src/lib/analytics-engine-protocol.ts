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
