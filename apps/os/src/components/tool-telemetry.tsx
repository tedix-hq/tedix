import { Wrench } from "@phosphor-icons/react";
import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { LoadError } from "@/components/kumo/alert";
import { Badge } from "@/components/kumo/badge";
import { Button } from "@/components/kumo/button";
import {
	Empty,
	EmptyDescription,
	EmptyHeader,
	EmptyMedia,
	EmptyTitle,
} from "@/components/kumo/empty";
import {
	EvidenceRow,
	EvidenceRowContent,
	EvidenceRowDetail,
	EvidenceRowSignal,
	EvidenceRowStatus,
} from "@/components/kumo/evidence-row";
import { Meter } from "@/components/kumo/meter";
import { MetricGrid, MetricItem } from "@/components/kumo/metric-grid";
import {
	PageSection,
	SectionActions,
	SectionDescription,
	SectionHeader,
	SectionHeading,
	SectionTitle,
} from "@/components/kumo/page";
import { KumoTabs } from "@/components/kumo/tabs";
import { Text } from "@/components/kumo/text";
import { ListSkeleton } from "@/components/list-skeleton";
import { useOsFormattingPreferences, formatCount } from "@/lib/format";
import { isAuthorizationError } from "@/lib/orpc-error";
import { runtimeEventsQueryOptions } from "@/lib/os-query-options";
import { absoluteTime, formatDurationMs, relativeTime } from "@/lib/time";
import {
	deriveToolBreakdown,
	filterToolEvents,
	mergeToolEvents,
	summarizeToolEvents,
	type TediToolEvent,
	type ToolBreakdownRow,
	type ToolOutcomeFilter,
	TOOL_EVENTS_LIMIT,
	toolLabel,
	toolWindowTruncated,
} from "@/lib/tool-events";
import { cn } from "@/lib/utils";

// ---------------------------------------------------------------------------
// Pure helpers (exported for tests)
// ---------------------------------------------------------------------------

export const OUTCOME_FILTERS = [
	{ id: "all", label: "All" },
	{ id: "success", label: "Succeeded" },
	{ id: "failure", label: "Failed" },
] as const satisfies readonly { id: ToolOutcomeFilter; label: string }[];

/** Tools listed in the breakdown before the remainder becomes a count. */
export const BREAKDOWN_TOP_N = 10;

/** Event rows rendered in the table before the remainder becomes a count. */
export const EVENT_ROWS_LIMIT = 40;

/** 0.9333 → "93%". Null renders as an em dash by the caller. */
export function ratePercent(rate: number): string {
	return `${Math.round(rate * 100)}%`;
}

/**
 * Bar width for a breakdown row, as a percentage of the busiest tool. Guards
 * the degenerate single-call case so one call still draws a visible bar.
 */
export function barPercent(calls: number, maxCalls: number): number {
	if (maxCalls <= 0) return 0;
	return Math.max(4, Math.round((calls / maxCalls) * 100));
}

// ---------------------------------------------------------------------------
// Presentational subcomponents (exported for tests)
// ---------------------------------------------------------------------------

export function TelemetryStat({
	label,
	value,
	tone = "neutral",
}: {
	label: string;
	value: string;
	tone?: "neutral" | "warn" | "danger";
}) {
	return (
		<MetricItem
			data-tone={tone}
			emphasis="dialog"
			label={label}
			value={value}
			valueTone={
				tone === "warn"
					? "warning"
					: tone === "danger"
						? "error"
						: "strong"
			}
		/>
	);
}

/**
 * One tool's rollup. The meter compares call volume against the busiest
 * tool in the window; failures tint it warning.
 */
export function ToolBreakdownRowView({
	row,
	maxCalls,
	selected = false,
	onSelect,
}: {
	row: ToolBreakdownRow;
	maxCalls: number;
	selected?: boolean;
	onSelect?: () => void;
}) {
	useOsFormattingPreferences();
	const latency = formatDurationMs(row.medianLatencyMs);
	return (
		<li>
			<Button
				aria-pressed={selected}
				onClick={onSelect}
				data-tool={row.toolName}
				className={cn(
					"grid w-full gap-1 px-3 py-2 text-left",
					selected && "bg-kumo-tint",
				)}
				multiline
				variant="ghost"
			>
				<span className="flex min-w-0 items-baseline justify-between gap-3">
					<Text as="span" className="truncate" tone="strong" weight="medium">
						{row.toolName}
					</Text>
					<Text
						as="span"
						className="shrink-0 tabular-nums"
						role="label"
						tone="secondary"
					>
						{formatCount(row.calls)} {row.calls === 1 ? "call" : "calls"}
						{row.failures > 0 ? ` · ${formatCount(row.failures)} failed` : ""}
						{latency ? ` · ${latency} median` : ""}
					</Text>
				</span>
				<Meter
					aria-hidden
					label={`${row.toolName} call volume`}
					hideLabel
					value={barPercent(row.calls, maxCalls)}
					trackClassName="h-1.5"
					indicatorClassName={
						row.failures > 0
							? "from-kumo-warning via-kumo-warning to-kumo-warning"
							: "from-kumo-info via-kumo-info to-kumo-info"
					}
				/>
			</Button>
		</li>
	);
}

export function ToolEventRow({ event }: { event: TediToolEvent }) {
	useOsFormattingPreferences();
	const latency = formatDurationMs(event.latencyMs);
	return (
		<EvidenceRow
			as="li"
			data-success={event.success === null ? "unknown" : String(event.success)}
			className="gap-y-0.5 rounded-lg px-3 py-2"
		>
			<EvidenceRowSignal
				aria-hidden
				className={cn(
					"mt-1.5 size-2 shrink-0 rounded-full bg-kumo-interact",
					event.success === true && "bg-kumo-success",
					event.success === false && "bg-kumo-danger",
				)}
			/>
			<EvidenceRowContent className="truncate font-medium text-kumo-strong text-sm">
				{toolLabel(event.toolName)}
			</EvidenceRowContent>
			<EvidenceRowStatus>
				<Badge
					variant={
						event.success === false
							? "error"
							: event.success === true
								? "success"
								: "outline"
					}
				>
					{event.success === false
						? "Failed"
						: event.success === true
							? "Succeeded"
							: "Unknown"}
				</Badge>
			</EvidenceRowStatus>
			{event.error ? (
				<EvidenceRowDetail className="text-kumo-danger text-xs">
					{event.error}
				</EvidenceRowDetail>
			) : null}
			<EvidenceRowDetail className="text-kumo-subtle text-xs tabular-nums">
				<time dateTime={event.createdAt} title={absoluteTime(event.createdAt)}>
					{relativeTime(event.createdAt)}
				</time>
				{latency ? ` · ${latency}` : ""}
				{event.runId ? ` · run ${event.runId.slice(0, 8)}` : ""}
			</EvidenceRowDetail>
		</EvidenceRow>
	);
}

export function ToolTelemetryEmpty({ filtered }: { filtered: boolean }) {
	return (
		<Empty appearance="quiet">
			<EmptyHeader>
				<EmptyMedia variant="icon">
					<Wrench size={20} />
				</EmptyMedia>
				<EmptyTitle>
					{filtered
						? "No tool calls match this filter"
						: "No tool calls recorded"}
				</EmptyTitle>
				<EmptyDescription>
					Tool telemetry is read from the durable runtime-event ledger. Calls
					appear here as this tedi uses tools.
				</EmptyDescription>
			</EmptyHeader>
		</Empty>
	);
}

// ---------------------------------------------------------------------------
// Section component
// ---------------------------------------------------------------------------

/**
 * Tool telemetry for one tedi: window summary, per-tool breakdown, and the
 * filtered event list.
 *
 * Two reads, one per settled kind, because `listEvents` filters by a single
 * `kind`. Neither may request the compact `summary` projection: the projection
 * drops `payload`, which is exactly where the tool name, latency, and error
 * live.
 */
export function ToolTelemetry({ tediId }: { tediId: string }) {
	useOsFormattingPreferences();
	const [outcome, setOutcome] = useState<ToolOutcomeFilter>("all");
	const [tool, setTool] = useState<string | null>(null);

	const completed = useQuery({
		...runtimeEventsQueryOptions({
			tediId,
			kind: "tool.completed",
			limit: TOOL_EVENTS_LIMIT,
		}),
		staleTime: 60_000,
	});
	const failed = useQuery({
		...runtimeEventsQueryOptions({
			tediId,
			kind: "tool.failed",
			limit: TOOL_EVENTS_LIMIT,
		}),
		staleTime: 60_000,
	});

	const completedEvents = completed.data?.events;
	const failedEvents = failed.data?.events;

	const events = useMemo(
		() => mergeToolEvents(completedEvents ?? [], failedEvents ?? []),
		[completedEvents, failedEvents],
	);
	const breakdown = useMemo(
		() => deriveToolBreakdown(events, BREAKDOWN_TOP_N),
		[events],
	);
	const allToolCount = useMemo(
		() => deriveToolBreakdown(events).length,
		[events],
	);
	const visible = useMemo(
		() => filterToolEvents(events, { outcome, toolName: tool }),
		[events, outcome, tool],
	);
	const summary = summarizeToolEvents(events);

	const truncated = toolWindowTruncated(
		completedEvents?.length ?? 0,
		failedEvents?.length ?? 0,
	);
	const pending = completed.isPending || failed.isPending;
	// A partial read is still a lie about totals — surface whichever failed
	// rather than quietly rendering half the ledger as the whole.
	const error = completed.error ?? failed.error ?? null;
	const refused = isAuthorizationError(error);
	const maxCalls = breakdown[0]?.calls ?? 0;

	return (
		<PageSection>
			<SectionHeader>
				<SectionHeading>
					<SectionTitle>Tool telemetry</SectionTitle>
					<SectionDescription>
						Recent settled tool calls, outcomes, latency, and failure evidence.
					</SectionDescription>
				</SectionHeading>
				<SectionActions className="max-sm:w-full">
					{completed.data && failed.data ? (
						<Badge variant="secondary">{summary.calls}</Badge>
					) : null}
					<div className="min-w-0 max-sm:w-full">
						<KumoTabs
							value={outcome}
							onValueChange={(value) => setOutcome(value as ToolOutcomeFilter)}
							className="w-full sm:w-auto"
							aria-label="Tool call outcome"
							size="sm"
							tabs={OUTCOME_FILTERS.map(({ id, label }) => ({
								value: id,
								label,
							}))}
						/>
					</div>
				</SectionActions>
			</SectionHeader>

			{pending && <ListSkeleton rows={2} />}

			{error != null && (
				<LoadError
					title={
						refused
							? "Tool telemetry is not readable with your access"
							: "Tool telemetry is unavailable"
					}
					error={error}
					onRetry={() => {
						void completed.refetch();
						void failed.refetch();
					}}
					retrying={completed.isFetching || failed.isFetching}
				/>
			)}

			{completed.data && failed.data && (
				<>
					<MetricGrid
						appearance="bounded"
						aria-label="Tool call summary"
						columns={5}
					>
						<TelemetryStat
							label="tool calls"
							value={formatCount(summary.calls)}
						/>
						<TelemetryStat
							label="failures"
							value={formatCount(summary.failures)}
							tone={summary.failures > 0 ? "danger" : "neutral"}
						/>
						<TelemetryStat
							label="success rate"
							value={
								summary.successRate === null
									? "—"
									: ratePercent(summary.successRate)
							}
							tone={
								summary.successRate !== null && summary.successRate < 0.9
									? "warn"
									: "neutral"
							}
						/>
						<TelemetryStat
							label="median latency"
							value={formatDurationMs(summary.medianLatencyMs) ?? "—"}
						/>
						<TelemetryStat
							label="distinct tools"
							value={formatCount(summary.distinctTools)}
						/>
					</MetricGrid>

					<Text className="m-0" role="label" tone="secondary">
						{summary.calls === 0
							? "No settled tool calls in the ledger for this tedi."
							: `Window: the ${formatCount(summary.calls)} most recent settled tool ${
									summary.calls === 1 ? "call" : "calls"
								}${
									summary.oldestAt
										? `, back to ${absoluteTime(summary.oldestAt)}`
										: ""
								}.`}
						{truncated
							? ` Older calls exist outside this ${formatCount(TOOL_EVENTS_LIMIT)}-per-kind window, so these counts are a floor.`
							: ""}
					</Text>

					{breakdown.length > 0 && (
						<div className="grid min-w-0 gap-1.5">
							<Text as="span" role="label" tone="secondary">
								Busiest tools · select one to filter the calls below
							</Text>
							<ul className="m-0 grid list-none gap-0.5 p-0">
								{breakdown.map((row) => (
									<ToolBreakdownRowView
										key={row.toolName}
										row={row}
										maxCalls={maxCalls}
										selected={tool === row.toolName}
										onSelect={() =>
											setTool((current) =>
												current === row.toolName ? null : row.toolName,
											)
										}
									/>
								))}
							</ul>
							{allToolCount > breakdown.length && (
								<Text className="m-0 px-3" role="label" tone="secondary">
									Showing the {formatCount(breakdown.length)} busiest of{" "}
									{formatCount(allToolCount)} tools used in this window.
								</Text>
							)}
						</div>
					)}

					{visible.length === 0 ? (
						<ToolTelemetryEmpty filtered={outcome !== "all" || tool !== null} />
					) : (
						<>
							<ul className="m-0 grid list-none gap-0.5 p-0">
								{visible.slice(0, EVENT_ROWS_LIMIT).map((event) => (
									<ToolEventRow key={event.id} event={event} />
								))}
							</ul>
							{visible.length > EVENT_ROWS_LIMIT && (
								<Text className="m-0 px-3" role="label" tone="secondary">
									Showing {formatCount(EVENT_ROWS_LIMIT)} of{" "}
									{formatCount(visible.length)} matching calls.
								</Text>
							)}
						</>
					)}
				</>
			)}
		</PageSection>
	);
}
