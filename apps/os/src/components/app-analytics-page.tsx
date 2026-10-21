/**
 * /apps/$appId/analytics — MCP usage analytics.
 *
 * The event-volume trend uses Kumo's ECharts wrapper behind a route-local
 * lazy chunk. The compact table beside it remains the exact-value and
 * keyboard-friendly view; recharts stays out of apps/os.
 *
 * The rest of the OS surface includes session metrics with
 * period-over-period deltas, event-type summary, tool breakdown, Code Mode
 * analytics, the audit-backed activity review and recent-activity lanes with
 * per-trace drilldowns, and recent code executions with payload drilldowns.
 */

import { useQuery } from "@tanstack/react-query";
import { useParams } from "@tanstack/react-router";
import {
	ChartBar,
	CheckCircle,
	Clock,
	Lightbulb,
	Pulse,
	Wrench,
} from "@phosphor-icons/react";
import { lazy, Suspense, useMemo } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/kumo/alert";
import { Badge } from "@/components/kumo/badge";
import {
	Card,
	CardContent,
	CardHeader,
	CardTitle,
} from "@/components/kumo/card";
import {
	Empty,
	EmptyContent,
	EmptyDescription,
	EmptyHeader,
	EmptyMedia,
	EmptyTitle,
} from "@/components/kumo/empty";
import { MetricGrid, MetricItem } from "@/components/kumo/metric-grid";
import { Skeleton } from "@/components/kumo/skeleton";
import { Text } from "@/components/kumo/text";
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
import { HumanActivityReviewSection } from "./app-analytics/activity-review";
import { CodeModeAnalyticsSection } from "./app-analytics/code-mode-section";
import { RecentActivitySection } from "./app-analytics/recent-activity";
import { RecentExecutionsSection } from "./app-analytics/recent-executions";
import {
	ActivityFreshnessStrip,
	AnalyticsHeader,
	AnalyticsPending,
	AnalyticsQueryState,
	CallerTypesCard,
	EventVolumeTable,
	MetricCard,
} from "./app-analytics/shared";
import { ToolBreakdownTable } from "./app-analytics/tool-breakdown";

const EventVolumeChart = lazy(() =>
	import("./app-event-volume-chart").then((module) => ({
		default: module.EventVolumeChart,
	})),
);

// =============================================================================

export function AppAnalyticsPage() {
	const params = useParams({ from: "/_session/_tenant/apps_/$appId" });
	const appId = params.appId ?? "";
	const range = useMemo(() => appAnalyticsRange(), []);
	const enabled = appId.length > 0;

	const metricsQuery = useQuery({
		...appMetricsQueryOptions(appId, range),
		enabled,
		refetchInterval: 60_000,
	});
	const summaryQuery = useQuery({
		...appAnalyticsSummaryQueryOptions(appId, range),
		enabled,
		refetchInterval: 60_000,
	});
	const toolBreakdownQuery = useQuery({
		...appToolBreakdownQueryOptions(appId, range),
		enabled,
		refetchInterval: 60_000,
	});
	const timeSeriesQuery = useQuery({
		...appTimeSeriesQueryOptions(appId, range),
		enabled,
		refetchInterval: 60_000,
	});
	const recentExecutionsQuery = useQuery({
		...appRecentExecutionsQueryOptions(appId, range),
		enabled,
		refetchInterval: 60_000,
	});
	const freshnessQuery = useQuery({
		...appFreshnessQueryOptions(appId),
		enabled,
		refetchInterval: 30_000,
	});

	// Audit-backed "who used which tool recently" — never blocks first paint.
	// This is the authoritative actor lane (not sampled AE).
	const recentActivityQuery = useQuery({
		...appRecentActivityQueryOptions(appId),
		enabled,
		refetchInterval: 30_000,
	});
	const recentActivity = recentActivityQuery.data;

	const humanReviewQuery = useQuery({
		...appHumanActivityReviewQueryOptions(appId),
		enabled,
		refetchInterval: 30_000,
	});
	const humanReview = humanReviewQuery.data;

	// Code Mode execution analytics (Analytics Engine, can be slow). The
	// procedure never throws: an unconfigured AE returns a well-formed empty
	// summary, so the panel gates on data contents.
	const codemodeQuery = useQuery({
		...appCodemodeSummaryQueryOptions(appId, range),
		enabled,
		refetchInterval: 60_000,
	});
	const codemode = codemodeQuery.data;

	if (metricsQuery.isPending || summaryQuery.isPending) {
		return <AnalyticsPending />;
	}
	if (metricsQuery.isError || summaryQuery.isError) {
		const error = (metricsQuery.error ?? summaryQuery.error) as Error;
		return (
			<Card>
				<CardContent>
					<Alert variant="destructive">
						<AlertDescription>
							Analytics could not be loaded: {error.message}
						</AlertDescription>
					</Alert>
				</CardContent>
			</Card>
		);
	}

	const metrics = metricsQuery.data;
	const summary = summaryQuery.data;
	const toolBreakdown = toolBreakdownQuery.data;
	const timeSeries = timeSeriesQuery.data;
	const recentExecutions = recentExecutionsQuery.data;
	const freshness = freshnessQuery.data;

	const hasActivity = (summary?.totalEvents ?? 0) > 0;

	if (!hasActivity) {
		return (
			<div className="space-y-6">
				<AnalyticsHeader />
				<Card>
					<CardContent>
						<Empty appearance="inline">
							<EmptyHeader>
								<EmptyMedia variant="icon">
									<ChartBar size={20} />
								</EmptyMedia>
								<EmptyTitle>No activity yet</EmptyTitle>
								<EmptyDescription>
									Analytics will appear once users start interacting with your
									MCP tools. Connect a client to get started.
								</EmptyDescription>
							</EmptyHeader>
							<EmptyContent>
								<Alert variant="info">
									<Lightbulb aria-hidden />
									<AlertTitle>Generate your first session</AlertTitle>
									<AlertDescription>
										Try connecting your app via Claude Desktop, ChatGPT, or any
										MCP-compatible client to generate your first session.
									</AlertDescription>
								</Alert>
							</EmptyContent>
						</Empty>
					</CardContent>
				</Card>
			</div>
		);
	}

	return (
		<div className="space-y-6">
			<AnalyticsHeader />
			{freshness && <ActivityFreshnessStrip freshness={freshness} />}

			{/* Session Metrics (period-over-period comparison) */}
			<div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
				<MetricCard
					title="Total Sessions"
					description="Unique conversations started"
					value={String(metrics.totalSessions)}
					change={metrics.sessionsChange}
					icon={<Pulse size={16} aria-hidden className="text-kumo-subtle" />}
				/>
				<MetricCard
					title="Avg Messages"
					description="Tool calls per session"
					value={metrics.avgMessages.toFixed(1)}
					change={metrics.avgMessagesChange}
					icon={<Wrench size={16} aria-hidden className="text-kumo-subtle" />}
				/>
				<MetricCard
					title="Success Rate"
					description="Tool calls completed successfully"
					value={`${Math.round(metrics.successRate)}%`}
					change={metrics.successRateChange}
					icon={
						<CheckCircle size={16} aria-hidden className="text-kumo-subtle" />
					}
				/>
			</div>

			{/* Event Type Breakdown */}
			{summary && summary.totalEvents > 0 && (
				<MetricGrid aria-label="Event summary" columns={5}>
					<MetricItem
						emphasis="metric"
						label="Total events"
						value={summary.totalEvents.toLocaleString()}
					/>
					<MetricItem
						emphasis="metric"
						label="Tool calls"
						value={summary.toolCalls.toLocaleString()}
					/>
					<MetricItem
						emphasis="metric"
						label="Prompt calls"
						value={summary.promptCalls.toLocaleString()}
					/>
					<MetricItem
						emphasis="metric"
						label="Code executions"
						value={summary.codeExecs.toLocaleString()}
					/>
					<MetricItem
						emphasis="metric"
						label="Unique users"
						value={summary.uniqueUsers.toLocaleString()}
					/>
				</MetricGrid>
			)}

			{/* The chart is route-lazy; the table remains the exact-value view. */}
			{timeSeries && timeSeries.buckets.length > 0 && (
				<>
					<Suspense fallback={<Skeleton className="h-60" />}>
						<EventVolumeChart buckets={timeSeries.buckets} />
					</Suspense>
					<EventVolumeTable buckets={timeSeries.buckets} />
				</>
			)}

			{/* Avg Latency + Caller Types */}
			{summary && summary.totalEvents > 0 && (
				<div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
					<Card>
						<CardContent className="flex items-center gap-4">
							<div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-kumo-fill">
								<Clock size={20} aria-hidden className="text-kumo-subtle" />
							</div>
							<div>
								<Text as="p" role="metric" weight="semibold" className="m-0">
									{summary.avgDurationMs}ms
								</Text>
								<Text as="p" role="label" tone="secondary" className="m-0">
									Average latency across all event types
								</Text>
							</div>
						</CardContent>
					</Card>
					<CallerTypesCard callerTypes={summary.uniqueCallerTypes} />
				</div>
			)}

			{/* Tool Breakdown Table */}
			{toolBreakdown && toolBreakdown.tools.length > 0 && (
				<Card>
					<CardHeader>
						<CardTitle className="flex items-center gap-2">
							<Wrench size={16} aria-hidden />
							Tool Breakdown
							<Badge variant="outline" className="ml-1 font-normal">
								{toolBreakdown.tools.length} tools
							</Badge>
						</CardTitle>
					</CardHeader>
					<CardContent className="px-0">
						<ToolBreakdownTable tools={toolBreakdown.tools} />
					</CardContent>
				</Card>
			)}

			{/* Code Mode execution analytics (Analytics Engine, sampled) */}
			{codemode &&
				(codemode.execSummary.totalExecs > 0 ||
					codemode.byNamespace.length > 0) && (
					<CodeModeAnalyticsSection summary={codemode} />
				)}
			{codemodeQuery.isPending ? (
				<AnalyticsQueryState label="Code Mode analytics" state="loading" />
			) : codemodeQuery.isError ? (
				<AnalyticsQueryState label="Code Mode analytics" state="error" />
			) : codemode &&
			  codemode.execSummary.totalExecs === 0 &&
			  codemode.byNamespace.length === 0 ? (
				<AnalyticsQueryState label="Code Mode analytics" state="empty" />
			) : null}

			{/* Recent Activity (who — audit-backed) */}
			{humanReview && humanReview.groups.length > 0 && (
				<HumanActivityReviewSection review={humanReview} />
			)}
			{humanReviewQuery.isPending ? (
				<AnalyticsQueryState label="Human activity review" state="loading" />
			) : humanReviewQuery.isError ? (
				<AnalyticsQueryState label="Human activity review" state="error" />
			) : humanReview?.groups.length === 0 ? (
				<AnalyticsQueryState label="Human activity review" state="empty" />
			) : null}

			{recentActivity && recentActivity.items.length > 0 && (
				<RecentActivitySection items={recentActivity.items} />
			)}
			{recentActivityQuery.isPending ? (
				<AnalyticsQueryState label="Recent activity" state="loading" />
			) : recentActivityQuery.isError ? (
				<AnalyticsQueryState label="Recent activity" state="error" />
			) : recentActivity?.items.length === 0 ? (
				<AnalyticsQueryState label="Recent activity" state="empty" />
			) : null}

			{/* Recent Code Executions */}
			{recentExecutions && recentExecutions.executions.length > 0 && (
				<RecentExecutionsSection executions={recentExecutions.executions} />
			)}
		</div>
	);
}
