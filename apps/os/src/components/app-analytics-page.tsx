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

import { type UseQueryResult, useQuery } from "@tanstack/react-query";
import { useParams } from "@tanstack/react-router";
import { ChartBar, Clock, Wrench } from "@phosphor-icons/react";
import { lazy, type ReactNode, Suspense, useMemo } from "react";
import { Badge } from "@/components/kumo/badge";
import {
	Card,
	CardContent,
	CardHeader,
	CardTitle,
} from "@/components/kumo/card";
import {
	AppTabHeader,
	AppTabEmpty,
	AppTabError,
	AppTabLoading,
} from "./app-detail-tab-shared";
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
	AnalyticsQueryState,
	CallerTypesCard,
	EventVolumeTable,
	PeriodChange,
} from "./app-analytics/shared";
import { ToolBreakdownTable } from "./app-analytics/tool-breakdown";

const EventVolumeChart = lazy(() =>
	import("./app-event-volume-chart").then((module) => ({
		default: module.EventVolumeChart,
	})),
);

// =============================================================================

/**
 * One independently read analytics section. A section that is still loading,
 * failed, or empty says so instead of disappearing, so a failed read never
 * looks like zero activity. A failed refresh keeps the earlier data on screen
 * and says it is earlier data; retry refetches this section's read alone.
 */
function AnalyticsSection<T>({
	label,
	query,
	isEmpty,
	children,
}: {
	label: string;
	query: UseQueryResult<T>;
	isEmpty?: (data: T) => boolean;
	children: (data: T) => ReactNode;
}) {
	if (query.data === undefined) {
		return query.isError ? (
			<AnalyticsQueryState label={label} state="error" query={query} />
		) : (
			<AnalyticsQueryState label={label} state="loading" />
		);
	}
	const stale = query.isError ? (
		<AnalyticsQueryState label={label} state="stale" query={query} />
	) : null;
	if (isEmpty?.(query.data))
		return stale ?? <AnalyticsQueryState label={label} state="empty" />;
	return (
		<>
			{stale}
			{children(query.data)}
		</>
	);
}

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

	const humanReviewQuery = useQuery({
		...appHumanActivityReviewQueryOptions(appId),
		enabled,
		refetchInterval: 30_000,
	});

	// Code Mode execution analytics (Analytics Engine, can be slow). The
	// procedure never throws: an unconfigured AE returns a well-formed empty
	// summary, so the panel gates on data contents.
	const codemodeQuery = useQuery({
		...appCodemodeSummaryQueryOptions(appId, range),
		enabled,
		refetchInterval: 60_000,
	});

	const header = (
		<AppTabHeader
			title="Analytics"
			description="Usage from tool interactions."
			actions={<Badge variant="outline">Last 30 days · live window</Badge>}
		/>
	);
	if (metricsQuery.isPending || summaryQuery.isPending) {
		return (
			<div className="space-y-6">
				{header}
				<AppTabLoading label="Loading analytics" />
			</div>
		);
	}
	const metrics = metricsQuery.data;
	const summary = summaryQuery.data;
	if (metrics === undefined || summary === undefined) {
		const query = metricsQuery.isError ? metricsQuery : summaryQuery;
		return (
			<div className="space-y-6">
				{header}
				<AppTabError title="Analytics are unavailable" query={query}>
					Analytics could not be loaded: {query.error?.message}
				</AppTabError>
			</div>
		);
	}
	// A failed refresh keeps the earlier metrics and says so.
	const staleMetricsQuery = metricsQuery.isError
		? metricsQuery
		: summaryQuery.isError
			? summaryQuery
			: null;

	// Audit-backed lanes are read independently of the sampled Analytics
	// Engine summary, so a zero there must not hide them.
	const auditSections = (
		<>
			<AnalyticsSection
				label="Human activity review"
				query={humanReviewQuery}
				isEmpty={(review) => review.groups.length === 0}
			>
				{(review) => <HumanActivityReviewSection review={review} />}
			</AnalyticsSection>
			<AnalyticsSection
				label="Recent activity"
				query={recentActivityQuery}
				isEmpty={(activity) => activity.items.length === 0}
			>
				{(activity) => <RecentActivitySection items={activity.items} />}
			</AnalyticsSection>
			<AnalyticsSection
				label="Recent code executions"
				query={recentExecutionsQuery}
				isEmpty={(recent) => recent.executions.length === 0}
			>
				{(recent) => <RecentExecutionsSection executions={recent.executions} />}
			</AnalyticsSection>
		</>
	);
	const freshnessSection = (
		<AnalyticsSection label="Activity freshness" query={freshnessQuery}>
			{(freshness) => <ActivityFreshnessStrip freshness={freshness} />}
		</AnalyticsSection>
	);
	const staleMetrics = staleMetricsQuery ? (
		<AnalyticsQueryState
			label="Usage metrics"
			state="stale"
			query={staleMetricsQuery}
		/>
	) : null;

	if (summary.totalEvents === 0) {
		return (
			<div className="space-y-6">
				{header}
				{freshnessSection}
				{staleMetrics}
				<AppTabEmpty
					icon={<ChartBar size={20} />}
					title="No tool events in this period"
					description="Usage metrics appear once a connected client calls your tools. Connect a client to generate your first session."
				/>
				{auditSections}
			</div>
		);
	}

	return (
		<div className="space-y-6">
			{header}
			{freshnessSection}
			{staleMetrics}

			<MetricGrid aria-label="Session summary" columns={3} appearance="bounded">
				<MetricItem
					emphasis="metric"
					label="Total sessions"
					value={
						<span className="flex flex-wrap items-baseline gap-2">
							{metrics.totalSessions.toLocaleString()}
							<PeriodChange change={metrics.sessionsChange} />
						</span>
					}
					description="Unique conversations started"
				/>
				<MetricItem
					emphasis="metric"
					label="Avg messages"
					value={
						<span className="flex flex-wrap items-baseline gap-2">
							{metrics.avgMessages.toFixed(1)}
							<PeriodChange change={metrics.avgMessagesChange} />
						</span>
					}
					description="Tool calls per session"
				/>
				<MetricItem
					emphasis="metric"
					label="Success rate"
					value={
						<span className="flex flex-wrap items-baseline gap-2">
							{`${Math.round(metrics.successRate)}%`}
							<PeriodChange change={metrics.successRateChange} />
						</span>
					}
					description="Tool calls completed successfully"
				/>
			</MetricGrid>

			{/* Event Type Breakdown */}
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

			{/* The chart is route-lazy; the table remains the exact-value view. */}
			<AnalyticsSection
				label="Event volume"
				query={timeSeriesQuery}
				isEmpty={(series) => series.buckets.length === 0}
			>
				{(series) => (
					<>
						<Suspense fallback={<Skeleton className="h-60" />}>
							<EventVolumeChart buckets={series.buckets} />
						</Suspense>
						<EventVolumeTable buckets={series.buckets} />
					</>
				)}
			</AnalyticsSection>

			{/* Avg Latency + Caller Types */}
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

			<AnalyticsSection
				label="Tool breakdown"
				query={toolBreakdownQuery}
				isEmpty={(breakdown) => breakdown.tools.length === 0}
			>
				{(breakdown) => (
					<Card>
						<CardHeader>
							<CardTitle className="flex items-center gap-2">
								<Wrench size={16} aria-hidden />
								Tool breakdown
								<Badge variant="outline" className="ml-1 font-normal">
									{breakdown.tools.length} tools
								</Badge>
							</CardTitle>
						</CardHeader>
						<CardContent className="px-0">
							<ToolBreakdownTable tools={breakdown.tools} />
						</CardContent>
					</Card>
				)}
			</AnalyticsSection>

			{/* Code Mode execution analytics (Analytics Engine, sampled) */}
			<AnalyticsSection
				label="Code Mode analytics"
				query={codemodeQuery}
				isEmpty={(codemode) =>
					codemode.execSummary.totalExecs === 0 &&
					codemode.byNamespace.length === 0
				}
			>
				{(codemode) => <CodeModeAnalyticsSection summary={codemode} />}
			</AnalyticsSection>

			{auditSections}
		</div>
	);
}
