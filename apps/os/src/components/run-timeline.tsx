import { useQuery } from "@tanstack/react-query";
import type {
	SkillWorkflowRunTimeline,
	SkillWorkflowTimelineEvent,
} from "@tedix/api-contract/schemas/cognitive";
import { PauseIcon, PlayIcon } from "@phosphor-icons/react";
import { useEffect, useRef, useState } from "react";
import { Alert, AlertDescription, LoadError } from "@/components/kumo/alert";
import { Button } from "@/components/kumo/button";
import { Badge } from "@/components/kumo/badge";
import { Input } from "@/components/kumo/input";
import { CodeBlock, CodeInline } from "@/components/kumo/code";
import {
	RunStepConversation,
	RunStepResult,
} from "@/components/run-step-result";
import { LinkedTediActivity } from "@/components/run-tedi-activity";
import {
	hasRedaction,
	matchedParentStep,
	parentStepCoordinates,
	presentStepResult,
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
import { Slider } from "@/components/kumo/slider";
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

// Each lane gets its own hue so parallel work reads apart; red stays reserved
// for failures and pending calls are hollow.
const laneHues = ["blue", "violet", "amber", "teal"] as const;
const laneHue = (index: number) => laneHues[index % laneHues.length]!;
const barHue = (
	outcome: SkillWorkflowTimelineEvent["outcome"],
	hue: (typeof laneHues)[number],
) => (outcome === "failure" ? "red" : hue);

function barStyle(
	outcome: SkillWorkflowTimelineEvent["outcome"],
	laneColor: (typeof laneHues)[number],
	wait: boolean,
) {
	const hue = `var(--tedix-hue-${barHue(outcome, laneColor)})`;
	if (outcome === "failure") return { backgroundColor: hue };
	if (outcome === "pending")
		return { borderColor: hue, borderStyle: "dashed", borderWidth: 2 };
	return {
		backgroundColor: hue,
		...(wait
			? {
					backgroundImage:
						"repeating-linear-gradient(135deg, transparent, transparent 4px, var(--color-kumo-base) 4px, var(--color-kumo-base) 6px)",
				}
			: {}),
	};
}

/** A whole run replays in this long, however long it really took. */
const REPLAY_MS = 15_000;

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
	const replay = useReplay();
	const playhead = replay.progress;
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
				{(
					[
						["Finished", barStyle("success", laneHue(0), false)],
						["Failed", barStyle("failure", laneHue(0), false)],
						["Still running", barStyle("pending", laneHue(0), false)],
						["Recorded wait", barStyle("success", laneHue(0), true)],
					] as const
				).map(([label, style]) => (
					<Text
						key={label}
						as="span"
						role="label"
						className="flex items-center gap-1.5"
					>
						<span aria-hidden className="h-3 w-5 rounded" style={style} />
						{label}
					</Text>
				))}
				<Text as="span" tone="secondary" className="type-tedix-caption">
					Each row has its own color.
				</Text>
			</div>
			{layout.start !== null && layout.span > 0 && (
				<div
					className="flex flex-wrap items-center gap-3 sm:ml-44"
					aria-label="Replay"
				>
					<Button
						variant="outline"
						size="sm"
						onClick={replay.toggle}
						aria-label={replay.playing ? "Pause replay" : "Replay the run"}
					>
						{replay.playing ? (
							<PauseIcon aria-hidden />
						) : (
							<PlayIcon aria-hidden />
						)}
						{replay.playing ? "Pause" : playhead === null ? "Replay" : "Resume"}
					</Button>
					<Slider
						ariaLabel="Replay position"
						className="min-w-40 flex-1"
						min={0}
						max={100}
						step={0.1}
						value={playhead ?? 100}
						onValueChange={(value) => replay.seek(value)}
					/>
					<Text as="span" tone="secondary" className="type-tedix-caption">
						{formatDurationMs(((playhead ?? 100) / 100) * layout.span) ?? "0s"}{" "}
						of {formatDurationMs(layout.span)}
					</Text>
					{playhead !== null && (
						<Button variant="ghost" size="sm" onClick={replay.reset}>
							Show all
						</Button>
					)}
				</div>
			)}
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
			{layout.lanes.map((lane, laneIndex) => (
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
						{lane.entries.map(({ event, left, width, track }) => {
							// During a replay a step appears when it starts and grows until it ends.
							if (playhead !== null && left > playhead) return null;
							const shown =
								playhead === null ? width : Math.min(width, playhead - left);
							return (
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
										width: `${shown}%`,
										maxWidth: `max(8px, ${100 - left}%)`,
										top: track * 48,
									}}
								>
									<span
										aria-hidden
										data-hue={barHue(event.outcome, laneHue(laneIndex))}
										className="h-5 w-full overflow-hidden rounded"
										style={barStyle(
											event.outcome,
											laneHue(laneIndex),
											isTimelineWait(event),
										)}
									/>
								</Button>
							);
						})}
						{playhead !== null && (
							<span
								aria-hidden
								data-replay-playhead
								className="pointer-events-none absolute inset-y-0 border-l-2 border-kumo-contrast"
								style={{ left: `${playhead}%` }}
							/>
						)}
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

/**
 * Playhead for the timeline replay, as a percentage of the run. `null` shows
 * the whole run; playing advances it over REPLAY_MS and stops at the end.
 */
function useReplay() {
	const [progress, setProgress] = useState<number | null>(null);
	const [playing, setPlaying] = useState(false);
	const position = useRef<number>(0);
	useEffect(() => {
		if (!playing) return;
		let frame = 0;
		let last = performance.now();
		const tick = (now: number) => {
			position.current = Math.min(
				100,
				position.current + ((now - last) / REPLAY_MS) * 100,
			);
			last = now;
			setProgress(position.current);
			if (position.current >= 100) setPlaying(false);
			else frame = requestAnimationFrame(tick);
		};
		frame = requestAnimationFrame(tick);
		return () => cancelAnimationFrame(frame);
	}, [playing]);
	return {
		progress,
		playing,
		toggle() {
			if (playing) return setPlaying(false);
			if (progress === null || progress >= 100) position.current = 0;
			setProgress(position.current);
			setPlaying(true);
		},
		seek(value: number) {
			setPlaying(false);
			position.current = value;
			setProgress(value);
		},
		reset() {
			setPlaying(false);
			setProgress(null);
		},
	};
}

function isReferenceCoordinate(value: string) {
	return /(?:[0-9a-f]{8}-[0-9a-f-]{27}|:\/\/|^[^ ]+[:/][^ ]+$)/i.test(value);
}

export function RunTimelineStep({
	runId,
	event,
}: {
	runId: string;
	event: SkillWorkflowTimelineEvent;
}) {
	const receipt = useQuery({
		...workflowRunArtifactQueryOptions(runId, event.path),
		staleTime: 0,
		refetchOnMount: "always",
		retry: false,
	});
	const record = parseRunReceipt(receipt.data?.content);
	const request = stepRecord(record.request);
	const response = stepRecord(record.response);
	const parentCoordinates = parentStepCoordinates(event);
	const requiresParent =
		(event.kind === "mcp" || event.kind === "network") &&
		event.path.startsWith("epochs/");
	const childSensitive =
		record.sensitiveOutput === true ||
		hasRedaction(request) ||
		hasRedaction(response) ||
		hasRedaction(record.authorMetadata);
	const parentReceipt = useQuery({
		...workflowRunArtifactQueryOptions(runId, parentCoordinates?.path ?? ""),
		enabled:
			Boolean(parentCoordinates) &&
			!childSensitive &&
			!receipt.isPending &&
			!receipt.isError &&
			!receipt.isFetching,
		retry: false,
		staleTime: 0,
		refetchOnMount: "always",
	});
	const parentRecord = parseRunReceipt(parentReceipt.data?.content);
	const parentSensitive = Boolean(
		parentCoordinates &&
		parentReceipt.data &&
		!parentReceipt.isError &&
		!parentReceipt.isFetching &&
		(parentRecord.sensitiveOutput === true ||
			stepRecord(parentRecord.config).sensitive === "output" ||
			hasRedaction(parentRecord)),
	);
	const parentVerified = Boolean(
		parentCoordinates &&
		parentReceipt.data &&
		!parentReceipt.isError &&
		!parentReceipt.isFetching &&
		typeof parentRecord.sensitiveOutput === "boolean" &&
		matchedParentStep(event, record, parentRecord),
	);
	const parentUnavailable = Boolean(
		requiresParent && !childSensitive && !parentSensitive && !parentVerified,
	);
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
		: parentVerified && !parentSensitive
			? stepRecord(parentRecord.authorMetadata)
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
		childSensitive || parentSensitive || hasRedaction(authorMetadata);
	const restricted =
		sensitive || parentUnavailable || receipt.isError || receipt.isFetching;
	const outputPath =
		typeof record.outputArtifactPath === "string"
			? record.outputArtifactPath
			: "";
	const output = useQuery({
		...workflowRunArtifactQueryOptions(runId, outputPath),
		enabled: Boolean(outputPath) && !restricted,
		staleTime: 0,
		refetchOnMount: "always",
		retry: false,
	});
	const outputRecord = parseRunReceipt(output.data?.content);
	const outputHidden =
		restricted ||
		(Boolean(outputPath) && (output.isFetching || output.isError)) ||
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
	const resultEnvelope = stepRecord(value);
	const previewOnly =
		resultEnvelope.truncated === true &&
		!("value" in resultEnvelope) &&
		typeof resultEnvelope.preview === "string";
	const preview = previewOnly ? (resultEnvelope.preview as string) : null;
	const technicalSample =
		preview === null
			? sample
			: preview.length > 64_000
				? `${preview.slice(0, 64_000)}\n… Saved preview shortened for display.`
				: preview;
	const result = readableStepResult(value);
	const presentedResult = presentStepResult(result);
	const awaitingAnswer = stepRecord(result).pending === true;
	const isTediMethod = event.kind === "mcp" && event.method === "run_tedi_turn";
	const isTediCall = isTediMethod && event.namespace === "tedi";
	const reference =
		outputHidden || mismatched || isTediMethod
			? null
			: stepConversation(value, record);
	const requestValue = restricted ? null : (request.value ?? request.preview);
	const requestSample = outputSample(requestValue);
	const requestFull =
		requestValue == null
			? null
			: typeof requestValue === "string"
				? requestValue
				: JSON.stringify(requestValue, null, 2);
	const error = restricted ? null : outputSample(record.error);
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
			{!receipt.isPending && !receipt.isError && !restricted && (
				<div className="grid gap-3">
					{(typeof authorMetadata.purpose === "string" ||
						declaredInputs.length > 0 ||
						declaredNext.length > 0) && (
						<Text as="p" tone="secondary">
							Purpose, sources and planned next steps are declared by the
							workflow author.
						</Text>
					)}
					<section>
						<Text as="h3" role="label" weight="medium">
							{parentCoordinates ? "Step purpose" : "Purpose"}
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
							{parentCoordinates ? "Step input sources" : "Input sources"}
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
											{source !== label &&
												!isReferenceCoordinate(source) &&
												` — ${source}`}
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
			{!receipt.isPending &&
				!receipt.isError &&
				!parentUnavailable &&
				requestSample === null && (
					<Text as="p" tone="secondary">
						{sensitive
							? "Recorded input is hidden."
							: "No input or instructions were recorded for this step."}
					</Text>
				)}
			{!receipt.isPending && !receipt.isError && !restricted && (
				<section>
					<Text as="h3" role="label" weight="medium">
						Activity
					</Text>
					<Text as="p" tone="secondary">
						{event.kind === "mcp" || event.kind === "network"
							? "A call was recorded for this step."
							: "No additional activity was recorded."}
					</Text>
					{isTediCall && (
						<LinkedTediActivity
							runId={runId}
							executionEpoch={event.executionEpoch}
							path={event.path}
							attempt={event.attempt}
						/>
					)}
				</section>
			)}
			{!receipt.isPending && !receipt.isError && sensitive && isTediCall && (
				<section>
					<Text as="h3" role="label" weight="medium">
						Activity
					</Text>
					<Text as="p" tone="secondary">
						Assistant activity is withheld.
					</Text>
				</section>
			)}
			{receipt.isPending && <Skeleton className="h-20" />}
			{parentUnavailable && parentReceipt.isFetching && (
				<Text as="p" tone="secondary">
					Loading parent step details…
				</Text>
			)}
			{parentUnavailable && parentReceipt.isError && (
				<LoadError
					title="Parent step details unavailable"
					error={parentReceipt.error}
					onRetry={() => parentReceipt.refetch()}
					retrying={parentReceipt.isFetching}
				/>
			)}
			{parentUnavailable &&
				!parentReceipt.isFetching &&
				!parentReceipt.isError && (
					<Text as="p" tone="secondary">
						Parent step details could not be verified.
					</Text>
				)}
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
				!restricted &&
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
				parentUnavailable ||
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
							{!previewOnly && (
								<RunStepResult
									value={presentedResult.content}
									field={event.name === "clock" ? "timestamp" : undefined}
								/>
							)}
							{(response.truncated === true ||
								resultEnvelope.truncated === true) && (
								<Text as="p" tone="secondary">
									{previewOnly
										? "Only part of the result was recorded. The saved preview is in Technical details."
										: "Only part of the response was recorded."}
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
			{!receipt.isPending && !receipt.isError && !restricted && (
				<section>
					<Text as="h3" role="label" weight="medium">
						{parentCoordinates
							? "Step planned next steps"
							: "Planned next steps"}
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
			<Collapsible className="min-w-0">
				<CollapsibleDefaultTrigger>Technical details</CollapsibleDefaultTrigger>
				<CollapsibleDefaultContent>
					<Text as="p" tone="secondary" className="m-0">
						Original identifiers and saved response for troubleshooting.
					</Text>
					{!outputHidden &&
						!mismatched &&
						Object.keys(presentedResult.technical).length > 0 && (
							<CodeBlock
								code={outputSample(presentedResult.technical) ?? ""}
								lang="json"
							/>
						)}
					{(declaredInputs.length > 0 || declaredNext.length > 0) &&
						!restricted && (
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
					{technicalSample && (
						<div className="min-w-0 max-w-full max-h-96 overflow-auto p-1">
							<CodeBlock code={technicalSample} lang="json" />
						</div>
					)}
				</CollapsibleDefaultContent>
			</Collapsible>
		</div>
	);
}
