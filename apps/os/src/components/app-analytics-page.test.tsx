/**
 * Smoke coverage for the app analytics page.
 *
 * Every analytics read is seeded under its generated `osQuery` key, so the
 * page renders from cache with no network. The assertions pin the section
 * headings each lane renders, which is the oracle for moving sections into
 * `app-analytics/*` without changing what the route paints.
 */

import type {
	AppActivityFreshnessSchema,
	AppTimeSeriesSchema,
	AppToolBreakdownSchema,
	HumanActivityReviewSchema,
	RecentExecutionsSchema,
} from "@tedix/api-contract/contracts/analytics";
import type {
	ActivityItem,
	ActivityReviewGroup,
	AnalyticsMetrics,
	AppSummarySchema,
	CodemodeAnalyticsSummarySchema,
	IdentityCoverage,
	PrincipalDescriptor,
	RecentActivity,
} from "@tedix/api-contract/schemas/analytics";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import type { z } from "zod";

vi.mock("@tanstack/react-router", async (importOriginal) => ({
	...(await importOriginal<typeof import("@tanstack/react-router")>()),
	useParams: () => ({ appId: APP_ID }),
}));

// The ECharts chart is a lazy chunk; the table beside it is the exact-value
// view this suite asserts on, so the chart module is stubbed out.
vi.mock("./app-event-volume-chart", () => ({
	EventVolumeChart: () => null,
}));

import {
	appAnalyticsRange,
	appAnalyticsSummaryQueryOptions,
	appCodemodeSummaryQueryOptions,
	appFreshnessQueryOptions,
	appHumanActivityReviewQueryOptions,
	appMetricsQueryOptions,
	appRecentActivityQueryOptions,
	appRecentExecutionsQueryOptions,
	appTimeSeriesQueryOptions,
	appToolBreakdownQueryOptions,
} from "@/lib/os-query-options";
import { AppAnalyticsPage } from "./app-analytics-page";
import * as analyticsShared from "./app-analytics/shared";

const APP_ID = "11111111-1111-4111-8111-111111111111";
const NOW = new Date("2026-10-20T10:30:00.000Z");

(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

type AppSummary = z.infer<typeof AppSummarySchema>;
type AppToolBreakdown = z.infer<typeof AppToolBreakdownSchema>;
type AppTimeSeries = z.infer<typeof AppTimeSeriesSchema>;
type AppActivityFreshness = z.infer<typeof AppActivityFreshnessSchema>;
type RecentExecutions = z.infer<typeof RecentExecutionsSchema>;
type HumanActivityReview = z.infer<typeof HumanActivityReviewSchema>;
type CodemodeSummary = z.infer<typeof CodemodeAnalyticsSummarySchema>;

const metrics: AnalyticsMetrics = {
	totalSessions: 42,
	sessionsChange: 12,
	avgMessages: 3.5,
	avgMessagesChange: -4,
	successRate: 97.2,
	successRateChange: 0,
};

const summary: AppSummary = {
	totalEvents: 120,
	toolCalls: 90,
	promptCalls: 10,
	codeExecs: 20,
	successRate: 97,
	avgDurationMs: 180,
	uniqueUsers: 7,
	uniqueCallerTypes: ["oauth", "api_key"],
};

const emptySummary: AppSummary = {
	...summary,
	totalEvents: 0,
	toolCalls: 0,
	promptCalls: 0,
	codeExecs: 0,
	uniqueUsers: 0,
	uniqueCallerTypes: [],
};

const toolBreakdown: AppToolBreakdown = {
	tools: [
		{
			toolName: "list_invoices",
			totalCalls: 60,
			successCalls: 58,
			failedCalls: 2,
			successRate: 97,
			avgDurationMs: 140,
			maxDurationMs: 6200,
			avgInputBytes: 512,
			avgOutputBytes: 4096,
		},
	],
};

const timeSeries: AppTimeSeries = {
	buckets: [
		{
			bucket: "2026-10-18 00:00:00",
			totalEvents: 50,
			successEvents: 48,
			failedEvents: 2,
			avgDurationMs: 150,
		},
		{
			bucket: "2026-10-19 00:00:00",
			totalEvents: 70,
			successEvents: 70,
			failedEvents: 0,
			avgDurationMs: 160,
		},
	],
};

const freshness: AppActivityFreshness = {
	windowStart: "2026-10-20T10:00:00.000Z",
	windowEnd: "2026-10-20T11:00:00.000Z",
	currentWindow: {
		totalEvents: 5,
		toolExecutions: 3,
		codeExecutions: 2,
		toolErrors: 1,
	},
	latestAuditEvent: {
		action: "mcp.tool.execute",
		resourceId: "list_invoices",
		timestamp: "2026-10-20T10:25:00.000Z",
		durationMs: 120,
		executionId: "22222222-2222-4222-8222-222222222222",
		traceId: "trace-abcdef0123456789",
		toolCount: 2,
		namespaceCount: 1,
	},
};

const recentExecutions: RecentExecutions = {
	executions: [
		{
			executionId: "22222222-2222-4222-8222-222222222222",
			success: true,
			durationMs: 420,
			timestamp: "2026-10-20T10:25:00.000Z",
			toolCount: 2,
		},
	],
};

const codemode: CodemodeSummary = {
	byNamespace: [
		{
			namespace: "acme",
			totalCalls: 20,
			successCalls: 19,
			failedCalls: 1,
			successRate: 95,
			avgDurationMs: 90,
		},
	],
	topTools: [
		{
			toolName: "acme.list_invoices",
			namespace: "acme",
			totalCalls: 20,
			successCalls: 19,
			failedCalls: 1,
			successRate: 95,
			avgDurationMs: 90,
			p50DurationMs: 80,
		},
	],
	execSummary: {
		totalExecs: 20,
		successExecs: 19,
		failedExecs: 1,
		successRate: 95,
		avgDurationMs: 300,
		avgToolCount: 1.5,
		avgNamespaceCount: 1,
	},
};

const emptyCodemode: CodemodeSummary = {
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

const actor: PrincipalDescriptor = {
	id: "user-1",
	type: "user",
	label: "Adriana Example",
	secondary: "adriana@example.test",
	slug: null,
	avatarUrl: null,
	unresolved: false,
};

const identityCoverage: IdentityCoverage = {
	actorResolved: true,
	subjectPresent: true,
	subjectResolved: true,
	agentPresent: false,
	agentResolved: false,
	appResolved: true,
	toolResolved: true,
	clientPresent: true,
	warnings: [],
	warningDetails: [],
};

const activityItem: ActivityItem = {
	timestamp: "2026-10-20T10:25:00.000Z",
	actorId: "user-1",
	actorType: "user",
	actor,
	subject: actor,
	agent: null,
	attribution: {
		mode: null,
		actor,
		subject: actor,
		agent: null,
		client: { id: "claude", label: "Claude" },
		summary: "Adriana Example via Claude",
	},
	identityCoverage,
	action: "mcp.tool.execute",
	success: true,
	toolName: "list_invoices",
	tool: {
		id: "tool-1",
		label: "List invoices",
		toolName: "list_invoices",
		title: "List invoices",
		appId: APP_ID,
		appLabel: "Acme",
		appSlug: "acme",
		unresolved: false,
	},
	appId: APP_ID,
	app: { id: APP_ID, label: "Acme", slug: "acme", unresolved: false },
	executionId: "22222222-2222-4222-8222-222222222222",
	traceId: "trace-abcdef0123456789",
	clientId: "claude",
	delegationMode: null,
	durationMs: 120,
	errorCode: null,
	securityDecision: {
		disposition: "executed",
		denialReason: null,
		httpStatus: null,
		mcpMethod: "tools/call",
		riskTier: "read",
	},
};

const recentActivity: RecentActivity = { items: [activityItem] };

const reviewGroup: ActivityReviewGroup = {
	id: "group-1",
	title: "List invoices session",
	summary: "1 tool call",
	startedAt: "2026-10-20T10:20:00.000Z",
	endedAt: "2026-10-20T10:25:00.000Z",
	totalEvents: 1,
	successfulEvents: 1,
	errorEvents: 0,
	traceId: "trace-abcdef0123456789",
	executionId: null,
	actor,
	subject: actor,
	agent: null,
	attribution: activityItem.attribution,
	apps: [activityItem.app as NonNullable<ActivityItem["app"]>],
	topTools: [
		{
			tool: activityItem.tool as NonNullable<ActivityItem["tool"]>,
			count: 1,
			errors: 0,
		},
	],
	identityCoverage,
	traceEvidence: {
		status: "mcp_linked",
		mcpEvents: 1,
		runtimeEvents: 0,
		cognitiveEvents: 0,
		retrievalEvents: 0,
		decisionEvents: 0,
		retrievedFactCount: 0,
		citedFactCount: 0,
		ignoredFactCount: 0,
		runtimeBackends: [],
		hasRetrievalDecisionJoin: false,
		latestRuntimeAt: null,
		latestCognitiveAt: null,
		latestRetrievalAt: null,
		latestDecisionAt: null,
		cloudflare: {
			sampled: false,
			traceId: null,
			spanCount: 0,
			serviceNames: [],
			durationMs: null,
			errorCount: 0,
			traceStartAt: null,
			traceEndAt: null,
		},
		cognition: {
			summary: "No cognitive evidence linked.",
			retrievedFactIds: [],
			citedFactIds: [],
			ignoredFactIds: [],
			decisionIds: [],
			latestDecision: null,
			retrieval: {
				topK: null,
				returnedCount: null,
				vectorEnabled: null,
				vectorMs: null,
				hydrateFactsMs: null,
			},
			graph: {
				status: "not_applicable",
				projectedDecisionIds: [],
				warnings: [],
			},
			warnings: [],
		},
		warnings: [],
	},
	securityPosture: {
		disposition: "executed",
		executedEvents: 1,
		deniedEvents: 0,
		denialReasons: [],
		mcpMethods: ["tools/call"],
		riskTiers: ["read"],
		unknownRiskEvents: 0,
	},
	evidence: {
		auditEventCount: 1,
		payloadsConfigured: true,
		source: "audit_events",
	},
};

const humanReview: HumanActivityReview = {
	windowStart: "2026-10-20T09:00:00.000Z",
	windowEnd: "2026-10-20T11:00:00.000Z",
	totalEvents: 1,
	groups: [reviewGroup],
	coverage: {
		totalGroups: 1,
		unresolvedActorGroups: 0,
		missingSubjectGroups: 0,
		unresolvedToolGroups: 0,
		securityPosture: {
			executedGroups: 1,
			deniedGroups: 0,
			mixedGroups: 0,
			executedEvents: 1,
			deniedEvents: 0,
			unknownRiskEvents: 0,
			denialReasons: [],
		},
		traceEvidence: {
			status: "met",
			targetCoverageRate: 0.9,
			proofCoverageRate: 1,
			proofLinkedGroups: 1,
			auditOnlyGroups: 0,
			mcpLinkedGroups: 1,
			runtimeLinkedGroups: 0,
			cognitiveLinkedGroups: 0,
			retrievalDecisionLinkedGroups: 0,
			missingTraceGroups: 0,
			warnings: [],
		},
		traceFreshness: {
			status: "met",
			targetMaxLagMs: 120_000,
			freshnessRate: 1,
			proofGroups: 1,
			freshGroups: 1,
			staleGroups: 0,
			missingProofTimestampGroups: 0,
			maxLagMs: 4_000,
			latestAuditAt: "2026-10-20T10:25:00.000Z",
			latestProofAt: "2026-10-20T10:25:04.000Z",
			warnings: [],
		},
		warnings: [],
	},
};

const cleanups: Array<() => void> = [];

interface Seeds {
	summary?: AppSummary;
	codemode?: CodemodeSummary;
	humanReview?: HumanActivityReview;
	recentActivity?: RecentActivity;
}

async function renderAnalytics(seeds: Seeds = {}) {
	vi.useFakeTimers({ shouldAdvanceTime: true });
	vi.setSystemTime(NOW);
	const range = appAnalyticsRange();
	const client = new QueryClient({
		defaultOptions: {
			queries: { retry: false, staleTime: Infinity },
			mutations: { retry: false },
		},
	});
	client.setQueryData(appMetricsQueryOptions(APP_ID, range).queryKey, metrics);
	client.setQueryData(
		appAnalyticsSummaryQueryOptions(APP_ID, range).queryKey,
		seeds.summary ?? summary,
	);
	client.setQueryData(
		appToolBreakdownQueryOptions(APP_ID, range).queryKey,
		toolBreakdown,
	);
	client.setQueryData(
		appTimeSeriesQueryOptions(APP_ID, range).queryKey,
		timeSeries,
	);
	client.setQueryData(
		appRecentExecutionsQueryOptions(APP_ID, range).queryKey,
		recentExecutions,
	);
	client.setQueryData(appFreshnessQueryOptions(APP_ID).queryKey, freshness);
	client.setQueryData(
		appRecentActivityQueryOptions(APP_ID).queryKey,
		seeds.recentActivity ?? recentActivity,
	);
	client.setQueryData(
		appHumanActivityReviewQueryOptions(APP_ID).queryKey,
		seeds.humanReview ?? humanReview,
	);
	client.setQueryData(
		appCodemodeSummaryQueryOptions(APP_ID, range).queryKey,
		seeds.codemode ?? codemode,
	);

	const container = document.createElement("div");
	document.body.appendChild(container);
	const root = createRoot(container);
	await act(async () => {
		root.render(
			<QueryClientProvider client={client}>
				<AppAnalyticsPage />
			</QueryClientProvider>,
		);
	});
	// Let the lazy chart chunk settle so Suspense resolves inside act.
	await act(async () => {
		await Promise.resolve();
	});
	cleanups.push(() => {
		act(() => root.unmount());
		container.remove();
	});
	return container;
}

afterEach(() => {
	while (cleanups.length > 0) cleanups.pop()?.();
	vi.useRealTimers();
});

function headings(container: HTMLElement): string[] {
	return [
		...container.querySelectorAll<HTMLElement>('[data-slot="card-title"]'),
	].map((node) => (node.textContent ?? "").replace(/\s+/g, " ").trim());
}

describe("AppAnalyticsPage", () => {
	it("does not retain obsolete header or loading exports", () => {
		expect("AnalyticsHeader" in analyticsShared).toBe(false);
		expect("AnalyticsPending" in analyticsShared).toBe(false);
	});

	it("renders every section from seeded analytics reads", async () => {
		const container = await renderAnalytics();
		const text = container.textContent ?? "";

		expect(container.querySelector("h2")?.textContent).toBe("Analytics");
		expect(text).toContain("Audit trail");
		expect(text).toContain("Latest tool call 5m ago");
		expect(text).toContain("Total sessions");
		expect(text).toContain("Avg messages");
		expect(text).toContain("Success rate");
		expect(text).toContain("Total events");
		expect(text).toContain("Caller auth types");
		expect(text).toContain("OAuth");
		expect(text).toContain("API key");

		const titles = headings(container);
		expect(titles).toEqual(
			expect.arrayContaining([
				expect.stringContaining("Event Volume"),
				expect.stringContaining("Tool breakdown"),
				expect.stringContaining("Code Mode"),
				expect.stringContaining("Activity Review"),
				expect.stringContaining("Recent Activity"),
				expect.stringContaining("Recent Code Executions"),
			]),
		);
		expect(titles.find((title) => title.includes("Tool breakdown"))).toContain(
			"1 tools",
		);
		expect(titles.find((title) => title.startsWith("Code Mode"))).toContain(
			"20 execs",
		);
		expect(titles.find((title) => title.includes("Activity Review"))).toContain(
			"1 episodes",
		);

		// Row content from each lane.
		expect(text).toContain("list_invoices");
		expect(text).toContain("10-18");
		expect(text).toContain("acme.list_invoices");
		expect(text).toContain("List invoices session");
		expect(text).toContain("Adriana Example");
		expect(text).toContain("22222222…");
		expect(text).not.toContain("could not be loaded");
	});

	it("renders the empty-period states for the audit and Code Mode lanes", async () => {
		const container = await renderAnalytics({
			codemode: emptyCodemode,
			humanReview: { ...humanReview, groups: [] },
			recentActivity: { items: [] },
		});
		const text = container.textContent ?? "";

		expect(headings(container)).not.toEqual(
			expect.arrayContaining([
				expect.stringContaining("Code Mode"),
				expect.stringContaining("Activity Review"),
				expect.stringContaining("Recent Activity"),
			]),
		);
		expect(text).toContain("No code mode analytics in this period.");
		expect(text).toContain("No human activity review in this period.");
		expect(text).toContain("No recent activity in this period.");
	});

	it("shows the no-activity empty state when the summary has no events", async () => {
		const container = await renderAnalytics({ summary: emptySummary });
		const text = container.textContent ?? "";

		expect(container.querySelector("h2")?.textContent).toBe("Analytics");
		expect(text).toContain("No activity yet");
		expect(text).toContain("Connect a client to generate your first session.");
		expect(headings(container)).toEqual([]);
	});
});
