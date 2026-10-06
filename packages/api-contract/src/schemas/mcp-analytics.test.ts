import { describe, expect, it } from "vite-plus/test";
import {
	buildDanglingTurnAnalyticsDataPoint,
	buildFacetTurnAnalyticsDataPoint,
	buildMcpAggregateCacheDataPoint,
	buildMcpAnalyticsDataPoint,
	buildMcpCodeModeAnalyticsDataPoint,
	buildMcpDiscoveryCacheAnalyticsDataPoint,
	buildMcpUpstreamProtocolDataPoint,
	FACET_TURN_ANALYTICS_BLOB_ORDER,
	FACET_TURN_ANALYTICS_DOUBLE_ORDER,
	hashAnalyticsLabel,
	MCP_AGGREGATE_CACHE_BLOB_ORDER,
	MCP_AGGREGATE_CACHE_DOUBLE_ORDER,
	MCP_ANALYTICS_BLOB,
	MCP_ANALYTICS_BLOB_ORDER,
	MCP_ANALYTICS_DOUBLE,
	MCP_ANALYTICS_DOUBLE_ORDER,
	MCP_CODEMODE_ANALYTICS_DOUBLE,
	MCP_CODEMODE_ANALYTICS_DOUBLE_ORDER,
} from "./mcp-analytics";

describe("MCP Analytics Engine data point contract", () => {
	it("builds bounded outbound discovery cache slots", () => {
		expect(
			buildMcpDiscoveryCacheAnalyticsDataPoint({
				outcome: "hit",
				endpoint: "https://srv.example/mcp?tenant=secret#fragment",
				modern: true,
				ttlMs: 60_000,
				digest: "sha256:capabilities",
				organizationId: "org-1",
				tediId: "tedi-1",
			}),
		).toEqual({
			blobs: [
				"mcp_discovery_cache",
				"hit",
				"https://srv.example/mcp",
				"modern",
				"sha256:capabilities",
				"org-1",
				"tedi-1",
			],
			doubles: [60_000],
			indexes: ["org-1"],
		});
	});
	it("builds a secret-free upstream protocol removal metric", () => {
		expect(
			buildMcpUpstreamProtocolDataPoint({
				protocolEra: "legacy_streamable_2025",
				appSlug: "tenant-app",
				toolName: "search",
				boundary: "external",
				callerClass: "external_agent",
			}),
		).toEqual({
			blobs: [
				"upstream_protocol",
				"legacy_streamable_2025",
				"tenant-app",
				"search",
				"external",
				"external_agent",
				"caller_class_v1",
			],
			doubles: [1],
			indexes: ["tenant-app"],
		});
	});

	it("builds the inbound MCP blob, double, and index slots", () => {
		const dataPoint = buildMcpAnalyticsDataPoint({
			eventType: "tool_call",
			appId: "app-id",
			appSlug: "app-slug",
			organizationId: "org-id",
			toolName: "search_listings",
			errorCode: "INVALID_INPUT",
			sessionId: "session-id",
			userId: "user-id",
			tediId: "tedi-id",
			authType: "tedi",
			executionId: "execution-id",
			traceId: "trace-id",
			registrationMethod: "pre_registered",
			success: false,
			durationMs: 42,
			toolInputSize: 128,
			toolOutputSize: 256,
			tokensUsed: 512,
		});

		expect(dataPoint.blobs).toEqual([
			"tool_call",
			"app-id",
			"app-slug",
			"org-id",
			"search_listings",
			"INVALID_INPUT",
			"session-id",
			"user-id",
			"tedi-id",
			"tedi",
			"execution-id",
			"trace-id",
			"pre_registered",
		]);
		expect(dataPoint.doubles).toEqual([0, 42, 128, 256, 512]);
		expect(dataPoint.indexes).toEqual(["app-id"]);
		expect(MCP_ANALYTICS_BLOB.executionId).toBe("blob11");
		expect(MCP_ANALYTICS_BLOB.registrationMethod).toBe("blob13");
		expect(MCP_ANALYTICS_DOUBLE.tokensUsed).toBe("double5");
		expect(MCP_ANALYTICS_BLOB_ORDER).toEqual([
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
		]);
		expect(MCP_ANALYTICS_DOUBLE_ORDER).toEqual([
			"success",
			"durationMs",
			"toolInputSize",
			"toolOutputSize",
			"tokensUsed",
		]);
	});

	it("defaults missing optional dimensions without shifting slots", () => {
		const dataPoint = buildMcpAnalyticsDataPoint({
			eventType: "session_init",
		});

		expect(dataPoint.blobs).toEqual([
			"session_init",
			"unknown",
			"",
			"unknown",
			"",
			"",
			"",
			"",
			"",
			"anonymous",
			"",
			"",
			"",
		]);
		expect(dataPoint.doubles).toEqual([0, 0, 0, 0, 0]);
		expect(dataPoint.indexes).toEqual(["unknown"]);
	});

	it("builds Code Mode tail doubles with named tail semantics", () => {
		const dataPoint = buildMcpCodeModeAnalyticsDataPoint({
			eventType: "exec",
			appId: "app-id",
			appSlug: "app-slug",
			organizationId: "org-id",
			toolName: "code",
			errorCode: "boom",
			userId: "user-id",
			tediId: "tedi-id",
			authType: "oauth",
			executionId: "execution-id",
			traceId: "trace-id",
			success: true,
			durationMs: 99,
			codeLength: 1234,
			toolCount: 7,
			namespaceCount: 3,
		});

		expect(dataPoint.blobs).toEqual([
			"exec",
			"app-id",
			"app-slug",
			"org-id",
			"code",
			"boom",
			"",
			"user-id",
			"tedi-id",
			"oauth",
			"execution-id",
			"trace-id",
			"",
		]);
		expect(dataPoint.doubles).toEqual([1, 99, 1234, 7, 3, 0, 0, 0, 0, 0]);
		expect(dataPoint.indexes).toEqual(["app-id"]);
		expect(MCP_CODEMODE_ANALYTICS_DOUBLE.codeLength).toBe("double3");
		expect(MCP_CODEMODE_ANALYTICS_DOUBLE.namespaceCount).toBe("double5");
		expect(MCP_CODEMODE_ANALYTICS_DOUBLE_ORDER).toEqual([
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
		]);
		// The original five positions are frozen — every existing AE query reads
		// them by position, so the cost-shape tail may only ever APPEND.
		expect(MCP_CODEMODE_ANALYTICS_DOUBLE.resultChars).toBe("double6");
		expect(MCP_CODEMODE_ANALYTICS_DOUBLE.discoverParameterRequests).toBe(
			"double10",
		);
	});

	it("builds an aggregate-cache datapoint isolated by blob1=aggregate_cache", () => {
		const cold = buildMcpAggregateCacheDataPoint({
			cacheEvent: "cold_rebuild",
			appSlug: "tedix-unified",
			totalMs: 4085,
			appCount: 31,
			toolCount: 2213,
			degraded: false,
		});
		// blob1 distinguishes cache events from MCP event types (session_init,
		// tool_call, …) so existing queries that filter blob1 are unaffected.
		expect(cold.blobs[0]).toBe("aggregate_cache");
		expect(cold.blobs).toEqual([
			"aggregate_cache",
			"cold_rebuild",
			"tedix-unified",
			"",
		]);
		expect(cold.doubles).toEqual([4085, 31, 2213, 0]);
		expect(cold.indexes).toEqual(["cold_rebuild"]);

		const timeout = buildMcpAggregateCacheDataPoint({
			cacheEvent: "entry_timeout",
			slug: "acme-demo",
			totalMs: 12000,
		});
		expect(timeout.blobs).toEqual([
			"aggregate_cache",
			"entry_timeout",
			"",
			"acme-demo",
		]);
		expect(timeout.doubles).toEqual([12000, 0, 0, 0]);

		expect(MCP_AGGREGATE_CACHE_BLOB_ORDER).toEqual([
			"eventType",
			"cacheEvent",
			"appSlug",
			"slug",
		]);
		expect(MCP_AGGREGATE_CACHE_DOUBLE_ORDER).toEqual([
			"totalMs",
			"appCount",
			"toolCount",
			"degraded",
		]);
	});
});

describe("facet fleet Analytics Engine data points", () => {
	it("builds the facet_turn blob/double slots in declared order", () => {
		const dataPoint = buildFacetTurnAnalyticsDataPoint({
			surface: "sse",
			tediId: "tedi-1",
			outcome: "complete",
			facetNameHash: "abcd1234",
			turnMs: 900,
			totalMs: 1200,
			firstFacetTurn: true,
			turnCount: 3,
		});
		expect(dataPoint.blobs).toEqual([
			"facet_turn",
			"sse",
			"tedi-1",
			"complete",
			"",
			"abcd1234",
		]);
		expect(dataPoint.doubles).toEqual([900, 1200, 1, 3]);
		expect(dataPoint.indexes).toEqual(["tedi-1"]);
		expect(dataPoint.blobs).toHaveLength(
			FACET_TURN_ANALYTICS_BLOB_ORDER.length,
		);
		expect(dataPoint.doubles).toHaveLength(
			FACET_TURN_ANALYTICS_DOUBLE_ORDER.length,
		);
	});

	it("records error class on error outcomes and defaults empty slots", () => {
		const dataPoint = buildFacetTurnAnalyticsDataPoint({
			surface: "email",
			outcome: "error",
			errorClass: "TypeError",
		});
		expect(dataPoint.blobs).toEqual([
			"facet_turn",
			"email",
			"",
			"error",
			"TypeError",
			"",
		]);
		expect(dataPoint.doubles).toEqual([0, 0, 0, 0]);
		expect(dataPoint.indexes).toEqual(["unknown"]);
	});

	it("builds the dangling_turn slots", () => {
		const dataPoint = buildDanglingTurnAnalyticsDataPoint({
			surface: "mcp",
			tediId: "tedi-2",
			sessionKeyHash: "00ff00ff",
			ageMs: 45000,
		});
		expect(dataPoint.blobs).toEqual([
			"dangling_turn",
			"mcp",
			"tedi-2",
			"00ff00ff",
		]);
		expect(dataPoint.doubles).toEqual([45000]);
		expect(dataPoint.indexes).toEqual(["tedi-2"]);
	});

	it("hashAnalyticsLabel is deterministic, 8-hex, and content-hiding", () => {
		const a = hashAnalyticsLabel("agent:main:delegation-run-1");
		expect(a).toMatch(/^[0-9a-f]{8}$/);
		expect(hashAnalyticsLabel("agent:main:delegation-run-1")).toBe(a);
		expect(hashAnalyticsLabel("agent:main:delegation-run-2")).not.toBe(a);
	});
});
