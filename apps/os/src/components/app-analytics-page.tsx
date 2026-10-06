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
	CodemodeAnalyticsSummarySchema,
	IdentityCoverage,
	PrincipalDescriptor,
	ToolCallPayload,
} from "@tedix/api-contract/schemas/analytics";
import {
	ArrowDown,
	ArrowUp,
	CaretDown,
	CaretRight,
	ChartBar,
	CheckCircle,
	Clock,
	Code,
	Info,
	Lightbulb,
	Pulse,
	Users,
	Wrench,
} from "@phosphor-icons/react";
import { lazy, Suspense, useId, useMemo, useState } from "react";
import type { z } from "zod";
import { Alert, AlertDescription, AlertTitle } from "@/components/kumo/alert";
import { Badge, type BadgeVariant } from "@/components/kumo/badge";
import { Button } from "@/components/kumo/button";
import {
	Card,
	CardContent,
	CardHeader,
	CardTitle,
} from "@/components/kumo/card";
import { CodeBlock } from "@/components/kumo/code";
import {
	Collapsible,
	CollapsibleContent,
	CollapsibleTrigger,
} from "@/components/kumo/collapsible";
import {
	Empty,
	EmptyContent,
	EmptyDescription,
	EmptyHeader,
	EmptyMedia,
	EmptyTitle,
} from "@/components/kumo/empty";
import { Progress } from "@/components/kumo/progress";
import { Collection } from "@/components/kumo/page";
import { MetricGrid, MetricItem } from "@/components/kumo/metric-grid";
import { Skeleton } from "@/components/kumo/skeleton";
import { Surface } from "@/components/kumo/surface";
import { Text } from "@/components/kumo/text";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@/components/kumo/table";
import {
	Tooltip,
	TooltipContent,
	TooltipProvider,
	TooltipTrigger,
} from "@/components/kumo/tooltip";
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
	executionDrilldownQueryOptions,
	toolCallPayloadsQueryOptions,
	traceActivityQueryOptions,
} from "@/lib/os-query-options";

type AppToolBreakdown = z.infer<typeof AppToolBreakdownSchema>;
type AppTimeSeries = z.infer<typeof AppTimeSeriesSchema>;
type AppActivityFreshness = z.infer<typeof AppActivityFreshnessSchema>;
type RecentExecutions = z.infer<typeof RecentExecutionsSchema>;
type HumanActivityReview = z.infer<typeof HumanActivityReviewSchema>;
type CodemodeSummary = z.infer<typeof CodemodeAnalyticsSummarySchema>;
type CodeModeRow =
	| CodemodeSummary["topTools"][number]
	| CodemodeSummary["byNamespace"][number];

const EventVolumeChart = lazy(() =>
	import("./app-event-volume-chart").then((module) => ({
		default: module.EventVolumeChart,
	})),
);

// =============================================================================
// Pure helpers (exported for tests)
// =============================================================================

export function formatDuration(ms: number): string {
	if (ms < 1000) return `${ms}ms`;
	if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
	return `${(ms / 60_000).toFixed(1)}m`;
}

export function prettyJson(body: string): string {
	if (!body) return "—";
	try {
		return JSON.stringify(JSON.parse(body), null, 2);
	} catch {
		return body;
	}
}

export function formatBytes(bytes: number): string {
	if (!bytes || bytes < 1) return "—";
	if (bytes < 1024) return `${Math.round(bytes)} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function formatTimestamp(ts: string, now: number = Date.now()): string {
	const d = new Date(ts);
	if (Number.isNaN(d.getTime())) return ts;
	const diffMs = now - d.getTime();
	if (diffMs < 3_600_000) return `${Math.round(diffMs / 60_000)}m ago`;
	if (diffMs < 86_400_000) return `${Math.round(diffMs / 3_600_000)}h ago`;
	return d.toLocaleDateString(undefined, {
		month: "short",
		day: "numeric",
		hour: "2-digit",
		minute: "2-digit",
	});
}

export function formatAuditAction(action: string): string {
	if (action === "mcp.code.execute") return "code execution";
	if (action === "mcp.tool.execute") return "tool call";
	if (action === "mcp.tool.error") return "tool error";
	return action.replaceAll(".", " ");
}

/** AE returns "YYYY-MM-DD HH:MM:SS" (space separator, no Z) — normalize to UTC. */
export function formatBucketLabel(bucket: string): string {
	const normalized = bucket
		.replace(" ", "T")
		.replace(/(\d{2}:\d{2}:\d{2})$/, "$1Z");
	const d = new Date(normalized);
	if (Number.isNaN(d.getTime())) return bucket;
	return `${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

const CALLER_TYPE_LABELS: Record<string, string> = {
	anonymous: "Anonymous",
	apiKey: "API key",
	m2m: "M2M",
	oauth: "OAuth",
	service: "Service",
	tedi: "Tedi",
	user: "User",
};

const UUID_LIKE =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function getCallerTypeDisplay(callerTypes: string[]): {
	visible: Array<{ value: string; label: string }>;
	hiddenCount: number;
} {
	const visible = new Map<string, string>();
	let hiddenCount = 0;

	for (const rawType of callerTypes) {
		const trimmed = rawType.trim();
		if (!trimmed) continue;

		const normalized =
			trimmed === "api_key" || trimmed === "apikey" ? "apiKey" : trimmed;
		const label = CALLER_TYPE_LABELS[normalized];
		if (label) {
			visible.set(normalized, label);
			continue;
		}

		if (UUID_LIKE.test(trimmed) || trimmed.length > 24) {
			hiddenCount += 1;
		}
	}

	return {
		visible: Array.from(visible, ([value, label]) => ({ value, label })),
		hiddenCount,
	};
}

function formatCurrentWindow(
	window: AppActivityFreshness["currentWindow"],
): string {
	if (window.totalEvents === 0) return "no events yet";
	const parts = [
		`${window.codeExecutions.toLocaleString()} code`,
		`${window.toolExecutions.toLocaleString()} tools`,
	];
	if (window.toolErrors > 0) {
		parts.push(`${window.toolErrors.toLocaleString()} errors`);
	}
	return parts.join(" · ");
}

// =============================================================================
// Page
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
					<p role="alert" className="m-0 text-kumo-danger text-sm">
						Analytics could not be loaded: {error.message}
					</p>
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

function AnalyticsQueryState({
	label,
	state,
}: {
	label: string;
	state: "loading" | "error" | "empty";
}) {
	return (
		<Card>
			<CardContent className="text-kumo-subtle text-sm">
				<p role={state === "error" ? "alert" : "status"} className="m-0">
					{state === "loading"
						? `Loading ${label.toLowerCase()}...`
						: state === "error"
							? `${label} could not be loaded.`
							: `No ${label.toLowerCase()} in this period.`}
				</p>
			</CardContent>
		</Card>
	);
}

function CallerTypesCard({ callerTypes }: { callerTypes: string[] }) {
	const display = useMemo(
		() => getCallerTypeDisplay(callerTypes),
		[callerTypes],
	);

	return (
		<Card>
			<CardContent className="flex min-h-[88px] items-center gap-4">
				<div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-kumo-fill">
					<Users size={20} aria-hidden className="text-kumo-subtle" />
				</div>
				<div className="min-w-0 space-y-1">
					{display.visible.length > 0 ? (
						<div className="flex flex-wrap gap-1.5">
							{display.visible.map((type) => (
								<Badge key={type.value} variant="secondary">
									{type.label}
								</Badge>
							))}
						</div>
					) : (
						<Text as="p" role="body" weight="medium" className="m-0">
							{display.hiddenCount > 0
								? "Only legacy caller IDs"
								: "No caller auth types"}
						</Text>
					)}
					<div className="flex flex-wrap items-center gap-1.5 text-kumo-subtle text-xs">
						<span>Caller auth types</span>
						{display.hiddenCount > 0 && (
							<Badge variant="outline" className="font-normal">
								{display.hiddenCount} legacy id
								{display.hiddenCount === 1 ? "" : "s"} hidden
							</Badge>
						)}
					</div>
				</div>
			</CardContent>
		</Card>
	);
}

// =============================================================================
// Event volume table (the deferred chart's dataset, as plain markup)
// =============================================================================

function EventVolumeTable({ buckets }: { buckets: AppTimeSeries["buckets"] }) {
	const maxTotal = Math.max(
		...buckets.map((bucket) => bucket.successEvents + bucket.failedEvents),
		1,
	);

	return (
		<Card>
			<CardHeader className="flex flex-row items-center justify-between">
				<CardTitle className="flex flex-wrap items-center gap-2">
					<Pulse size={16} aria-hidden />
					Event Volume
					<Badge variant="outline" className="font-normal">
						daily
					</Badge>
				</CardTitle>
				<div className="flex items-center gap-3 text-kumo-subtle text-xs">
					<span className="flex items-center gap-1">
						<span className="inline-block h-2 w-2 rounded-full bg-kumo-success" />
						Success
					</span>
					<span className="flex items-center gap-1">
						<span className="inline-block h-2 w-2 rounded-full bg-kumo-danger" />
						Failed
					</span>
				</div>
			</CardHeader>
			<CardContent className="px-0">
				<Table scrollLabel="Daily event volume">
					<TableHeader>
						<TableRow>
							<TableHead>Day</TableHead>
							<TableHead className="w-40">Volume</TableHead>
							<TableHead className="text-right">Success</TableHead>
							<TableHead className="text-right">Failed</TableHead>
							<TableHead className="text-right">Total</TableHead>
						</TableRow>
					</TableHeader>
					<TableBody>
						{buckets.map((bucket) => {
							const total = bucket.successEvents + bucket.failedEvents;
							return (
								<TableRow key={bucket.bucket}>
									<TableCell className="font-mono">
										{formatBucketLabel(bucket.bucket)}
									</TableCell>
									<TableCell>
										<div
											aria-hidden
											className="flex h-1.5 w-full max-w-36 overflow-hidden rounded-full bg-kumo-fill"
										>
											<span
												className="h-full bg-kumo-success"
												style={{
													width: `${(bucket.successEvents / maxTotal) * 100}%`,
												}}
											/>
											<span
												className="h-full bg-kumo-danger"
												style={{
													width: `${(bucket.failedEvents / maxTotal) * 100}%`,
												}}
											/>
										</div>
									</TableCell>
									<TableCell className="text-right text-kumo-success tabular-nums">
										{bucket.successEvents.toLocaleString()}
									</TableCell>
									<TableCell className="text-right tabular-nums">
										{bucket.failedEvents > 0 ? (
											<Text as="span" role="body" tone="error">
												{bucket.failedEvents.toLocaleString()}
											</Text>
										) : (
											<Text as="span" role="body" tone="secondary">
												0
											</Text>
										)}
									</TableCell>
									<TableCell className="text-right tabular-nums">
										{total.toLocaleString()}
									</TableCell>
								</TableRow>
							);
						})}
					</TableBody>
				</Table>
			</CardContent>
		</Card>
	);
}

// =============================================================================
// Components
// =============================================================================

function AnalyticsHeader() {
	return (
		<div className="flex flex-wrap items-center gap-2">
			<Text as="h2" role="dialog" weight="semibold" className="m-0">
				Analytics
			</Text>
			<Badge variant="outline" className="font-normal">
				Last 30 days · live window
			</Badge>
			<Text
				as="p"
				role="body"
				tone="secondary"
				className="m-0 flex basis-full items-center gap-1"
			>
				<Info size={14} aria-hidden />
				Usage metrics from MCP tool interactions (Analytics Engine)
			</Text>
		</div>
	);
}

function ActivityFreshnessStrip({
	freshness,
}: {
	freshness: AppActivityFreshness;
}) {
	const latest = freshness.latestAuditEvent;
	const current = freshness.currentWindow;
	const hasCurrentWindow = current.totalEvents > 0;

	return (
		<Card>
			<CardContent>
				<div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
					<div className="space-y-1">
						<div className="flex flex-wrap items-center gap-2">
							<Badge
								variant={hasCurrentWindow ? "default" : "outline"}
								className="font-normal"
							>
								Audit trail
							</Badge>
							<Text as="p" role="body" weight="medium" className="m-0">
								{latest
									? `Latest ${formatAuditAction(latest.action)} ${formatTimestamp(latest.timestamp)}`
									: "No audit event found"}
							</Text>
						</div>
						<Text as="p" role="label" tone="secondary" className="m-0">
							Current UTC hour: {formatCurrentWindow(current)}
						</Text>
					</div>
					<MetricGrid
						aria-label="Current-hour activity"
						columns={4}
						className="w-full lg:min-w-[520px]"
					>
						<MetricItem
							label="Events"
							value={current.totalEvents.toLocaleString()}
						/>
						<MetricItem
							label="Code execs"
							value={current.codeExecutions.toLocaleString()}
						/>
						<MetricItem
							label="Tool calls"
							value={current.toolExecutions.toLocaleString()}
						/>
						<MetricItem
							label="Errors"
							value={current.toolErrors.toLocaleString()}
						/>
					</MetricGrid>
				</div>
				{latest?.executionId && (
					<div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 border-kumo-line border-t pt-3 text-kumo-subtle text-xs">
						<span>
							exec{" "}
							<Text
								as="span"
								role="label"
								tone="mono"
								className="text-kumo-default"
							>
								{latest.executionId.slice(0, 8)}…
							</Text>
						</span>
						{latest.traceId && (
							<span>
								trace{" "}
								<Text
									as="span"
									role="label"
									tone="mono"
									className="text-kumo-default"
								>
									{latest.traceId.slice(0, 8)}…
								</Text>
							</span>
						)}
						{latest.durationMs != null && (
							<span>{formatDuration(latest.durationMs)}</span>
						)}
						{latest.toolCount != null && (
							<span>{latest.toolCount.toLocaleString()} tools</span>
						)}
						{latest.namespaceCount != null && (
							<span>{latest.namespaceCount.toLocaleString()} namespaces</span>
						)}
					</div>
				)}
			</CardContent>
		</Card>
	);
}

function MetricCard({
	title,
	description,
	value,
	change,
	icon,
}: {
	title: string;
	description: string;
	value: string;
	change?: number;
	icon: React.ReactNode;
}) {
	return (
		<Card>
			<CardContent>
				<div className="flex items-center justify-between">
					<Text
						as="p"
						role="body"
						tone="secondary"
						weight="medium"
						className="m-0"
					>
						{title}
					</Text>
					{icon}
				</div>
				<div className="mt-2 flex items-baseline gap-2">
					<Text
						as="p"
						role="metric"
						weight="semibold"
						className="m-0 tabular-nums"
					>
						{value}
					</Text>
					{change != null && change !== 0 && (
						<Badge
							variant={change > 0 ? "success" : "destructive"}
							className="gap-0.5"
						>
							{change > 0 ? (
								<ArrowUp size={12} aria-hidden />
							) : (
								<ArrowDown size={12} aria-hidden />
							)}
							{Math.abs(Math.round(change))}%
							<Text as="span" className="ml-1 opacity-70" role="caption">
								vs prior
							</Text>
						</Badge>
					)}
				</div>
				<Text as="p" role="label" tone="secondary" className="mt-1.5 mb-0">
					{description}
				</Text>
			</CardContent>
		</Card>
	);
}

// =============================================================================
// Tool Breakdown Table
// =============================================================================

function ToolBreakdownTable({ tools }: { tools: AppToolBreakdown["tools"] }) {
	const maxCalls = Math.max(...tools.map((tool) => tool.totalCalls), 1);

	return (
		<TooltipProvider>
			<Collection
				aria-label="Tool performance records"
				className="lg:hidden [&>li]:px-3 [&>li]:py-3"
			>
				{tools.map((tool) => (
					<ToolRecord key={tool.toolName} tool={tool} />
				))}
			</Collection>
			<div className="hidden lg:block">
				<Table scrollLabel="Tool performance breakdown">
					<TableHeader>
						<TableRow>
							<TableHead>Tool</TableHead>
							<TableHead className="text-right">Calls</TableHead>
							<TableHead className="text-right">Success</TableHead>
							<TableHead className="text-right">Failed</TableHead>
							<TableHead className="w-32">Success Rate</TableHead>
							<TableHead className="text-right">Avg Latency</TableHead>
							<TableHead className="text-right">Max Latency</TableHead>
							<TableHead className="text-right">Avg I/O</TableHead>
						</TableRow>
					</TableHeader>
					<TableBody>
						{tools.map((tool) => (
							<ToolRow key={tool.toolName} tool={tool} maxCalls={maxCalls} />
						))}
					</TableBody>
				</Table>
			</div>
		</TooltipProvider>
	);
}

function ToolRecord({ tool }: { tool: AppToolBreakdown["tools"][number] }) {
	return (
		<li>
			<div className="flex min-w-0 items-start justify-between gap-3">
				<Text as="span" role="label" tone="mono" className="min-w-0 break-all">
					{tool.toolName}
				</Text>
				<Text
					as="span"
					role="label"
					tone="secondary"
					className="shrink-0 tabular-nums"
				>
					{tool.totalCalls.toLocaleString()} calls
				</Text>
			</div>
			<div className="mt-3 flex items-center gap-3">
				<Progress value={tool.successRate} className="h-2" />
				<Text
					as="span"
					role="label"
					className="w-12 shrink-0 text-right tabular-nums"
				>
					{tool.successRate}%
				</Text>
			</div>
			<dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-4">
				<ToolRecordMetric
					label="Succeeded"
					value={tool.successCalls.toLocaleString()}
					valueClassName="text-kumo-success"
				/>
				<ToolRecordMetric
					label="Failed"
					value={tool.failedCalls.toLocaleString()}
					valueClassName={tool.failedCalls > 0 ? "text-kumo-danger" : undefined}
				/>
				<ToolRecordMetric
					label="Avg latency"
					value={formatDuration(tool.avgDurationMs)}
				/>
				<ToolRecordMetric
					label="Max latency"
					value={formatDuration(tool.maxDurationMs)}
					valueClassName={
						tool.maxDurationMs > 5000 ? "text-kumo-warning" : undefined
					}
				/>
				<ToolRecordMetric
					label="Avg input / output"
					value={`${formatBytes(tool.avgInputBytes)} / ${formatBytes(tool.avgOutputBytes)}`}
					className="col-span-2 sm:col-span-4"
				/>
			</dl>
		</li>
	);
}

function ToolRecordMetric({
	label,
	value,
	className,
	valueClassName,
}: {
	label: string;
	value: string;
	className?: string;
	valueClassName?: string;
}) {
	return (
		<div className={className}>
			<dt>
				<Text as="span" role="caption" tone="secondary">
					{label}
				</Text>
			</dt>
			<dd className="m-0 mt-0.5">
				<Text
					as="span"
					role="label"
					className={["tabular-nums", valueClassName].filter(Boolean).join(" ")}
				>
					{value}
				</Text>
			</dd>
		</div>
	);
}

function ToolRow({
	tool,
	maxCalls,
}: {
	tool: AppToolBreakdown["tools"][number];
	maxCalls: number;
}) {
	return (
		<TableRow>
			<TableCell>
				<Text as="span" role="label" tone="mono">
					{tool.toolName}
				</Text>
			</TableCell>
			<TableCell className="text-right">
				<div className="flex items-center justify-end gap-2">
					<div className="h-1.5 w-16 overflow-hidden rounded-full bg-kumo-fill">
						<div
							className="h-full rounded-full bg-kumo-brand"
							style={{ width: `${(tool.totalCalls / maxCalls) * 100}%` }}
						/>
					</div>
					<span className="tabular-nums">
						{tool.totalCalls.toLocaleString()}
					</span>
				</div>
			</TableCell>
			<TableCell className="text-right text-kumo-success tabular-nums">
				{tool.successCalls.toLocaleString()}
			</TableCell>
			<TableCell className="text-right tabular-nums">
				{tool.failedCalls > 0 ? (
					<Text as="span" role="body" tone="error">
						{tool.failedCalls.toLocaleString()}
					</Text>
				) : (
					<Text as="span" role="body" tone="secondary">
						0
					</Text>
				)}
			</TableCell>
			<TableCell>
				<Tooltip>
					<TooltipTrigger
						render={
							<div className="flex items-center gap-2">
								<Progress value={tool.successRate} className="h-2" />
								<Text
									as="span"
									role="label"
									className="w-12 text-right tabular-nums"
								>
									{tool.successRate}%
								</Text>
							</div>
						}
					/>
					<TooltipContent>
						{tool.successCalls} succeeded / {tool.failedCalls} failed
					</TooltipContent>
				</Tooltip>
			</TableCell>
			<TableCell className="text-right">
				<Tooltip>
					<TooltipTrigger
						render={
							<span className="tabular-nums">
								{formatDuration(tool.avgDurationMs)}
							</span>
						}
					/>
					<TooltipContent>{tool.avgDurationMs}ms</TooltipContent>
				</Tooltip>
			</TableCell>
			<TableCell className="text-right">
				<Tooltip>
					<TooltipTrigger
						render={
							<Text
								as="span"
								role="body"
								tone={tool.maxDurationMs > 5000 ? "warning" : "default"}
								className="tabular-nums"
							>
								{formatDuration(tool.maxDurationMs)}
							</Text>
						}
					/>
					<TooltipContent>max: {tool.maxDurationMs}ms</TooltipContent>
				</Tooltip>
			</TableCell>
			<TableCell className="text-right text-kumo-subtle tabular-nums">
				<Tooltip>
					<TooltipTrigger
						render={
							<Text as="span" role="label">
								{formatBytes(tool.avgInputBytes)} /{" "}
								{formatBytes(tool.avgOutputBytes)}
							</Text>
						}
					/>
					<TooltipContent>
						avg request {formatBytes(tool.avgInputBytes)} · avg response{" "}
						{formatBytes(tool.avgOutputBytes)}
					</TooltipContent>
				</Tooltip>
			</TableCell>
		</TableRow>
	);
}

// =============================================================================
// Code Mode Analytics (Analytics Engine — codemode rpc/exec events)
// =============================================================================

function CodeModeStatTile({ label, value }: { label: string; value: string }) {
	return (
		<Card size="sm">
			<CardContent>
				<Text
					as="p"
					role="label"
					tone="secondary"
					weight="medium"
					className="m-0"
				>
					{label}
				</Text>
				<Text as="p" role="metric" weight="semibold" className="mt-1.5 mb-0">
					{value}
				</Text>
			</CardContent>
		</Card>
	);
}

function CodeModeBreakdownTable({
	rows,
	kind,
}: {
	rows: CodeModeRow[];
	kind: "tool" | "namespace";
}) {
	const maxCalls = Math.max(...rows.map((row) => row.totalCalls), 1);
	return (
		<TooltipProvider>
			<Table
				scrollLabel={`${kind === "tool" ? "Tool" : "Namespace"} activity breakdown`}
			>
				<TableHeader>
					<TableRow>
						<TableHead>{kind === "tool" ? "Tool" : "Namespace"}</TableHead>
						<TableHead className="text-right">Calls</TableHead>
						<TableHead className="w-32">Success Rate</TableHead>
						<TableHead className="text-right">Avg Latency</TableHead>
						{kind === "tool" && (
							<TableHead className="text-right">p50</TableHead>
						)}
					</TableRow>
				</TableHeader>
				<TableBody>
					{rows.map((row) => {
						const name = "toolName" in row ? row.toolName : row.namespace;
						return (
							<TableRow key={name}>
								<TableCell>
									<Text as="span" role="label" tone="mono">
										{name}
									</Text>
								</TableCell>
								<TableCell className="text-right">
									<div className="flex items-center justify-end gap-2">
										<div className="h-1.5 w-16 overflow-hidden rounded-full bg-kumo-fill">
											<div
												className="h-full rounded-full bg-kumo-brand"
												style={{
													width: `${(row.totalCalls / maxCalls) * 100}%`,
												}}
											/>
										</div>
										<span className="tabular-nums">
											{row.totalCalls.toLocaleString()}
										</span>
									</div>
								</TableCell>
								<TableCell>
									<Tooltip>
										<TooltipTrigger
											render={
												<div className="flex items-center gap-2">
													<Progress value={row.successRate} className="h-2" />
													<Text
														as="span"
														role="label"
														className="w-12 text-right tabular-nums"
													>
														{row.successRate}%
													</Text>
												</div>
											}
										/>
										<TooltipContent>
											{row.successCalls} succeeded / {row.failedCalls} failed
										</TooltipContent>
									</Tooltip>
								</TableCell>
								<TableCell className="text-right tabular-nums">
									{formatDuration(row.avgDurationMs)}
								</TableCell>
								{kind === "tool" && "p50DurationMs" in row && (
									<TableCell className="text-right tabular-nums">
										{formatDuration(row.p50DurationMs)}
									</TableCell>
								)}
							</TableRow>
						);
					})}
				</TableBody>
			</Table>
		</TooltipProvider>
	);
}

function CodeModeAnalyticsSection({ summary }: { summary: CodemodeSummary }) {
	const { execSummary: ex, byNamespace, topTools } = summary;
	return (
		<Card>
			<CardHeader>
				<CardTitle className="flex items-center gap-2">
					<Code size={16} aria-hidden />
					Code Mode
					<Badge variant="outline" className="ml-1 font-normal">
						{ex.totalExecs.toLocaleString()} execs
					</Badge>
				</CardTitle>
			</CardHeader>
			<CardContent className="space-y-6 px-0">
				<div className="grid grid-cols-2 gap-4 px-4 sm:grid-cols-4">
					<CodeModeStatTile
						label="Executions"
						value={ex.totalExecs.toLocaleString()}
					/>
					<CodeModeStatTile
						label="Exec Success"
						value={`${ex.successRate.toFixed(1)}%`}
					/>
					<CodeModeStatTile
						label="Avg Tools/Exec"
						value={ex.avgToolCount.toFixed(1)}
					/>
					<CodeModeStatTile
						label="Avg Namespaces"
						value={ex.avgNamespaceCount.toFixed(1)}
					/>
				</div>
				{byNamespace.length > 0 && (
					<div>
						<Text
							as="p"
							role="label"
							tone="secondary"
							weight="medium"
							className="m-0 px-4 pb-2"
						>
							By namespace
						</Text>
						<CodeModeBreakdownTable rows={byNamespace} kind="namespace" />
					</div>
				)}
				{topTools.length > 0 && (
					<div>
						<Text
							as="p"
							role="label"
							tone="secondary"
							weight="medium"
							className="m-0 px-4 pb-2"
						>
							Top tools
						</Text>
						<CodeModeBreakdownTable rows={topTools} kind="tool" />
					</div>
				)}
			</CardContent>
		</Card>
	);
}

// =============================================================================
// Recent Executions
// =============================================================================

function RecentExecutionsSection({
	executions,
}: {
	executions: RecentExecutions["executions"];
}) {
	const [expandedId, setExpandedId] = useState<string | null>(null);

	return (
		<Card>
			<CardHeader>
				<CardTitle className="flex items-center gap-2">
					<Code size={16} aria-hidden />
					Recent Code Executions
					<Badge variant="outline" className="ml-1 font-normal">
						{executions.length} executions
					</Badge>
				</CardTitle>
			</CardHeader>
			<CardContent className="px-0">
				<Table scrollLabel="Recent code mode executions">
					<TableHeader>
						<TableRow>
							<TableHead className="w-8" />
							<TableHead>Execution ID</TableHead>
							<TableHead className="text-right">Status</TableHead>
							<TableHead className="text-right">Tools</TableHead>
							<TableHead className="text-right">Duration</TableHead>
							<TableHead className="text-right">Time</TableHead>
						</TableRow>
					</TableHeader>
					<TableBody>
						{executions.map((exec) => (
							<ExecutionRow
								key={exec.executionId}
								execution={exec}
								isExpanded={expandedId === exec.executionId}
								onToggle={() =>
									setExpandedId(
										expandedId === exec.executionId ? null : exec.executionId,
									)
								}
							/>
						))}
					</TableBody>
				</Table>
			</CardContent>
		</Card>
	);
}

function ExecutionRow({
	execution,
	isExpanded,
	onToggle,
}: {
	execution: RecentExecutions["executions"][number];
	isExpanded: boolean;
	onToggle: () => void;
}) {
	const detailsId = useId();

	return (
		<>
			<TableRow>
				<TableCell className="w-8 px-3">
					<Button
						type="button"
						variant="ghost"
						size="icon-sm"
						aria-label={`${isExpanded ? "Collapse" : "Expand"} execution ${execution.executionId}`}
						aria-expanded={isExpanded}
						aria-controls={detailsId}
						onClick={onToggle}
						className="text-kumo-subtle"
						icon={
							<CaretRight
								aria-hidden
								size={16}
								className={`transition-transform ${isExpanded ? "rotate-90" : ""}`}
							/>
						}
					/>
				</TableCell>
				<TableCell>
					<Text as="span" role="label" tone="mono">
						{execution.executionId.slice(0, 8)}…
					</Text>
				</TableCell>
				<TableCell className="text-right">
					<Badge variant={execution.success ? "success" : "destructive"}>
						{execution.success ? "OK" : "Error"}
					</Badge>
				</TableCell>
				<TableCell className="text-right tabular-nums">
					{execution.toolCount}
				</TableCell>
				<TableCell className="text-right tabular-nums">
					{formatDuration(execution.durationMs)}
				</TableCell>
				<TableCell className="text-right text-kumo-subtle">
					{formatTimestamp(execution.timestamp)}
				</TableCell>
			</TableRow>
			{isExpanded && (
				<TableRow id={detailsId}>
					<TableCell colSpan={6} className="bg-kumo-fill p-0">
						<ExecutionDrilldownPanel executionId={execution.executionId} />
					</TableCell>
				</TableRow>
			)}
		</>
	);
}

// =============================================================================
// Execution Drill-Down
// =============================================================================

function ExecutionDrilldownPanel({ executionId }: { executionId: string }) {
	const { data, isPending, isError } = useQuery({
		...executionDrilldownQueryOptions(executionId),
		staleTime: 300_000,
	});

	if (isPending) {
		return (
			<div className="px-4 py-3">
				<Skeleton className="h-16" />
			</div>
		);
	}

	if (isError) {
		return (
			<p role="alert" className="m-0 px-4 py-3 text-kumo-danger text-xs">
				Execution details could not be loaded.
			</p>
		);
	}

	if (!data.execution && data.toolCalls.length === 0) {
		return (
			<div className="px-4 py-3 text-kumo-subtle text-xs">
				No data found for this execution.
			</div>
		);
	}

	return (
		<div className="space-y-2 px-4 py-3">
			{(data.actor || data.clientId || data.source === "analytics_engine") && (
				<div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-kumo-subtle text-tedix-caption">
					{data.attribution ? (
						<span title={data.attribution.actor.id}>
							by{" "}
							<Text as="span" role="caption" tone="default">
								{data.attribution.summary}
							</Text>
						</span>
					) : data.actor ? (
						<span>
							by{" "}
							<Text
								as="span"
								role="caption"
								tone="mono"
								className="text-kumo-default"
							>
								{data.actor.actorType}:{data.actor.actorId}
							</Text>
						</span>
					) : null}
					{data.identityCoverage?.warnings.length ? (
						<span title={coverageTitle(data.identityCoverage)}>
							{coverageLabel(data.identityCoverage)}
						</span>
					) : null}
					{data.clientId && (
						<span>
							via{" "}
							<Text as="span" role="caption" tone="mono">
								{data.clientId}
							</Text>
						</span>
					)}
					{data.traceId && (
						<Text as="span" role="caption" tone="mono" className="opacity-70">
							trace {data.traceId}
						</Text>
					)}
					{data.source === "analytics_engine" && (
						<Badge variant="outline">sampled (no actor)</Badge>
					)}
				</div>
			)}
			{data.execution && (
				<div className="flex min-w-0 items-center gap-3 rounded-md bg-kumo-tint px-3 py-2 text-xs">
					<Code size={14} aria-hidden className="shrink-0 text-kumo-subtle" />
					<Text
						as="span"
						role="label"
						tone="mono"
						className="min-w-0 flex-1 truncate"
					>
						{data.execution.toolName}
					</Text>
					<Badge
						variant={data.execution.success ? "success" : "destructive"}
						className="shrink-0"
					>
						{data.execution.success ? "OK" : "Error"}
					</Badge>
					<Text
						as="span"
						role="label"
						tone="secondary"
						className="shrink-0 tabular-nums"
					>
						{formatDuration(data.execution.durationMs)}
					</Text>
				</div>
			)}
			{data.toolCalls.length > 0 && (
				<div className="space-y-1 border-kumo-line border-l-2 pl-4">
					{data.toolCalls.map((call, index) => (
						<ToolCallPayloadRow
							key={`${call.toolName}-${call.timestamp}-${index}`}
							executionId={executionId}
							toolName={call.toolName}
							success={call.success}
							durationMs={call.durationMs}
						/>
					))}
				</div>
			)}
		</div>
	);
}

// =============================================================================
// Recent Activity (audit-backed "who") + per-trace cross-lane drilldown
// =============================================================================

function principalTitle(principal: PrincipalDescriptor | null): string {
	if (!principal) return "Unknown";
	const secondary = principal.secondary ? ` · ${principal.secondary}` : "";
	return `${principal.type}:${principal.id}${secondary}`;
}

function PrincipalName({
	principal,
	muted = false,
}: {
	principal: PrincipalDescriptor | null;
	muted?: boolean;
}) {
	if (!principal) {
		return (
			<Text as="span" role="label" tone="secondary">
				Unknown
			</Text>
		);
	}
	return (
		<Text
			as="span"
			role="label"
			tone={muted ? "secondary" : "default"}
			title={principalTitle(principal)}
		>
			{principal.label}
		</Text>
	);
}

function coverageLabel(coverage: IdentityCoverage): string | null {
	if (coverage.warnings.length === 0) return null;
	const warningDetails = coverageWarningDetails(coverage);
	return warningDetails.map((warning) => warning.label).join(", ");
}

function coverageWarningDetails(coverage: IdentityCoverage) {
	if (coverage.warningDetails.length > 0) return coverage.warningDetails;
	const fallbackLabels: Record<string, string> = {
		actor_unresolved: "actor unresolved",
		subject_missing: "no human subject",
		subject_unresolved: "subject unresolved",
		agent_unresolved: "agent unresolved",
		app_unresolved: "app unresolved",
		tool_unresolved: "tool unresolved",
	};
	return coverage.warnings.map((warning) => ({
		code: warning,
		label: fallbackLabels[warning] ?? warning,
		severity: "warning" as const,
		message: warning,
		recommendedAction: null,
	}));
}

function coverageTitle(coverage: IdentityCoverage): string {
	return coverageWarningDetails(coverage)
		.map((warning) =>
			[
				warning.label,
				warning.message,
				warning.recommendedAction
					? `Action: ${warning.recommendedAction}`
					: null,
			]
				.filter(Boolean)
				.join("\n"),
		)
		.join("\n\n");
}

function formatActivityTime(iso: string): string {
	const d = new Date(iso);
	return Number.isNaN(d.getTime())
		? iso
		: d.toLocaleString(undefined, {
				month: "short",
				day: "numeric",
				hour: "2-digit",
				minute: "2-digit",
			});
}

function formatPercent(value: number): string {
	return `${Math.round(value * 100)}%`;
}

function formatNullablePercent(value: number | null): string {
	return value == null ? "n/a" : formatPercent(value);
}

function formatDurationOrNa(value: number | null): string {
	if (value == null) return "n/a";
	if (value < 1000) return `${Math.round(value)}ms`;
	const minutes = Math.floor(value / 60000);
	const seconds = Math.round((value % 60000) / 1000);
	if (minutes === 0) return `${seconds}s`;
	return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
}

function HumanActivityReviewSection({
	review,
}: {
	review: HumanActivityReview;
}) {
	const warningText = review.coverage.warnings.length
		? `${review.coverage.warnings.length} coverage flag(s)`
		: "fully hydrated";
	const traceCoverage = review.coverage.traceEvidence;
	const traceFreshness = review.coverage.traceFreshness;
	const securityPosture = review.coverage.securityPosture;
	const traceCoverageTitle = [
		`${traceCoverage.proofLinkedGroups}/${review.coverage.totalGroups} episodes have at least MCP-level trace proof`,
		`${traceCoverage.auditOnlyGroups} audit-only`,
		`${traceCoverage.missingTraceGroups} missing trace`,
		traceCoverage.warnings.length
			? `warnings: ${traceCoverage.warnings.join(", ")}`
			: null,
	]
		.filter(Boolean)
		.join(" · ");
	const traceFreshnessTitle = [
		`${traceFreshness.freshGroups}/${traceFreshness.proofGroups} proof-linked episodes arrived within ${formatDurationOrNa(traceFreshness.targetMaxLagMs)}`,
		traceFreshness.staleGroups ? `${traceFreshness.staleGroups} stale` : null,
		traceFreshness.missingProofTimestampGroups
			? `${traceFreshness.missingProofTimestampGroups} missing proof timestamp`
			: null,
		traceFreshness.maxLagMs != null
			? `max lag ${formatDurationOrNa(traceFreshness.maxLagMs)}`
			: null,
		traceFreshness.warnings.length
			? `warnings: ${traceFreshness.warnings.join(", ")}`
			: null,
	]
		.filter(Boolean)
		.join(" · ");
	return (
		<Card>
			<CardHeader>
				<CardTitle className="flex flex-wrap items-center gap-2">
					Activity Review
					<Badge variant="outline" className="ml-1 font-normal">
						{review.groups.length} episodes
					</Badge>
					<Badge variant="secondary" className="font-normal">
						{warningText}
					</Badge>
					<Badge
						variant={
							securityPosture.deniedEvents > 0 ? "destructive" : "outline"
						}
						className="font-normal"
						title={
							securityPosture.denialReasons.length > 0
								? `Denied: ${securityPosture.denialReasons.join(", ")}`
								: "No pre-dispatch MCP denials in this window"
						}
					>
						{securityPosture.deniedEvents} denied
					</Badge>
					<Badge
						variant={traceEvidenceCoverageVariant(traceCoverage.status)}
						className="font-normal"
						title={traceCoverageTitle}
					>
						trace proof {formatPercent(traceCoverage.proofCoverageRate)}
					</Badge>
					<Badge
						variant={traceFreshnessCoverageVariant(traceFreshness.status)}
						className="font-normal"
						title={traceFreshnessTitle}
					>
						fresh proof {formatPercent(traceFreshness.freshnessRate)}
					</Badge>
				</CardTitle>
			</CardHeader>
			<CardContent className="px-0">
				<div className="space-y-3 border-kumo-line border-t px-4 py-3">
					<div>
						<div className="mb-2 flex items-center justify-between gap-3 text-xs">
							<Text as="span" role="label" tone="secondary">
								Trace proof target{" "}
								{formatPercent(traceCoverage.targetCoverageRate)}
							</Text>
							<Text
								as="span"
								role="label"
								tone="secondary"
								className="tabular-nums"
								title={traceCoverageTitle}
							>
								{traceEvidenceCoverageLabel(traceCoverage)}
							</Text>
						</div>
						<Progress
							value={Math.round(traceCoverage.proofCoverageRate * 100)}
							className="h-2"
						/>
					</div>
					<div>
						<div className="mb-2 flex items-center justify-between gap-3 text-xs">
							<Text as="span" role="label" tone="secondary">
								Trace proof freshness target {"<= "}
								{formatDurationOrNa(traceFreshness.targetMaxLagMs)}
							</Text>
							<Text
								as="span"
								role="label"
								tone="secondary"
								className="tabular-nums"
								title={traceFreshnessTitle}
							>
								{traceFreshnessCoverageLabel(traceFreshness)}
							</Text>
						</div>
						<Progress
							value={Math.round(traceFreshness.freshnessRate * 100)}
							className="h-2"
						/>
					</div>
				</div>
				<Collection appearance="inline" aria-label="Activity review episodes">
					{review.groups.slice(0, 8).map((group) => (
						<ActivityReviewRow key={group.id} group={group} />
					))}
				</Collection>
			</CardContent>
		</Card>
	);
}

function traceEvidenceCoverageVariant(
	status: HumanActivityReview["coverage"]["traceEvidence"]["status"],
): BadgeVariant {
	switch (status) {
		case "met":
			return "default";
		case "warning":
			return "secondary";
		case "breach":
			return "destructive";
		case "no_data":
			return "outline";
	}
}

function traceFreshnessCoverageVariant(
	status: HumanActivityReview["coverage"]["traceFreshness"]["status"],
): BadgeVariant {
	switch (status) {
		case "met":
			return "default";
		case "warning":
			return "secondary";
		case "breach":
			return "destructive";
		case "no_data":
			return "outline";
	}
}

function traceEvidenceCoverageLabel(
	coverage: HumanActivityReview["coverage"]["traceEvidence"],
) {
	if (coverage.status === "no_data") return "no activity in window";
	return `${coverage.proofLinkedGroups}/${coverage.proofLinkedGroups + coverage.auditOnlyGroups + coverage.missingTraceGroups} episodes linked`;
}

function traceFreshnessCoverageLabel(
	coverage: HumanActivityReview["coverage"]["traceFreshness"],
) {
	if (coverage.status === "no_data") return "no proof-linked episodes";
	return `${coverage.freshGroups}/${coverage.proofGroups} fresh`;
}

function ActivityReviewRow({ group }: { group: ActivityReviewGroup }) {
	const warning = coverageLabel(group.identityCoverage);
	const traceProof = traceEvidenceLabel(group.traceEvidence.status);
	const cognition = group.traceEvidence.cognition;
	const showCognition = cognition.summary !== "No cognitive evidence linked.";
	const denied = group.securityPosture.deniedEvents > 0;
	return (
		<li className="space-y-2 px-4 py-3 text-xs">
			<div className="flex flex-wrap items-center gap-2">
				<Text as="span" role="label" weight="medium">
					{group.title}
				</Text>
				<Badge
					variant={denied || group.errorEvents > 0 ? "destructive" : "default"}
				>
					{denied
						? `${group.securityPosture.deniedEvents} denied`
						: group.errorEvents > 0
							? `${group.errorEvents} error`
							: "OK"}
				</Badge>
				{group.securityPosture.denialReasons.map((reason) => (
					<Badge
						key={reason}
						variant="outline"
						className="font-normal"
						title={[
							...group.securityPosture.mcpMethods,
							...group.securityPosture.riskTiers,
						].join(" · ")}
					>
						{reason.replaceAll("_", " ")}
					</Badge>
				))}
				<Text
					as="span"
					role="label"
					tone="secondary"
					className="ml-auto tabular-nums"
				>
					{formatActivityTime(group.endedAt)}
				</Text>
			</div>
			<div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-kumo-subtle">
				<PrincipalName principal={group.subject ?? group.actor} muted />
				{group.agent && (
					<>
						<span>-&gt;</span>
						<PrincipalName principal={group.agent} muted />
					</>
				)}
				<span>·</span>
				<span>{group.totalEvents} audit events</span>
				<span>·</span>
				<span>
					{group.evidence.payloadsConfigured
						? "payload lane on"
						: "payload lane off"}
				</span>
				<span>·</span>
				<span
					title={[
						...group.traceEvidence.warnings,
						...(group.traceEvidence.cloudflare.sampled
							? [
									`Cloudflare trace ${group.traceEvidence.cloudflare.traceId}; ${group.traceEvidence.cloudflare.serviceNames.join(", ")}`,
								]
							: []),
					].join(", ")}
				>
					{traceProof}
					{group.traceEvidence.mcpEvents > 0
						? ` · ${group.traceEvidence.mcpEvents} mcp`
						: ""}
					{group.traceEvidence.cognitiveEvents > 0
						? ` · ${group.traceEvidence.cognitiveEvents} cognitive`
						: ""}
					{group.traceEvidence.cloudflare.sampled
						? ` · ${group.traceEvidence.cloudflare.spanCount} CF spans`
						: ""}
				</span>
				{warning && (
					<>
						<span>·</span>
						<span title={coverageTitle(group.identityCoverage)}>{warning}</span>
					</>
				)}
			</div>
			{showCognition && (
				<div
					className="flex flex-wrap items-center gap-x-2 gap-y-1 text-kumo-subtle"
					title={cognitionEvidenceTitle(cognition)}
				>
					<Lightbulb size={14} aria-hidden className="text-kumo-link" />
					<span>{cognition.summary}</span>
				</div>
			)}
			{group.topTools.length > 0 && (
				<div className="flex flex-wrap gap-1.5">
					{group.topTools.map((tool) => (
						<Badge
							key={tool.tool.toolName}
							variant="outline"
							className="font-normal"
							title={tool.tool.toolName}
						>
							{tool.tool.label} x{tool.count}
						</Badge>
					))}
				</div>
			)}
		</li>
	);
}

function cognitionEvidenceTitle(
	cognition: ActivityReviewGroup["traceEvidence"]["cognition"],
) {
	const parts = [
		formatEvidenceIdSummary("Retrieved facts", cognition.retrievedFactIds),
		formatEvidenceIdSummary("Cited facts", cognition.citedFactIds),
		formatEvidenceIdSummary("Ignored facts", cognition.ignoredFactIds),
		formatEvidenceIdSummary("Decisions", cognition.decisionIds),
		latestDecisionTitle(cognition.latestDecision),
		retrievalEvidenceTitle(cognition.retrieval),
		graphEvidenceTitle(cognition.graph),
		cognition.warnings.length
			? `Warnings: ${cognition.warnings.join(", ")}`
			: null,
	];
	return parts.filter(Boolean).join("\n");
}

function formatEvidenceIdSummary(label: string, ids: string[]): string {
	if (ids.length === 0) return `${label}: none`;
	const preview = ids.slice(0, 4).map(shortEvidenceId).join(", ");
	const more = ids.length > 4 ? `, +${ids.length - 4} more` : "";
	return `${label}: ${ids.length} (${preview}${more})`;
}

function shortEvidenceId(value: string): string {
	const trimmed = value.trim();
	if (!trimmed) return "blank";
	if (trimmed.length <= 18 && !UUID_LIKE.test(trimmed)) return trimmed;
	return `${trimmed.slice(0, 8)}...${trimmed.slice(-4)}`;
}

function latestDecisionTitle(
	decision: ActivityReviewGroup["traceEvidence"]["cognition"]["latestDecision"],
): string {
	if (!decision) return "Latest decision: none";
	const confidence =
		decision.confidence == null
			? null
			: `confidence ${formatPercent(decision.confidence)}`;
	const status = decision.outcomeStatus ?? "pending";
	return [
		`Latest decision: ${shortEvidenceId(decision.id)}`,
		decision.category,
		status,
		confidence,
		decision.source,
	]
		.filter(Boolean)
		.join(" · ");
}

function retrievalEvidenceTitle(
	retrieval: ActivityReviewGroup["traceEvidence"]["cognition"]["retrieval"],
): string {
	const parts = [
		retrieval.topK == null ? null : `topK ${retrieval.topK}`,
		retrieval.returnedCount == null
			? null
			: `${retrieval.returnedCount} returned`,
		retrieval.vectorEnabled == null
			? null
			: retrieval.vectorEnabled
				? "vector on"
				: "vector off",
		retrieval.vectorMs == null
			? null
			: `vector ${formatDurationOrNa(retrieval.vectorMs)}`,
		retrieval.hydrateFactsMs == null
			? null
			: `hydrate ${formatDurationOrNa(retrieval.hydrateFactsMs)}`,
	].filter(Boolean);
	return parts.length ? `Retrieval: ${parts.join(" · ")}` : "Retrieval: none";
}

function graphEvidenceTitle(
	graph: ActivityReviewGroup["traceEvidence"]["cognition"]["graph"],
): string {
	const projected = formatEvidenceIdSummary(
		"projected decisions",
		graph.projectedDecisionIds,
	);
	return `Graph: ${graph.status}; ${projected}`;
}

function traceEvidenceLabel(
	status: ActivityReviewGroup["traceEvidence"]["status"],
) {
	switch (status) {
		case "retrieval_decision_linked":
			return "retrieval+decision proof";
		case "cognitive_linked":
			return "cognitive proof";
		case "runtime_linked":
			return "runtime proof";
		case "mcp_linked":
			return "mcp proof";
		case "audit_only":
			return "audit only";
		case "missing_trace":
			return "trace missing";
	}
}

export const RECENT_ACTIVITY_PREVIEW_ROWS = 12;

function RecentActivitySection({ items }: { items: ActivityItem[] }) {
	const [expanded, setExpanded] = useState(false);
	const activityId = useId();
	const visibleItems = expanded
		? items
		: items.slice(0, RECENT_ACTIVITY_PREVIEW_ROWS);
	const remaining = items.length - RECENT_ACTIVITY_PREVIEW_ROWS;

	return (
		<Card>
			<CardHeader>
				<CardTitle className="flex items-center gap-2">
					<Users size={16} aria-hidden />
					Recent Activity
					<Badge variant="outline" className="ml-1 font-normal">
						who · audit
					</Badge>
				</CardTitle>
			</CardHeader>
			<CardContent className="px-0">
				<Collection
					id={activityId}
					appearance="inline"
					aria-label="Recent audit activity"
				>
					{visibleItems.map((item, index) => (
						<li
							key={`${item.timestamp}-${item.actorId}-${item.toolName ?? item.action}-${index}`}
						>
							<ActivityRow item={item} />
						</li>
					))}
				</Collection>
				{remaining > 0 ? (
					<div className="flex justify-center border-kumo-line border-t p-2">
						<Button
							aria-controls={activityId}
							aria-expanded={expanded}
							onClick={() => setExpanded((value) => !value)}
							size="sm"
							variant="ghost"
						>
							{expanded
								? `Show latest ${RECENT_ACTIVITY_PREVIEW_ROWS} only`
								: `Show ${remaining} more ${remaining === 1 ? "event" : "events"}`}
						</Button>
					</div>
				) : null}
			</CardContent>
		</Card>
	);
}

function ActivityRow({ item }: { item: ActivityItem }) {
	const [open, setOpen] = useState(false);
	return (
		<Collapsible onOpenChange={setOpen} open={open}>
			<div className="flex flex-wrap items-center gap-3 px-4 py-2 text-xs">
				<Text
					as="span"
					role="label"
					tone="secondary"
					className="shrink-0 tabular-nums"
				>
					{formatActivityTime(item.timestamp)}
				</Text>
				<Badge
					variant={item.success ? "success" : "destructive"}
					className="shrink-0"
				>
					{item.success ? "OK" : (item.errorCode ?? "Error")}
				</Badge>
				<span
					className="truncate"
					title={item.tool?.toolName ?? item.toolName ?? item.action}
				>
					{item.tool?.label ?? item.toolName ?? item.action}
				</span>
				<Text
					as="span"
					role="label"
					tone="secondary"
					className="ml-auto shrink-0"
					title={`${item.actorType}:${item.actorId}`}
				>
					<PrincipalName principal={item.subject ?? item.actor} muted />
				</Text>
				{item.agent && (
					<Text
						as="span"
						role="label"
						tone="secondary"
						className="shrink-0"
						title={item.agent.id}
					>
						via {item.agent.label}
					</Text>
				)}
				{item.identityCoverage.warnings.length > 0 && (
					<Text
						as="span"
						role="label"
						tone="secondary"
						className="shrink-0"
						title={coverageTitle(item.identityCoverage)}
					>
						<Info size={12} aria-hidden />
					</Text>
				)}
				{item.durationMs != null && (
					<Text
						as="span"
						role="label"
						tone="secondary"
						className="shrink-0 tabular-nums"
					>
						{formatDuration(item.durationMs)}
					</Text>
				)}
				{item.traceId && (
					<CollapsibleTrigger className="shrink-0">
						{open ? "hide" : "trace"}
					</CollapsibleTrigger>
				)}
			</div>
			{item.traceId && (
				<CollapsibleContent>
					<TraceActivityPanel traceId={item.traceId} />
				</CollapsibleContent>
			)}
		</Collapsible>
	);
}

function TraceActivityPanel({ traceId }: { traceId: string }) {
	const { data, isPending, isError } = useQuery({
		...traceActivityQueryOptions(traceId),
		staleTime: 300_000,
	});

	if (isPending) {
		return (
			<div className="px-6 py-2">
				<Skeleton className="h-12" />
			</div>
		);
	}

	if (isError) {
		return (
			<p role="alert" className="m-0 px-6 py-2 text-kumo-danger text-xs">
				Trace activity could not be loaded.
			</p>
		);
	}

	return (
		<div className="space-y-1 border-kumo-line border-l-2 bg-kumo-fill px-6 py-2 text-tedix-caption">
			<div className="text-kumo-subtle">
				<Text as="span" role="caption" tone="mono">
					trace {traceId}
				</Text>{" "}
				· {data.events.length} events ·{" "}
				{data.payloadsConfigured
					? `${data.payloads.length} payload(s)`
					: "payloads off"}
			</div>
			{data.events.map((event, index) => (
				<div
					key={`${event.timestamp}-${event.toolName ?? event.action}-${index}`}
					className="flex items-center gap-2"
				>
					<Badge variant={event.success ? "success" : "destructive"}>
						{event.success ? "OK" : (event.errorCode ?? "Err")}
					</Badge>
					<span
						className="truncate"
						title={event.tool?.toolName ?? event.toolName ?? event.action}
					>
						{event.tool?.label ?? event.toolName ?? event.action}
					</span>
					<Text
						as="span"
						role="caption"
						tone="secondary"
						title={`${event.actorType}:${event.actorId}`}
					>
						{event.actor.label}
					</Text>
					{event.durationMs != null && (
						<Text
							as="span"
							role="caption"
							tone="secondary"
							className="ml-auto tabular-nums"
						>
							{formatDuration(event.durationMs)}
						</Text>
					)}
				</div>
			))}
		</div>
	);
}

// =============================================================================
// Tool Call Payload Drill-Down
// =============================================================================

function ToolCallPayloadRow({
	executionId,
	toolName,
	success,
	durationMs,
}: {
	executionId: string;
	toolName: string;
	success: boolean;
	durationMs: number;
}) {
	const [isExpanded, setIsExpanded] = useState(false);

	const { data, isPending, isError } = useQuery({
		...toolCallPayloadsQueryOptions(executionId, toolName),
		staleTime: 300_000,
		enabled: isExpanded,
	});

	const payloads = data?.payloads ?? [];

	return (
		<Collapsible
			className="space-y-1"
			onOpenChange={setIsExpanded}
			open={isExpanded}
		>
			<CollapsibleTrigger className="flex w-full min-w-0 items-center gap-3 text-left">
				{isExpanded ? (
					<CaretDown
						size={12}
						aria-hidden
						className="shrink-0 text-kumo-subtle"
					/>
				) : (
					<CaretRight
						size={12}
						aria-hidden
						className="shrink-0 text-kumo-subtle"
					/>
				)}
				<Text
					as="span"
					role="control"
					tone="mono"
					className="min-w-0 flex-1 truncate"
				>
					{toolName}
				</Text>
				<span
					className={`inline-block h-1.5 w-1.5 shrink-0 rounded-full ${
						success ? "bg-kumo-success" : "bg-kumo-danger"
					}`}
				/>
				<Text
					as="span"
					role="control"
					tone="secondary"
					className="shrink-0 tabular-nums"
				>
					{formatDuration(durationMs)}
				</Text>
			</CollapsibleTrigger>
			<CollapsibleContent>
				<div className="space-y-2 pl-6">
					{isPending && <Skeleton className="h-16" />}
					{isError && (
						<p role="alert" className="m-0 text-kumo-danger text-xs">
							Payload details could not be loaded.
						</p>
					)}
					{!isPending && data && data.configured === false && (
						<Text as="p" role="label" tone="secondary" className="m-0">
							Payload capture is not enabled for this environment.
						</Text>
					)}
					{!isPending && data?.configured && payloads.length === 0 && (
						<Text as="p" role="label" tone="secondary" className="m-0">
							No payload captured for this call.
						</Text>
					)}
					{!isPending &&
						data?.configured &&
						payloads.map((payload, index) => (
							<ToolCallPayloadDetail
								key={`${payload.traceId}:${payload.toolName}:${payload.timestamp}:${index}`}
								payload={payload}
							/>
						))}
				</div>
			</CollapsibleContent>
		</Collapsible>
	);
}

function ToolCallPayloadDetail({ payload }: { payload: ToolCallPayload }) {
	const [showInput, setShowInput] = useState(false);
	const [showOutput, setShowOutput] = useState(false);

	return (
		<Surface className="space-y-1.5 px-3 py-2">
			<div className="flex flex-wrap items-center gap-2 text-tedix-caption">
				{payload.truncated ? (
					<Badge variant="secondary">Truncated</Badge>
				) : null}
				{payload.errorCode ? (
					<Badge variant="destructive">{payload.errorCode}</Badge>
				) : null}
				<Text
					as="span"
					role="caption"
					tone="secondary"
					className="tabular-nums"
				>
					in {formatBytes(payload.inputBytes)}
				</Text>
				<Text
					as="span"
					role="caption"
					tone="secondary"
					className="tabular-nums"
				>
					out {formatBytes(payload.outputBytes)}
				</Text>
			</div>
			<PayloadBlock
				label="Input"
				body={payload.inputArgs}
				isOpen={showInput}
				onToggle={() => setShowInput((value) => !value)}
			/>
			<PayloadBlock
				label="Output"
				body={payload.outputBody}
				isOpen={showOutput}
				onToggle={() => setShowOutput((value) => !value)}
			/>
		</Surface>
	);
}

function PayloadBlock({
	label,
	body,
	isOpen,
	onToggle,
}: {
	label: string;
	body: string;
	isOpen: boolean;
	onToggle: () => void;
}) {
	return (
		<Collapsible className="space-y-1" onOpenChange={onToggle} open={isOpen}>
			<CollapsibleTrigger className="px-0">
				{isOpen ? (
					<CaretDown size={12} aria-hidden />
				) : (
					<CaretRight size={12} aria-hidden />
				)}
				<Text as="span" role="control" weight="medium">
					{label}
				</Text>
			</CollapsibleTrigger>
			<CollapsibleContent>
				<CodeBlock
					className="max-h-64 overflow-auto"
					code={prettyJson(body)}
					lang="json"
				/>
			</CollapsibleContent>
		</Collapsible>
	);
}

function AnalyticsPending() {
	return (
		<div aria-hidden="true" className="space-y-6">
			<div className="space-y-2">
				<Skeleton className="h-7 w-48" />
				<Skeleton className="h-4 w-64" />
			</div>
			<div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
				<Skeleton className="h-32" />
				<Skeleton className="h-32" />
				<Skeleton className="h-32" />
			</div>
			<div className="grid grid-cols-2 gap-4 sm:grid-cols-5">
				<Skeleton className="h-20" />
				<Skeleton className="h-20" />
				<Skeleton className="h-20" />
				<Skeleton className="h-20" />
				<Skeleton className="h-20" />
			</div>
			<Skeleton className="h-[280px]" />
			<Skeleton className="h-64" />
		</div>
	);
}
