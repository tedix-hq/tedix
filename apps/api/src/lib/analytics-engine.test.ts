import {
	MCP_ANALYTICS_BLOB,
	MCP_ANALYTICS_DOUBLE,
} from "@tedix/api-contract/schemas/mcp-analytics";
import { afterEach, describe, expect, test } from "vite-plus/test";
import {
	getAppSummaryFromAE,
	getAppToolBreakdownFromAE,
	getExecutionDrilldownFromAE,
	getExternalAgentValidationSloFromAE,
	getWidgetLifecycleHealthFromAE,
	getRecentExecutionsFromAE,
	getUpstreamProtocolUsageFromAE,
	getUserToolCallMetrics,
	queryCodemodeAnalyticsSummary,
} from "./analytics-engine";

const realFetch = globalThis.fetch;

test("external-agent validation SLO is sampled and org scoped", async () => {
	const mock = mockAEFetch([
		{
			data: [
				{
					totalValidations: 10,
					successfulValidations: 8,
					inactiveValidations: 1,
					unavailableValidations: 1,
					avgLatencyMs: 204.6,
					latestValidationAt: "2026-08-21 23:58:30",
				},
			],
		},
	]);
	try {
		const result = await getExternalAgentValidationSloFromAE(
			env,
			"org-'quoted",
			"2026-08-21T00:00:00.000Z",
			"2026-08-21T23:59:59.000Z",
		);
		expect(result).toEqual({
			from: "2026-08-21T00:00:00.000Z",
			to: "2026-08-21T23:59:59.000Z",
			status: "degraded",
			configured: true,
			hasData: true,
			latestValidationAt: "2026-08-21T23:58:30.000Z",
			freshnessLagMs: 89_000,
			totalValidations: 10,
			successfulValidations: 8,
			inactiveValidations: 1,
			unavailableValidations: 1,
			availabilityPercent: 90,
			avgLatencyMs: 205,
		});
		expect(mock.queries[0]).toContain("SUM(_sample_interval)");
		expect(mock.queries[0]).toContain("_sample_interval, 0)");
		expect(mock.queries[0]).toContain("org-\\'quoted");
		expect(mock.queries[0]).toContain("auth_validation");
		expect(mock.queries[0]).toContain("MAX(timestamp)");
	} finally {
		mock.restore();
	}
});

test("external-agent validation SLO reports a valid empty window", async () => {
	const mock = mockAEFetch([{ data: [{}] }]);
	try {
		await expect(
			getExternalAgentValidationSloFromAE(
				env,
				"org-1",
				"2026-08-21T00:00:00.000Z",
				"2026-08-21T01:00:00.000Z",
			),
		).resolves.toMatchObject({
			status: "no_data",
			configured: true,
			hasData: false,
			latestValidationAt: null,
			freshnessLagMs: null,
			totalValidations: 0,
		});
	} finally {
		mock.restore();
	}
});

const env = {
	CF_ACCOUNT_ID: "account",
	CF_ANALYTICS_TOKEN: "token",
	ANALYTICS_ENGINE_DATASET: "dataset",
	WIDGET_ANALYTICS_DATASET: "widget-dataset",
} as unknown as CloudflareEnv;

test("widget lifecycle health is sampled, content-free, and org scoped", async () => {
	const mock = mockAEFetch([
		{
			data: [
				{
					totalEvents: 9,
					readyEvents: 2,
					sessionAttempts: 3,
					failedSessions: 1,
					messageSubmissions: 4,
					firstTokens: 4,
					completedAnswers: 3,
					cancelledAnswers: 0,
					failedAnswers: 1,
					avgReadyMs: 84.4,
					avgSessionMs: 210.6,
					avgFirstTokenMs: 320.4,
					avgAnswerMs: 1800.6,
					latestEventAt: "2026-08-31 23:58:30",
				},
			],
		},
	]);
	try {
		await expect(
			getWidgetLifecycleHealthFromAE(
				env,
				"org-'quoted",
				"2026-08-31T00:00:00.000Z",
				"2026-08-31T23:59:59.000Z",
				"installation-1",
			),
		).resolves.toMatchObject({
			status: "degraded",
			totalEvents: 9,
			readyEvents: 2,
			sessionAttempts: 3,
			failedSessions: 1,
			messageSubmissions: 4,
			firstTokens: 4,
			completedAnswers: 3,
			cancelledAnswers: 0,
			failedAnswers: 1,
			avgReadyMs: 84,
			avgSessionMs: 211,
			avgFirstTokenMs: 320,
			avgAnswerMs: 1801,
			latestEventAt: "2026-08-31T23:58:30.000Z",
		});
		expect(mock.queries[0]).toContain("AND blob9 != ''");
		expect(mock.queries[0]).toContain("AND blob9 = 'installation-1'");
		expect(mock.queries[0]).toContain("FROM widget-dataset");
		expect(mock.queries[0]).toContain("IF(SUM(IF(");
		expect(mock.queries[0]).not.toContain("NULLIF(");
		expect(mock.queries[0]).toContain("blob4 = 'org-\\'quoted'");
		expect(mock.queries[0]).toContain("blob7 = 'embedded_widget'");
		expect(mock.queries[0]).not.toMatch(/transcript|pathname|userId/i);
	} finally {
		mock.restore();
	}
});

function mockAEFetch(
	responses: Array<{
		data: unknown[];
		rows?: number;
		rows_before_limit_at_least?: number;
	}>,
) {
	const queries: string[] = [];
	const originalFetch = globalThis.fetch;
	globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
		queries.push(String(init?.body ?? ""));
		const response = responses.shift();
		if (!response) {
			throw new Error("Unexpected AE query");
		}
		return new Response(
			JSON.stringify({
				rows: response.rows ?? response.data.length,
				rows_before_limit_at_least:
					response.rows_before_limit_at_least ?? response.data.length,
				data: response.data,
			}),
			{ status: 200, headers: { "content-type": "application/json" } },
		);
	}) as typeof fetch;

	return {
		queries,
		restore: () => {
			globalThis.fetch = originalFetch;
		},
	};
}

afterEach(() => {
	// Individual tests restore fetch explicitly. This keeps a failed test from
	// leaking a mock into the next one.
	globalThis.fetch = realFetch;
});

test("upstream protocol usage is sampling-adjusted, bounded, and content-free", async () => {
	const legacyRows = Array.from({ length: 26 }, (_, index) => ({
		appSlug: `legacy-${index.toString().padStart(2, "0")}`,
		protocolEra: "legacy_streamable_2025",
		estimatedUses: 26 - index,
		lastObservedAt: "2026-09-01 23:58:30",
	}));
	const mock = mockAEFetch([
		{
			data: [
				{
					protocolEra: "modern_2026",
					boundary: "first_party",
					estimatedUses: 8,
				},
				{
					protocolEra: "legacy_streamable_2025",
					boundary: "external",
					estimatedUses: 3.6,
				},
			],
		},
		{ data: legacyRows },
		{
			data: [
				{
					callerClass: "tedi_runtime",
					boundary: "first_party",
					protocolEra: "modern_2026",
					estimatedUses: 7.6,
				},
				{
					callerClass: "pre_attribution",
					boundary: "external",
					protocolEra: "legacy_streamable_2025",
					estimatedUses: 3.6,
				},
				{
					callerClass: "unknown",
					boundary: "external",
					protocolEra: "modern_2026",
					estimatedUses: 1,
				},
			],
		},
	]);
	try {
		const result = await getUpstreamProtocolUsageFromAE(
			env,
			"2026-08-03T00:00:00.000Z",
			"2026-09-02T00:00:00.000Z",
		);
		expect(result.uses.first_party.modern_2026).toBe(8);
		expect(result.uses.external.legacy_streamable_2025).toBe(4);
		expect(result.uses.external.legacy_sse_2024).toBe(0);
		expect(result.callerClasses).toEqual([
			{
				callerClass: "tedi_runtime",
				boundary: "first_party",
				protocolEra: "modern_2026",
				estimatedUses: 8,
			},
			{
				callerClass: "pre_attribution",
				boundary: "external",
				protocolEra: "legacy_streamable_2025",
				estimatedUses: 4,
			},
			{
				callerClass: "unknown",
				boundary: "external",
				protocolEra: "modern_2026",
				estimatedUses: 1,
			},
		]);
		expect(result.attributionCoverage).toEqual({
			version: "caller_class_v1",
			attributedUses: 8,
			unknownUses: 1,
			preAttributionUses: 4,
			attributedPercent: 61.54,
		});
		expect(result.legacyApps).toHaveLength(25);
		expect(result.legacyAppsTruncated).toBe(true);
		expect(result.legacyApps[0]?.lastObservedAt).toBe(
			"2026-09-01T23:58:30.000Z",
		);
		expect(mock.queries).toHaveLength(3);
		expect(mock.queries[0]).toContain("SUM(_sample_interval)");
		expect(mock.queries[0]).toContain("blob1 = 'upstream_protocol'");
		expect(mock.queries[1]).toContain("blob5 = 'external'");
		expect(mock.queries[1]).toContain("LIMIT 26");
		expect(mock.queries[2]).toContain("empty(blob7)");
		expect(mock.queries[2]).toContain("empty(blob6)");
		expect(mock.queries[2]).toContain("'pre_attribution'");
		expect(mock.queries.join("\n")).not.toMatch(
			/credential|argument|input|output/i,
		);
	} finally {
		mock.restore();
	}
});

describe("analytics-engine Code Mode app correlation", () => {
	test("Code Mode p50 uses Analytics Engine's supported weighted quantile", async () => {
		const mock = mockAEFetch([{ data: [] }, { data: [] }]);

		try {
			await queryCodemodeAnalyticsSummary(
				{
					...env,
					CODEMODE_ANALYTICS_DATASET: "codemode-dataset",
				} as CloudflareEnv,
				"2026-07-18T12:45:00Z",
				"2026-07-18T13:10:00Z",
				{ organizationId: "org-1" },
			);

			expect(mock.queries[0]).toContain(
				"quantileExactWeighted(0.5)(double2, _sample_interval)",
			);
			expect(mock.queries[0]).not.toContain("quantileTDigest");
		} finally {
			mock.restore();
		}
	});

	test("user metrics query uses the shared inbound MCP slot contract", async () => {
		const mock = mockAEFetch([
			{
				data: [
					{
						totalCalls: 3,
						failedCalls: 1,
					},
				],
			},
		]);

		try {
			const metrics = await getUserToolCallMetrics(
				env,
				"user-1",
				"2026-05-11T00:00:00Z",
				"2026-05-11T01:00:00Z",
			);

			expect(metrics).toEqual({ totalCalls: 3, failedCalls: 1 });
			expect(mock.queries[0]).toContain(
				`${MCP_ANALYTICS_BLOB.eventType} = 'tool_call'`,
			);
			expect(mock.queries[0]).toContain(
				`${MCP_ANALYTICS_BLOB.userId} = 'user-1'`,
			);
			expect(mock.queries[0]).toContain(
				`SUM(IF(${MCP_ANALYTICS_DOUBLE.success} = 0`,
			);
		} finally {
			mock.restore();
		}
	});

	test("summary includes inner tool calls correlated by executionId", async () => {
		const mock = mockAEFetch([
			{ data: [{ executionId: "exec-1" }] },
			{
				data: [
					{
						eventType: "code_exec",
						successValue: 1,
						totalEvents: 1,
						durationSum: 20,
					},
				],
			},
			{
				data: [
					{
						eventType: "tool_call",
						successValue: 1,
						totalEvents: 2,
						durationSum: 30,
					},
					{
						eventType: "tool_call",
						successValue: 0,
						totalEvents: 1,
						durationSum: 15,
					},
				],
			},
			{ data: [{ callerType: "tedi" }] },
			{
				data: [
					{ callerType: "tedi" },
					{ callerType: "00017533-22cb-40e5-9d06-087dafb603e2" },
					{ callerType: "not-a-real-auth-mode" },
				],
			},
			{ data: [{ userId: "user-1" }] },
			{ data: [{ userId: "user-1" }, { userId: "user-2" }] },
		]);

		try {
			const summary = await getAppSummaryFromAE(
				env,
				"app-1",
				"2026-05-11T00:00:00Z",
				"2026-05-11T01:00:00Z",
			);

			expect(summary).toEqual({
				totalEvents: 4,
				toolCalls: 3,
				promptCalls: 0,
				codeExecs: 1,
				successRate: 75,
				avgDurationMs: 16,
				uniqueUsers: 2,
				uniqueCallerTypes: ["tedi"],
			});
			expect(mock.queries[2]).toContain(
				`${MCP_ANALYTICS_BLOB.executionId} IN ('exec-1')`,
			);
			expect(mock.queries[0]).toContain("timestamp");
			expect(mock.queries[0]).not.toContain("timestamp AS");
			expect(mock.queries[0]).toContain("ORDER BY timestamp DESC");
			expect(mock.queries[0]).not.toContain(
				`GROUP BY ${MCP_ANALYTICS_BLOB.executionId}`,
			);
			expect(mock.queries[3]).toContain(
				`SELECT ${MCP_ANALYTICS_BLOB.authType} AS callerType`,
			);
			expect(mock.queries[3]).toContain(
				`GROUP BY ${MCP_ANALYTICS_BLOB.authType}`,
			);
		} finally {
			mock.restore();
		}
	});

	test("tool breakdown merges direct app calls and correlated inner calls", async () => {
		const mock = mockAEFetch([
			{ data: [{ executionId: "exec-1" }] },
			{ data: [] },
			{
				data: [
					{
						toolName: "memory_health",
						successValue: 1,
						calls: 2,
						durationSum: 30,
						maxDuration: 20,
						inputSizeSum: 200,
						outputSizeSum: 6000,
					},
					{
						toolName: "memory_health",
						successValue: 0,
						calls: 1,
						durationSum: 15,
						maxDuration: 15,
						inputSizeSum: 100,
						outputSizeSum: 3000,
					},
				],
			},
		]);

		try {
			const tools = await getAppToolBreakdownFromAE(
				env,
				"app-1",
				"2026-05-11T00:00:00Z",
				"2026-05-11T01:00:00Z",
			);

			expect(tools).toEqual([
				{
					toolName: "memory_health",
					totalCalls: 3,
					successCalls: 2,
					failedCalls: 1,
					successRate: 66.7,
					avgDurationMs: 15,
					maxDurationMs: 20,
					avgInputBytes: 100,
					avgOutputBytes: 3000,
				},
			]);
			expect(mock.queries[2]).toContain(
				`${MCP_ANALYTICS_BLOB.executionId} IN ('exec-1')`,
			);
		} finally {
			mock.restore();
		}
	});

	test("recent execution toolCount uses raw drilldown row count", async () => {
		const mock = mockAEFetch([
			{
				data: [
					{
						executionId: "exec-1",
						success: 1,
						durationMs: 42,
						timestamp: "2026-05-11 00:00:01",
					},
				],
			},
			{ data: [{ executionId: "exec-1", cnt: 2 }] },
		]);

		try {
			const executions = await getRecentExecutionsFromAE(
				env,
				"app-1",
				"2026-05-11T00:00:00Z",
				"2026-05-11T01:00:00Z",
			);

			expect(executions[0]?.toolCount).toBe(2);
			expect(mock.queries[1]).toContain("COUNT() AS cnt");
		} finally {
			mock.restore();
		}
	});

	test("execution drilldown scopes the AE query to the caller's org", async () => {
		const mock = mockAEFetch([{ data: [] }]);

		try {
			await getExecutionDrilldownFromAE(env, "exec-1", "org-1");

			expect(mock.queries[0]).toContain(
				`${MCP_ANALYTICS_BLOB.executionId} = 'exec-1'`,
			);
			expect(mock.queries[0]).toContain(
				`${MCP_ANALYTICS_BLOB.organizationId} = 'org-1'`,
			);
		} finally {
			mock.restore();
		}
	});

	test("execution drilldown omits the org filter for platform principals", async () => {
		const mock = mockAEFetch([{ data: [] }]);

		try {
			await getExecutionDrilldownFromAE(env, "exec-1");

			expect(mock.queries[0]).not.toContain(
				`${MCP_ANALYTICS_BLOB.organizationId} =`,
			);
		} finally {
			mock.restore();
		}
	});
});
