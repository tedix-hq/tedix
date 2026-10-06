/**
 * Shared Analytics Engine schema for inbound MCP activity.
 *
 * Cloudflare Analytics Engine stores dimensions in positional blob/double
 * slots. Keep this module as the single source for both writers and readers.
 */

export const MCP_ANALYTICS_BLOB = {
	eventType: "blob1",
	appId: "blob2",
	appSlug: "blob3",
	organizationId: "blob4",
	toolName: "blob5",
	errorCode: "blob6",
	sessionId: "blob7",
	userId: "blob8",
	tediId: "blob9",
	authType: "blob10",
	executionId: "blob11",
	traceId: "blob12",
	registrationMethod: "blob13",
} as const;

export const MCP_ANALYTICS_DOUBLE = {
	success: "double1",
	durationMs: "double2",
	toolInputSize: "double3",
	toolOutputSize: "double4",
	tokensUsed: "double5",
} as const;

export const MCP_ANALYTICS_BLOB_ORDER = [
	"eventType",
	"appId",
	"appSlug",
	"organizationId",
	"toolName",
	"errorCode",
	"sessionId",
	"userId",
	"tediId",
	"authType",
	"executionId",
	"traceId",
	"registrationMethod",
] as const;

export const MCP_ANALYTICS_DOUBLE_ORDER = [
	"success",
	"durationMs",
	"toolInputSize",
	"toolOutputSize",
	"tokensUsed",
] as const;

export const MCP_CODEMODE_ANALYTICS_DOUBLE = {
	success: "double1",
	durationMs: "double2",
	codeLength: "double3",
	toolCount: "double4",
	namespaceCount: "double5",
	// Cost-shape tail — appended so the original five
	// positions keep their meaning in every existing query.
	resultChars: "double6",
	resultTokensApprox: "double7",
	resultTruncated: "double8",
	discoverCalls: "double9",
	discoverParameterRequests: "double10",
} as const;

export const MCP_CODEMODE_ANALYTICS_DOUBLE_ORDER = [
	"success",
	"durationMs",
	"codeLength",
	"toolCount",
	"namespaceCount",
	"resultChars",
	"resultTokensApprox",
	"resultTruncated",
	"discoverCalls",
	"discoverParameterRequests",
] as const;

export interface McpAnalyticsDataPointEvent {
	eventType: string;
	appId?: string;
	appSlug?: string;
	organizationId?: string;
	toolName?: string;
	errorCode?: string;
	sessionId?: string;
	userId?: string;
	tediId?: string;
	authType?: string;
	executionId?: string;
	traceId?: string;
	registrationMethod?: "pre_registered" | "cimd" | "dcr";
	success?: boolean;
	durationMs?: number;
	toolInputSize?: number;
	toolOutputSize?: number;
	tokensUsed?: number;
}

export interface McpCodeModeAnalyticsDataPointEvent extends McpAnalyticsDataPointEvent {
	durationMs?: number;
	codeLength?: number;
	toolCount?: number;
	namespaceCount?: number;
	// Cost-shape fields. Appended AFTER the original five
	// doubles so existing positional Analytics Engine queries keep reading the
	// same columns.
	/** Exact chars of the serialized model-facing result text. */
	resultChars?: number;
	/** resultChars / 4 — same heuristic as the truncation budget. */
	resultTokensApprox?: number;
	resultTruncated?: boolean;
	/** discover.search/describe invocations inside this execution. */
	discoverCalls?: number;
	/** How many of those requested schemas (includeParameters/describe). */
	discoverParameterRequests?: number;
}

export function buildMcpAnalyticsDataPoint(event: McpAnalyticsDataPointEvent): {
	blobs: string[];
	doubles: number[];
	indexes: string[];
} {
	return {
		blobs: [
			event.eventType,
			event.appId || "unknown",
			event.appSlug || "",
			event.organizationId || "unknown",
			event.toolName || "",
			event.errorCode || "",
			event.sessionId || "",
			event.userId || "",
			event.tediId || "",
			event.authType || "anonymous",
			event.executionId || "",
			event.traceId || "",
			event.registrationMethod || "",
		],
		doubles: [
			event.success ? 1 : 0,
			event.durationMs || 0,
			event.toolInputSize || 0,
			event.toolOutputSize || 0,
			event.tokensUsed || 0,
		],
		indexes: [event.appId || "unknown"],
	};
}

export function buildMcpCodeModeAnalyticsDataPoint(
	event: McpCodeModeAnalyticsDataPointEvent,
): {
	blobs: string[];
	doubles: number[];
	indexes: string[];
} {
	const dataPoint = buildMcpAnalyticsDataPoint(event);
	dataPoint.doubles = [
		event.success ? 1 : 0,
		event.durationMs || 0,
		event.codeLength || 0,
		event.toolCount || 0,
		event.namespaceCount || 0,
		// Appended fields — order is load-bearing for positional AE queries.
		event.resultChars || 0,
		event.resultTokensApprox || 0,
		event.resultTruncated ? 1 : 0,
		event.discoverCalls || 0,
		event.discoverParameterRequests || 0,
	];
	return dataPoint;
}

// ── Aggregate-surface cache effectiveness (`_cm:"aggregate"` events) ──
// Written to the same Analytics Engine dataset but isolated by blob1 =
// "aggregate_cache" so existing MCP queries (which filter blob1 to their event
// types) are unaffected. Lets us quantify cache hit-rate / cold-miss rate / SWR
// effectiveness on prod where Worker logs aren't tailable.
export const MCP_AGGREGATE_CACHE_BLOB_ORDER = [
	"eventType", // always "aggregate_cache"
	"cacheEvent", // l2_hit | l2_stale_revalidate | revalidated | cold_rebuild | entry_timeout
	"appSlug", // root app slug when known
	"slug", // the timed-out source app (entry_timeout) when applicable
] as const;
export const MCP_AGGREGATE_CACHE_DOUBLE_ORDER = [
	"totalMs", // cold-rebuild wall-clock (cold_rebuild) or revalidate duration
	"appCount",
	"toolCount",
	"degraded", // 1 if the rebuilt surface was degraded
] as const;
export interface McpAggregateCacheDataPointEvent {
	cacheEvent: string;
	appSlug?: string;
	slug?: string;
	totalMs?: number;
	appCount?: number;
	toolCount?: number;
	degraded?: boolean;
}

export function buildMcpAggregateCacheDataPoint(
	event: McpAggregateCacheDataPointEvent,
): { blobs: string[]; doubles: number[]; indexes: string[] } {
	return {
		blobs: [
			"aggregate_cache",
			event.cacheEvent,
			event.appSlug || "",
			event.slug || "",
		],
		doubles: [
			event.totalMs || 0,
			event.appCount || 0,
			event.toolCount || 0,
			event.degraded ? 1 : 0,
		],
		indexes: [event.cacheEvent],
	};
}

// External MCP compatibility usage. This intentionally has its own compact
// layout: it is a removal metric, not an inbound request event, and must never
// contain the upstream URL, credentials, or arguments.
export interface McpUpstreamProtocolDataPointEvent {
	protocolEra: "modern_2026" | "legacy_streamable_2025" | "legacy_sse_2024";
	appSlug?: string;
	toolName?: string;
	boundary: "external" | "first_party";
	callerClass:
		| "os"
		| "tedi_runtime"
		| "human_client"
		| "api_client"
		| "external_agent"
		| "internal_service"
		| "unknown";
}

export function buildMcpUpstreamProtocolDataPoint(
	event: McpUpstreamProtocolDataPointEvent,
): { blobs: string[]; doubles: number[]; indexes: string[] } {
	return {
		blobs: [
			"upstream_protocol",
			event.protocolEra,
			event.appSlug || "",
			event.toolName || "",
			event.boundary,
			event.callerClass,
			"caller_class_v1",
		],
		doubles: [1],
		indexes: [event.appSlug || "unknown"],
	};
}

// ── Facet fleet observability ─────────────────────────────────────────────
//
// Console `[conversation-facet]`/`[judge-facet]`/`[dangling-turn]` lines are
// request-context logs that Workers Logs samples away under load — these
// datapoints are the queryable record. Facet latency describes completed/error call wall time and
// dangling-turn describes a trailing cached user row; neither proves a missing
// canonical run terminal. Reading notes + example SQL: apps/tedi-runtime/README.

/**
 * Stable non-cryptographic label hash (FNV-1a 32-bit, hex) for
 * high-cardinality or content-bearing labels (facet names embed session
 * keys). Deterministic so a label can still be grouped/joined across
 * datapoints without shipping the raw value into AE blobs.
 */
export function hashAnalyticsLabel(value: string): string {
	let hash = 0x811c9dc5;
	for (let i = 0; i < value.length; i++) {
		hash ^= value.charCodeAt(i);
		hash = Math.imul(hash, 0x01000193);
	}
	return (hash >>> 0).toString(16).padStart(8, "0");
}

export const FACET_TURN_ANALYTICS_BLOB_ORDER = [
	"facet_turn",
	"surface",
	"tediId",
	"outcome",
	"errorClass",
	"facetNameHash",
] as const;
export const FACET_TURN_ANALYTICS_DOUBLE_ORDER = [
	"turnMs",
	"totalMs",
	"firstFacetTurn",
	"turnCount",
] as const;

export interface FacetTurnAnalyticsDataPointEvent {
	/** Which migrated chat surface ran the turn. */
	surface: "mcp" | "sse" | "email" | "judge";
	tediId?: string;
	outcome: "complete" | "error";
	/** Error constructor name only — never the message (may carry content). */
	errorClass?: string;
	/** Hash of the facet name (sanitized session key) via hashAnalyticsLabel. */
	facetNameHash?: string;
	/** Facet-reported model-turn duration. */
	turnMs?: number;
	/** Parent-observed wall time incl. facet spawn + RPC + full tool/model work. */
	totalMs?: number;
	/** True when this was the conversation's first facet turn (spawn/hydration). */
	firstFacetTurn?: boolean;
	turnCount?: number;
}
export function buildFacetTurnAnalyticsDataPoint(
	event: FacetTurnAnalyticsDataPointEvent,
): { blobs: string[]; doubles: number[]; indexes: string[] } {
	return {
		blobs: [
			"facet_turn",
			event.surface,
			event.tediId || "",
			event.outcome,
			event.errorClass || "",
			event.facetNameHash || "",
		],
		doubles: [
			event.turnMs || 0,
			event.totalMs || 0,
			event.firstFacetTurn ? 1 : 0,
			event.turnCount || 0,
		],
		indexes: [event.tediId || "unknown"],
	};
}

export const DANGLING_TURN_ANALYTICS_BLOB_ORDER = [
	"dangling_turn",
	"surface",
	"tediId",
	"sessionKeyHash",
] as const;
export const DANGLING_TURN_ANALYTICS_DOUBLE_ORDER = ["ageMs"] as const;

export interface DanglingTurnAnalyticsDataPointEvent {
	/** Surface whose incoming turn observed the dangling prior user turn. */
	surface: string;
	tediId?: string;
	/** Hash of the session key via hashAnalyticsLabel. */
	sessionKeyHash?: string;
	ageMs?: number;
}
export function buildDanglingTurnAnalyticsDataPoint(
	event: DanglingTurnAnalyticsDataPointEvent,
): { blobs: string[]; doubles: number[]; indexes: string[] } {
	return {
		blobs: [
			"dangling_turn",
			event.surface,
			event.tediId || "",
			event.sessionKeyHash || "",
		],
		doubles: [event.ageMs || 0],
		indexes: [event.tediId || "unknown"],
	};
}

// ── Outbound MCP discovery cache effectiveness ─────────────────────────────
// Written by the tedi runtime to RUNTIME_ANALYTICS. The endpoint has already
// been stripped of query/fragment data by mcp-client-core; credentials and the
// request-header identity digest never cross the callback boundary.
export interface McpDiscoveryCacheAnalyticsDataPointEvent {
	outcome: "hit" | "miss";
	endpoint: string;
	modern: boolean;
	ttlMs: number;
	digest?: string;
	organizationId?: string;
	tediId?: string;
}

export function buildMcpDiscoveryCacheAnalyticsDataPoint(
	event: McpDiscoveryCacheAnalyticsDataPointEvent,
): { blobs: string[]; doubles: number[]; indexes: string[] } {
	let endpoint = "invalid-mcp-endpoint";
	try {
		const parsed = new URL(event.endpoint);
		endpoint = `${parsed.origin}${parsed.pathname}`;
	} catch {
		// Preserve a bounded non-sensitive sentinel instead of the raw input.
	}
	return {
		blobs: [
			"mcp_discovery_cache",
			event.outcome,
			endpoint,
			event.modern ? "modern" : "legacy",
			event.digest || "",
			event.organizationId || "",
			event.tediId || "",
		],
		doubles: [Math.max(0, event.ttlMs)],
		indexes: [event.organizationId || event.tediId || "unknown"],
	};
}

// ── Cron governance (TTL stop-contract) ─────────────────────────────────────
//
// Emitted by the tedi-runtime DO when cron governance auto-acts (an expired job
// is cancelled at fire time, or a fire is budget-suppressed). Written to
// RUNTIME_ANALYTICS so the action is queryable and never silent — console lines
// alone get tail-sampled away.
export const CRON_GOVERNANCE_ANALYTICS_BLOB_ORDER = [
	"eventType", // always "cron_governance"
	"action", // "expired_cancelled" | "budget_suppressed"
	"tediId",
	"jobName",
	"scheduleId",
] as const;
export const CRON_GOVERNANCE_ANALYTICS_DOUBLE_ORDER = [
	"durationMs", // expiredByMs or remaining budget-suppression window
	"usedTokens",
	"tokenLimit",
	"remainingTokens",
	"usedMessages",
	"messageLimit",
	"remainingMessages",
] as const;
export interface CronGovernanceAnalyticsDataPointEvent {
	action: "expired_cancelled" | "budget_suppressed";
	tediId?: string;
	jobName?: string;
	scheduleId?: string;
	expiredByMs?: number;
	suppressedForMs?: number;
	usedTokens?: number;
	tokenLimit?: number;
	remainingTokens?: number;
	usedMessages?: number;
	messageLimit?: number;
	remainingMessages?: number;
}
export function buildCronGovernanceAnalyticsDataPoint(
	event: CronGovernanceAnalyticsDataPointEvent,
): { blobs: string[]; doubles: number[]; indexes: string[] } {
	return {
		blobs: [
			"cron_governance",
			event.action,
			event.tediId || "",
			event.jobName || "",
			event.scheduleId || "",
		],
		doubles: [
			event.expiredByMs ?? event.suppressedForMs ?? 0,
			event.usedTokens ?? 0,
			event.tokenLimit ?? 0,
			event.remainingTokens ?? 0,
			event.usedMessages ?? 0,
			event.messageLimit ?? 0,
			event.remainingMessages ?? 0,
		],
		indexes: [event.tediId || "unknown"],
	};
}
