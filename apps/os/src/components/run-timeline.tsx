import { useQuery } from "@tanstack/react-query";
import type {
	SkillWorkflowRunTimeline,
	SkillWorkflowTimelineEvent,
} from "@tedix/api-contract/schemas/cognitive";
import { useState } from "react";
import { Alert, AlertDescription, LoadError } from "@/components/kumo/alert";
import { Button } from "@/components/kumo/button";
import { Badge } from "@/components/kumo/badge";
import { Input } from "@/components/kumo/input";
import { CodeBlock, CodeInline } from "@/components/kumo/code";
import {
	RunStepConversation,
	RunStepResult,
} from "@/components/run-step-result";
import {
	hasRedaction,
	readableField,
	readableStepResult,
	stepConversation,
	stepRecord,
	stepTitle,
} from "@/lib/run-step-content";
import {
	Collapsible,
	CollapsibleDefaultTrigger,
	CollapsibleDefaultContent,
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
					<SectionTitle>What happened</SectionTitle>
					<SectionDescription>
						See which tasks ran together and where time was spent. Choose a step
						to read its request and result.
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
	const [search, setSearch] = useState("");
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
			<label className="grid gap-2">
				Find a step
				<Input
					aria-label="Find a step"
					value={search}
					onChange={(event) => setSearch(event.target.value)}
					placeholder="Search tasks or tools"
				/>
			</label>
			{search.trim() && (
				<div
					aria-label="Matching steps"
					className="flex max-h-56 min-w-0 flex-wrap gap-2 overflow-y-auto rounded-lg border border-kumo-line bg-kumo-base p-2"
				>
					{timeline.events
						.filter((event) =>
							`${event.name} ${event.method ?? ""} ${event.lane}`
								.toLowerCase()
								.includes(search.toLowerCase().trim()),
						)
						.map((event) => (
							<Button
								key={event.id}
								variant="outline"
								className="max-w-full shrink-0"
								onClick={() => select(event)}
								multiline
							>
								{readableField(event.name)} ·{" "}
								{formatDurationMs(event.durationMs) ?? "Time not recorded"}
							</Button>
						))}
				</div>
			)}
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
					<CollapsibleDefaultTrigger>
						Recording details ({timeline.warnings.length})
					</CollapsibleDefaultTrigger>
					<CollapsibleDefaultContent>
						<ul className="list-disc pl-5 wrap-anywhere">
							{timeline.warnings.map((warning, index) => (
								<li key={`${index}:${warning}`}>{warning}</li>
							))}
						</ul>
					</CollapsibleDefaultContent>
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
						<SheetTitle>
							{selected ? stepTitle(selected) : "Step details"}
						</SheetTitle>
						<SheetDescription>
							{selected
								? "Read what this step was asked to do and what it returned."
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

function isReferenceCoordinate(value: string) {
	return /(?:[0-9a-f]{8}-[0-9a-f-]{27}|:\/\/|^[^ ]+[:/][^ ]+$)/i.test(value);
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
	const request = stepRecord(record.request);
	const response = stepRecord(record.response);
	const metadataMatchesAttempt =
		event.kind === "step" &&
		typeof event.attempt === "number" &&
		event.path.startsWith(`epochs/${event.executionEpoch}/steps/`) &&
		event.path.endsWith(`/${event.count}/attempts/${event.attempt}.json`) &&
		record.kind === "workflow_step_attempt" &&
		record.executionEpoch === event.executionEpoch &&
		record.attempt === event.attempt &&
		stepRecord(record.step).count === event.count;
	const authorMetadata = metadataMatchesAttempt
		? stepRecord(record.authorMetadata)
		: {};
	const declaredInputs = Array.isArray(authorMetadata.inputs)
		? authorMetadata.inputs
				.map(stepRecord)
				.filter((input) => typeof input.source === "string")
		: [];
	const declaredNext =
		typeof authorMetadata.usedNext === "string"
			? [authorMetadata.usedNext]
			: Array.isArray(authorMetadata.usedNext) &&
				  authorMetadata.usedNext.every((item) => typeof item === "string")
				? (authorMetadata.usedNext as string[])
				: [];
	const sensitive =
		record.sensitiveOutput === true ||
		hasRedaction(request) ||
		hasRedaction(response) ||
		hasRedaction(authorMetadata);
	const outputPath =
		typeof record.outputArtifactPath === "string"
			? record.outputArtifactPath
			: "";
	const output = useQuery({
		...workflowRunArtifactQueryOptions(runId, outputPath),
		enabled: Boolean(outputPath) && !sensitive,
	});
	const outputRecord = parseRunReceipt(output.data?.content);
	const outputHidden =
		sensitive ||
		outputRecord.sensitiveOutput === true ||
		hasRedaction(outputRecord.value);
	// Output paths can be reused by retries; do not attribute a later attempt's value to this receipt.
	const mismatched = Boolean(
		output.data &&
		(typeof event.attempt !== "number" ||
			typeof outputRecord.stepCount !== "number" ||
			typeof outputRecord.attempt !== "number" ||
			typeof outputRecord.executionEpoch !== "number" ||
			outputRecord.stepCount !== event.count ||
			outputRecord.attempt !== event.attempt ||
			outputRecord.executionEpoch !== event.executionEpoch),
	);
	const value =
		outputHidden || mismatched
			? null
			: outputPath
				? outputRecord.value
				: (record.response ?? record.output ?? record.value);
	const sample = outputSample(value);
	const result = readableStepResult(value);
	const awaitingAnswer = stepRecord(result).pending === true;
	const reference =
		outputHidden || mismatched ? null : stepConversation(value, record);
	const requestValue = sensitive ? null : (request.value ?? request.preview);
	const requestSample = outputSample(requestValue);
	const requestFull =
		requestValue == null
			? null
			: typeof requestValue === "string"
				? requestValue
				: JSON.stringify(requestValue, null, 2);
	const error = sensitive ? null : outputSample(record.error);
	return (
		<div className="grid min-w-0 gap-5 p-4 pt-0 sm:p-6 sm:pt-0">
			<div className="flex flex-wrap items-center gap-3">
				<Badge
					variant={
						event.outcome === "failure"
							? "destructive"
							: event.outcome === "pending"
								? "secondary"
								: "success"
					}
				>
					{awaitingAnswer
						? "Request accepted"
						: event.outcome === "failure"
							? "Failed"
							: event.outcome === "pending"
								? "Waiting"
								: "Finished"}
				</Badge>
				<Text as="span" tone="secondary">
					{formatDurationMs(event.durationMs) ?? "Time not recorded"}
				</Text>
			</div>
			<MetricGrid columns={2} appearance="bounded">
				<MetricItem
					label="Started"
					value={event.startedAt ? absoluteTime(event.startedAt) : "Unknown"}
				/>
				<MetricItem
					label="Finished"
					value={event.endedAt ? absoluteTime(event.endedAt) : "Not recorded"}
				/>
			</MetricGrid>
			{!receipt.isPending && !receipt.isError && !sensitive && (
				<div className="grid gap-3">
					{(typeof authorMetadata.purpose === "string" ||
						declaredInputs.length > 0 ||
						declaredNext.length > 0) && (
						<Text as="p" tone="secondary">
							Purpose, sources and next use are declared by the workflow author.
						</Text>
					)}
					<section>
						<Text as="h3" role="label" weight="medium">
							Purpose
						</Text>
						{typeof authorMetadata.purpose === "string" ? (
							<RunStepResult value={authorMetadata.purpose} />
						) : (
							<Text as="p" tone="secondary">
								Not recorded
							</Text>
						)}
					</section>
					<section>
						<Text as="h3" role="label" weight="medium">
							Input sources
						</Text>
						{declaredInputs.length > 0 ? (
							<ul className="m-0 grid gap-2 pl-5">
								{declaredInputs.map((input, index) => {
									const source = input.source as string;
									const candidate =
										typeof input.name === "string" && input.name.trim()
											? input.name
											: source;
									const label = isReferenceCoordinate(candidate)
										? "Source reference"
										: candidate;
									return (
										<li key={index}>
											{label}
											{(typeof input.sourceRevision === "number" ||
												typeof input.sourceRevision === "string") &&
												(typeof input.sourceRevision === "string" &&
												isReferenceCoordinate(input.sourceRevision)
													? " · version recorded"
													: ` · version ${input.sourceRevision}`)}
										</li>
									);
								})}
							</ul>
						) : (
							<Text as="p" tone="secondary">
								Not recorded
							</Text>
						)}
					</section>
				</div>
			)}
			{requestSample !== null && (
				<Collapsible>
					<CollapsibleDefaultTrigger>
						Recorded inputs and instructions
					</CollapsibleDefaultTrigger>
					<CollapsibleDefaultContent>
						<RunStepResult value={requestValue} />
						{requestFull && requestFull.length > 4000 && (
							<Collapsible>
								<CollapsibleDefaultTrigger>
									Show more saved input
								</CollapsibleDefaultTrigger>
								<CollapsibleDefaultContent>
									<CodeBlock code={requestFull.slice(0, 64000)} lang="json" />
									{requestFull.length > 64000 && (
										<Text as="p" tone="secondary">
											Only the first 64,000 characters are shown.
										</Text>
									)}
								</CollapsibleDefaultContent>
							</Collapsible>
						)}
						{request.truncated === true && (
							<Text as="p" tone="secondary">
								Only part of the request was saved here. The conversation may
								contain more.
							</Text>
						)}
					</CollapsibleDefaultContent>
				</Collapsible>
			)}
			{!receipt.isPending && !receipt.isError && requestSample === null && (
				<Text as="p" tone="secondary">
					{sensitive
						? "Recorded input is hidden."
						: "No input or instructions were recorded for this step."}
				</Text>
			)}
			{!receipt.isPending && !receipt.isError && !sensitive && (
				<section>
					<Text as="h3" role="label" weight="medium">
						Activity
					</Text>
					<Text as="p" tone="secondary">
						{event.kind === "mcp" || event.kind === "network"
							? "A call was recorded for this step."
							: "No separate activity is recorded in this receipt."}
					</Text>
				</section>
			)}
			{receipt.isPending && <Skeleton className="h-20" />}
			{receipt.isError && (
				<LoadError
					title="Step details unavailable"
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
			{!error &&
				!receipt.isPending &&
				!receipt.isError &&
				event.outcome === "failure" && (
					<Text as="p" tone="secondary">
						No error detail was recorded in this receipt.
					</Text>
				)}
			<div className="grid min-w-0 gap-2">
				<Text as="h3" role="label" weight="medium">
					Result
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
				{receipt.isPending ||
				(outputPath && output.isFetching) ||
				receipt.isError ||
				(outputPath && output.isError) ? null : sample !== null ? (
					awaitingAnswer ? (
						<Text as="p" tone="secondary">
							The request was accepted. This record is not the final reply.
						</Text>
					) : (
						<div
							data-output-sample
							className="min-w-0 rounded-lg border border-kumo-line bg-kumo-base p-4"
						>
							<RunStepResult
								value={result}
								field={event.name === "clock" ? "timestamp" : undefined}
							/>
							{response.truncated === true && (
								<Text as="p" tone="secondary">
									Only part of the response was recorded.
								</Text>
							)}
						</div>
					)
				) : (
					<Text as="p" tone="secondary">
						{outputHidden
							? "Sensitive output is hidden."
							: mismatched
								? "The saved output cannot be matched to this attempt and execution."
								: "No result was saved for this step."}
					</Text>
				)}
			</div>
			{!receipt.isPending && !receipt.isError && !sensitive && (
				<section>
					<Text as="h3" role="label" weight="medium">
						Used next
					</Text>
					{declaredNext.length > 0 ? (
						<ul className="m-0 grid gap-2 pl-5">
							{declaredNext.map((entry, index) => (
								<li key={index}>
									{isReferenceCoordinate(entry)
										? "Recorded reference (see technical details)"
										: entry}
								</li>
							))}
						</ul>
					) : (
						<Text as="p" tone="secondary">
							Not recorded
						</Text>
					)}
				</section>
			)}
			{reference && <RunStepConversation reference={reference} />}
			{!reference &&
				!outputHidden &&
				!mismatched &&
				!receipt.isPending &&
				!receipt.isError &&
				event.kind === "step" && (
					<Text as="p" tone="secondary">
						No conversation was linked to this task. Its saved result is shown
						above.
					</Text>
				)}
			<Collapsible className="min-w-0">
				<CollapsibleDefaultTrigger>Technical details</CollapsibleDefaultTrigger>
				<CollapsibleDefaultContent>
					<Text as="p" tone="secondary" className="m-0">
						Original identifiers and saved response for troubleshooting.
					</Text>
					{(declaredInputs.length > 0 || declaredNext.length > 0) &&
						!sensitive && (
							<CodeBlock
								code={JSON.stringify(
									{ inputs: declaredInputs, usedNext: declaredNext },
									null,
									2,
								)}
								lang="json"
							/>
						)}
					<dl className="m-0 grid min-w-0 gap-3">
						<div>
							<Text as="dt" role="label">
								Step
							</Text>
							<dd className="m-0 mt-1 wrap-anywhere">
								<CodeInline>{event.name}</CodeInline>
							</dd>
						</div>
						<div>
							<Text as="dt" role="label">
								Tool or lane
							</Text>
							<dd className="m-0 mt-1 wrap-anywhere">
								<CodeInline>{event.lane}</CodeInline>
							</dd>
						</div>
						<div>
							<Text as="dt" role="label">
								Call and attempt
							</Text>
							<dd className="m-0 mt-1">
								Call {event.count}
								{event.attempt ? ` · attempt ${event.attempt}` : ""}
								{event.httpStatus ? ` · HTTP ${event.httpStatus}` : ""}
							</dd>
						</div>
						<div>
							<Text as="dt" role="label">
								Saved record
							</Text>
							<dd className="m-0 mt-1 wrap-anywhere">
								<CodeInline>{event.path}</CodeInline>
							</dd>
						</div>
					</dl>
					{sample && (
						<div className="min-w-0 max-w-full max-h-96 overflow-auto p-1">
							<CodeBlock code={sample} lang="json" />
						</div>
					)}
				</CollapsibleDefaultContent>
			</Collapsible>
		</div>
	);
}
