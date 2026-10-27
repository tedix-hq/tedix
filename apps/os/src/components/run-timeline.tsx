import { CaretDown } from "@phosphor-icons/react";
import { useQuery } from "@tanstack/react-query";
import type {
	SkillWorkflowRunTimeline,
	SkillWorkflowTimelineEvent,
} from "@tedix/api-contract/schemas/cognitive";
import { useState } from "react";
import { Alert, AlertDescription, LoadError } from "@/components/kumo/alert";
import { Button } from "@/components/kumo/button";
import {
	Collapsible,
	CollapsibleContent,
	CollapsibleTrigger,
} from "@/components/kumo/collapsible";
import { MetricGrid, MetricItem } from "@/components/kumo/metric-grid";
import {
	PageSection,
	SectionHeader,
	SectionHeading,
	SectionTitle,
	SectionDescription,
} from "@/components/kumo/page";
import {
	Sheet,
	SheetContent,
	SheetHeader,
	SheetTitle,
	SheetDescription,
} from "@/components/kumo/sheet";
import { Skeleton } from "@/components/kumo/skeleton";
import { Text } from "@/components/kumo/text";
import {
	workflowRunArtifactQueryOptions,
	workflowRunTimelineQueryOptions,
} from "@/lib/os-query-options";
import {
	isTimelineWait,
	layoutRunTimeline,
	outputSample,
	parseRunReceipt,
} from "@/lib/run-timeline";
import { absoluteTime, formatDurationMs } from "@/lib/time";
import { cn } from "@/lib/utils";

const outcomeClasses = {
	success: "bg-kumo-success",
	failure: "bg-kumo-danger",
	pending: "bg-kumo-interact",
};

const waitStyle = {
	backgroundImage:
		"repeating-linear-gradient(135deg, transparent, transparent 4px, var(--color-kumo-base) 4px, var(--color-kumo-base) 6px)",
};

export function RunTimeline({ runId }: { runId: string }) {
	const timeline = useQuery({
		...workflowRunTimelineQueryOptions(runId),
		refetchInterval: (query) =>
			query.state.data &&
			["queued", "running", "paused"].includes(query.state.data.run.status)
				? 5_000
				: false,
	});
	return (
		<PageSection>
			<SectionHeader>
				<SectionHeading>
					<SectionTitle>Run timeline</SectionTitle>
					<SectionDescription>
						Calls and recorded waits on a shared time scale. Select a step for
						its receipt.
					</SectionDescription>
				</SectionHeading>
			</SectionHeader>
			{timeline.isPending && <Skeleton className="h-48" />}
			{timeline.isError && (
				<LoadError
					title="Timeline unavailable"
					error={timeline.error}
					onRetry={() => timeline.refetch()}
					retrying={timeline.isFetching}
				/>
			)}
			{timeline.data && (
				<RunTimelineChart key={runId} timeline={timeline.data} />
			)}
		</PageSection>
	);
}

export function RunTimelineChart({
	timeline,
}: {
	timeline: SkillWorkflowRunTimeline;
}) {
	const [selectedId, setSelectedId] = useState<string | null>(null);
	const selected = timeline.events.find((event) => event.id === selectedId);
	const layout = layoutRunTimeline(timeline, Date.now());
	const calls = timeline.events.filter(
		(event) => event.kind === "mcp" || event.kind === "network",
	);
	const elapsed =
		timeline.run.startedAt &&
		(timeline.run.completedAt ||
			["running", "paused"].includes(timeline.run.status))
			? (timeline.run.completedAt
					? Date.parse(timeline.run.completedAt)
					: Date.now()) - Date.parse(timeline.run.startedAt)
			: null;
	const select = (event: SkillWorkflowTimelineEvent) => setSelectedId(event.id);
	return (
		<div className="grid min-w-0 gap-4" data-run-timeline>
			<MetricGrid columns={5} appearance="bounded" aria-label="Run summary">
				<MetricItem
					label="Elapsed"
					value={formatDurationMs(elapsed) ?? "Unknown"}
				/>
				<MetricItem
					label="Calls succeeded"
					value={calls.filter((event) => event.outcome === "success").length}
				/>
				<MetricItem
					label="Calls failed"
					value={calls.filter((event) => event.outcome === "failure").length}
				/>
				<MetricItem
					label="Calls pending"
					value={calls.filter((event) => event.outcome === "pending").length}
				/>
				<MetricItem
					label="Recorded waits"
					value={timeline.events.filter(isTimelineWait).length}
				/>
			</MetricGrid>
			{timeline.coverage === "partial" && (
				<Alert variant="warning">
					<AlertDescription>
						Partial history — some calls or timings were not recorded. Gaps do
						not prove the run was idle.
					</AlertDescription>
				</Alert>
			)}
			{timeline.warnings.length > 0 && (
				<Collapsible>
					<CollapsibleTrigger>
						<CaretDown size={14} />
						Recording details ({timeline.warnings.length})
					</CollapsibleTrigger>
					<CollapsibleContent>
						<ul className="list-disc pl-5 wrap-anywhere">
							{timeline.warnings.map((warning, index) => (
								<li key={`${index}:${warning}`}>{warning}</li>
							))}
						</ul>
					</CollapsibleContent>
				</Collapsible>
			)}
			<div className="flex flex-wrap gap-4" aria-label="Timeline legend">
				{(["success", "failure", "pending"] as const).map((outcome) => (
					<Text
						key={outcome}
						as="span"
						role="label"
						className="flex items-center gap-1.5"
					>
						<span
							aria-hidden
							className={cn("size-2 rounded-full", outcomeClasses[outcome])}
						/>
						{outcome}
					</Text>
				))}
				<Text as="span" role="label" className="flex items-center gap-1.5">
					<span
						aria-hidden
						className="h-3 w-5 rounded bg-kumo-interact"
						style={waitStyle}
					/>
					Recorded wait
				</Text>
			</div>
			{layout.start !== null && (
				<div
					className="flex justify-between gap-2 text-kumo-subtle type-tedix-caption sm:ml-44"
					aria-label="Time scale"
				>
					<span>0s</span>
					<span>{formatDurationMs(layout.span / 2)}</span>
					<span>{formatDurationMs(layout.span)}</span>
				</div>
			)}
			{layout.lanes.map((lane) => (
				<div
					key={lane.id}
					className="grid min-w-0 gap-2 border-b border-kumo-line pb-3 sm:grid-cols-[10rem_minmax(0,1fr)]"
					data-timeline-lane={lane.id}
				>
					<Text
						as="h3"
						role="label"
						weight="medium"
						className="m-0 wrap-anywhere"
					>
						{lane.label}
					</Text>
					<div
						className="relative min-w-0 rounded bg-kumo-tint"
						style={{ height: lane.tracks * 48 }}
					>
						{[0, 25, 50, 75, 100].map((tick) => (
							<span
								key={tick}
								aria-hidden
								className="pointer-events-none absolute inset-y-0 border-l border-kumo-line"
								style={{ left: `${tick}%` }}
							/>
						))}
						{lane.entries.map(({ event, left, width, track }) => (
							<Button
								key={event.id}
								variant="ghost"
								size="sm"
								multiline
								aria-label={`${event.name} · ${event.status} · ${formatDurationMs(event.durationMs) ?? "duration unknown"}`}
								title={`${event.name} · ${event.status}`}
								onClick={() => select(event)}
								data-timeline-event={event.id}
								data-outcome={event.outcome}
								data-wait={isTimelineWait(event) || undefined}
								className="absolute !h-11 !min-w-2 !justify-start !p-0"
								style={{
									left: `min(${left}%, calc(100% - 8px))`,
									width: `${width}%`,
									maxWidth: `max(8px, ${100 - left}%)`,
									top: track * 48,
								}}
							>
								<span
									aria-hidden
									className={cn(
										"h-5 w-full overflow-hidden rounded border border-kumo-line",
										outcomeClasses[event.outcome],
									)}
									style={isTimelineWait(event) ? waitStyle : undefined}
								/>
							</Button>
						))}
					</div>
				</div>
			))}
			{timeline.events.length === 0 && (
				<Text as="p" tone="secondary">
					No timeline receipts recorded for this run.
				</Text>
			)}
			{layout.untimed.length > 0 && (
				<div className="grid gap-2">
					<Text as="h3" role="label" weight="medium">
						Timing unknown ({layout.untimed.length})
					</Text>
					<div className="flex flex-wrap gap-2">
						{layout.untimed.map((event) => (
							<Button
								key={event.id}
								variant="outline"
								onClick={() => select(event)}
								className="max-w-full"
								multiline
							>
								{event.name} · {event.status}
							</Button>
						))}
					</div>
				</div>
			)}
			<Sheet
				open={Boolean(selected)}
				onOpenChange={(open) => {
					if (!open) setSelectedId(null);
				}}
			>
				<SheetContent size="lg">
					<SheetHeader className="pr-16">
						<SheetTitle>{selected?.name ?? "Step details"}</SheetTitle>
						<SheetDescription>
							{selected
								? `${selected.kind} · ${selected.status}`
								: "Select a step"}
						</SheetDescription>
					</SheetHeader>
					{selected && (
						<RunTimelineStep
							key={`${selected.id}:${selected.status}`}
							runId={timeline.run.id}
							event={selected}
						/>
					)}
				</SheetContent>
			</Sheet>
		</div>
	);
}

function RunTimelineStep({
	runId,
	event,
}: {
	runId: string;
	event: SkillWorkflowTimelineEvent;
}) {
	const receipt = useQuery(workflowRunArtifactQueryOptions(runId, event.path));
	const record = parseRunReceipt(receipt.data?.content);
	const sensitive = record.sensitiveOutput === true;
	const outputPath =
		typeof record.outputArtifactPath === "string"
			? record.outputArtifactPath
			: "";
	const output = useQuery({
		...workflowRunArtifactQueryOptions(runId, outputPath),
		enabled: Boolean(outputPath) && !sensitive,
	});
	const outputRecord = parseRunReceipt(output.data?.content);
	// Output paths can be reused by retries; do not attribute a later attempt's value to this receipt.
	const mismatched =
		output.data &&
		((outputRecord.stepCount !== undefined &&
			outputRecord.stepCount !== event.count) ||
			(event.attempt !== undefined &&
				outputRecord.attempt !== undefined &&
				outputRecord.attempt !== event.attempt));
	const sample = sensitive
		? null
		: outputSample(
				outputPath
					? mismatched
						? null
						: outputRecord.value
					: (record.response ?? record.output ?? record.value),
			);
	const error = outputSample(record.error);
	return (
		<div className="grid min-w-0 gap-5 p-4 pt-0 sm:p-6 sm:pt-0">
			<MetricGrid columns={2} appearance="bounded">
				<MetricItem
					label="Started"
					value={event.startedAt ? absoluteTime(event.startedAt) : "Unknown"}
				/>
				<MetricItem
					label="Finished"
					value={event.endedAt ? absoluteTime(event.endedAt) : "Not recorded"}
				/>
				<MetricItem
					label="Duration"
					value={formatDurationMs(event.durationMs) ?? "Unknown"}
				/>
				<MetricItem label="Outcome" value={event.outcome} />
			</MetricGrid>
			<Text as="p" role="label" className="m-0 wrap-anywhere">
				{event.lane} · call {event.count}
				{event.attempt ? ` · attempt ${event.attempt}` : ""}
				{event.httpStatus ? ` · HTTP ${event.httpStatus}` : ""}
			</Text>
			{receipt.isPending && <Skeleton className="h-20" />}
			{receipt.isError && (
				<LoadError
					title="Receipt unavailable"
					error={receipt.error}
					onRetry={() => receipt.refetch()}
					retrying={receipt.isFetching}
				/>
			)}
			{error && (
				<Alert variant="destructive">
					<AlertDescription>
						<pre className="m-0 whitespace-pre-wrap wrap-anywhere">{error}</pre>
					</AlertDescription>
				</Alert>
			)}
			{!error && event.outcome === "failure" && (
				<Text as="p" tone="secondary">
					No error detail was recorded in this receipt.
				</Text>
			)}
			<div className="grid min-w-0 gap-2">
				<Text as="h3" role="label" weight="medium">
					Output sample
				</Text>
				{output.isFetching && <Skeleton className="h-20" />}
				{output.isError && (
					<LoadError
						title="Output unavailable"
						error={output.error}
						onRetry={() => output.refetch()}
						retrying={output.isFetching}
					/>
				)}
				{sample ? (
					<pre
						data-output-sample
						className="m-0 max-h-80 overflow-y-auto rounded-lg bg-kumo-tint p-3 whitespace-pre-wrap wrap-anywhere type-tedix-caption"
					>
						{sample}
					</pre>
				) : (
					<Text as="p" tone="secondary">
						{sensitive
							? "Sensitive output is hidden."
							: mismatched
								? "The saved output belongs to another attempt."
								: "No output sample recorded."}
					</Text>
				)}
			</div>
			<Text as="p" role="label" tone="secondary" className="wrap-anywhere">
				Receipt: {event.path}
			</Text>
		</div>
	);
}
