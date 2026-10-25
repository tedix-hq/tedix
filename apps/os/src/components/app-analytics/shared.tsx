/**
 * Shared building blocks of the app analytics page: query-state cards,
 * freshness strip, metric cards, caller types and the event-volume table
 * beside the lazy chart.
 */

import type {
	AppActivityFreshnessSchema,
	AppTimeSeriesSchema,
} from "@tedix/api-contract/contracts/analytics";
import { ArrowDown, ArrowUp, Pulse, Users } from "@phosphor-icons/react";
import { useMemo } from "react";
import type { z } from "zod";
import { Alert, AlertDescription } from "@/components/kumo/alert";
import { Badge } from "@/components/kumo/badge";
import {
	Card,
	CardContent,
	CardHeader,
	CardTitle,
} from "@/components/kumo/card";
import { AppTabReadRetry } from "@/components/app-detail-tab-shared";
import { Empty, EmptyDescription } from "@/components/kumo/empty";
import { MetricGrid, MetricItem } from "@/components/kumo/metric-grid";
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
	formatAuditAction,
	formatBucketLabel,
	formatCurrentWindow,
	formatDuration,
	formatTimestamp,
	getCallerTypeDisplay,
} from "./format";

type ReadQuery = { isFetching: boolean; refetch: () => Promise<unknown> };
type AppTimeSeries = z.infer<typeof AppTimeSeriesSchema>;
type AppActivityFreshness = z.infer<typeof AppActivityFreshnessSchema>;

/**
 * One analytics section's non-data state. `error` means the section has no
 * data; `stale` means a refresh failed and the data shown is from an earlier
 * read. Both offer a read-only retry of that section's query alone.
 */
export function AnalyticsQueryState({
	label,
	state,
	query,
}: {
	label: string;
	state: "loading" | "error" | "empty" | "stale";
	query?: ReadQuery;
}) {
	return (
		<Card>
			<CardContent>
				{state === "loading" ? (
					<p role="status" className="m-0 text-kumo-subtle type-tedix-body">
						{`Loading ${label.toLowerCase()}...`}
					</p>
				) : state === "error" || state === "stale" ? (
					<Alert variant={state === "error" ? "destructive" : "default"}>
						<AlertDescription>
							<span>
								{state === "error"
									? `${label} could not be loaded.`
									: `${label} could not be refreshed. Showing earlier data.`}
							</span>
							{query && <AppTabReadRetry query={query} />}
						</AlertDescription>
					</Alert>
				) : (
					<Empty appearance="inline" role="status">
						<EmptyDescription>{`No ${label.toLowerCase()} in this period.`}</EmptyDescription>
					</Empty>
				)}
			</CardContent>
		</Card>
	);
}

export function CallerTypesCard({ callerTypes }: { callerTypes: string[] }) {
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

export function EventVolumeTable({
	buckets,
}: {
	buckets: AppTimeSeries["buckets"];
}) {
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

export function ActivityFreshnessStrip({
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

/** Period-over-period change, shown after a metric value; nothing when flat. */
export function PeriodChange({ change }: { change?: number }) {
	if (change == null || change === 0) return null;
	return (
		<Badge
			variant={change > 0 ? "success" : "destructive"}
			className="gap-0.5 font-normal"
		>
			{change > 0 ? (
				<ArrowUp size={12} aria-hidden />
			) : (
				<ArrowDown size={12} aria-hidden />
			)}
			{Math.abs(Math.round(change))}% vs prior
		</Badge>
	);
}
