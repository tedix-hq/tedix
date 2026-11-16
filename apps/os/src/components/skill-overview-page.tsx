import { useQuery } from "@tanstack/react-query";
import { Link as RouterLink, useParams } from "@tanstack/react-router";
import type {
	SkillEntry,
	SkillRunSummary,
} from "@tedix/api-contract/schemas/cognitive";
import { useState } from "react";
import { RunStatusChip } from "@/components/activity-runs";
import { DetailUnavailable } from "@/components/detail-unavailable";
import { Badge } from "@/components/kumo/badge";
import { Button } from "@/components/kumo/button";
import {
	Collapsible,
	CollapsibleDefaultContent,
	CollapsibleDefaultTrigger,
} from "@/components/kumo/collapsible";
import { Empty } from "@/components/kumo/empty";
import { MetricGrid, MetricItem } from "@/components/kumo/metric-grid";
import {
	PageSection,
	SectionDescription,
	SectionHeader,
	SectionHeading,
	SectionTitle,
} from "@/components/kumo/page";
import { SegmentedControl } from "@/components/kumo/segmented-control";
import { Text } from "@/components/kumo/text";
import { ListQueryBoundary } from "@/components/list-query-boundary";
import { ListSkeleton } from "@/components/list-skeleton";
import { SkillRunChart } from "@/components/skill-run-chart";
import { SkillConnectionsList } from "@/components/skill-settings-page";
import { formatCount, useOsFormattingPreferences } from "@/lib/format";
import {
	installedAppEligibilityQueryOptions,
	skillDetailQueryOptions,
	skillRunsQueryOptions,
	skillRunStatusQueryOptions,
} from "@/lib/os-query-options";
import { deriveSkillDocumentUse } from "@/lib/skill-documents";
import { inputLabel } from "@/lib/skill-anatomy";
import {
	METRIC_RANGES,
	METRIC_RUN_LIMIT,
	type MetricRange,
	metricRangeStart,
	skillRunMetrics,
} from "@/lib/skill-run-metrics";
import {
	SKILL_RUN_TRIGGER_LABELS,
	skillRunResultLine,
} from "@/lib/skill-runs-search";
import {
	absoluteTime,
	formatDurationBetween,
	formatDurationMs,
	normalizeD1Timestamp,
	relativeTime,
} from "@/lib/time";

const RECENT_RUNS = 5;

export function SkillOverviewPage() {
	useOsFormattingPreferences();
	const { skillId } = useParams({ from: "/_session/_tenant/skills/$skillId" });
	const detail = useQuery(skillDetailQueryOptions(skillId));
	const skill = detail.data?.entry;
	if (detail.isPending) return <ListSkeleton rows={6} />;
	if (detail.isError || !skill)
		return (
			<DetailUnavailable
				resource="Skill"
				error={detail.error}
				onRetry={() => detail.refetch()}
				retrying={detail.isFetching}
			/>
		);
	return (
		<div className="grid min-w-0 gap-8">
			<SkillMetricsSection skillId={skillId} />
			<SkillRecentRuns skillId={skillId} />
			<SkillUsesSection skill={skill} />
			<SkillFeedbackSection
				successCount={skill.successCount}
				failureCount={skill.failureCount}
			/>
		</div>
	);
}

function SkillMetricsSection({ skillId }: { skillId: string }) {
	const [range, setRange] = useState<MetricRange>("7d");
	// The start is cut to the hour, so the read keeps one key while it stands.
	const runs = useQuery(
		skillRunsQueryOptions(
			skillId,
			{ startedAfter: metricRangeStart(range) },
			METRIC_RUN_LIMIT,
		),
	);
	const metrics = runs.data ? skillRunMetrics(runs.data.runs, range) : null;
	const capped = (runs.data?.runs.length ?? 0) >= METRIC_RUN_LIMIT;
	const none = metrics?.runs === 0;
	return (
		<PageSection aria-labelledby="skill-metrics-title">
			<SectionHeader>
				<SectionHeading>
					<SectionTitle id="skill-metrics-title">How it is doing</SectionTitle>
					{capped ? (
						<SectionDescription>
							Counts cover the latest {METRIC_RUN_LIMIT} runs in this time.
						</SectionDescription>
					) : null}
				</SectionHeading>
				<SegmentedControl
					ariaLabel="Time range"
					compact
					value={range}
					onValueChange={setRange}
					options={METRIC_RANGES.map((value) => ({
						value,
						label: value,
					}))}
				/>
			</SectionHeader>
			<ListQueryBoundary
				query={runs}
				errorTitle={
					runs.data ? "Could not refresh runs" : "Run counts unavailable"
				}
				errorDescription={
					runs.data
						? "Showing counts read earlier; they may be out of date."
						: undefined
				}
			/>
			{metrics ? (
				<>
					<MetricGrid aria-label="Run counts" columns={4}>
						<MetricItem label="Runs" value={formatCount(metrics.runs)} />
						<MetricItem
							label="Success rate"
							value={
								metrics.successRate == null
									? "—"
									: `${Math.round(metrics.successRate * 100)}%`
							}
							description={
								none
									? "No runs in this time."
									: metrics.successRate == null
										? "Nothing has finished yet."
										: `${formatCount(metrics.completed)} of ${formatCount(metrics.completed + metrics.failed)} finished runs completed.`
							}
						/>
						<MetricItem
							label="Typical time"
							value={formatDurationMs(metrics.medianDurationMs) ?? "—"}
							description="Median of completed runs."
						/>
						<MetricItem
							label="Failures"
							value={formatCount(metrics.failed)}
							valueTone={metrics.failed > 0 ? "error" : "strong"}
						/>
					</MetricGrid>
					<SkillRunChart buckets={metrics.buckets} range={range} />
				</>
			) : null}
		</PageSection>
	);
}

function valueText(value: unknown): string {
	if (typeof value === "string") return value;
	return JSON.stringify(value);
}

/** What a run was given and what it produced, read when the row is opened. */
function RunInputsOutputs({ run }: { run: SkillRunSummary }) {
	const status = useQuery(skillRunStatusQueryOptions(run.id));
	if (status.isPending)
		return (
			<Text role="label" tone="secondary">
				Reading this run…
			</Text>
		);
	if (status.isError || !status.data)
		return (
			<div className="flex flex-wrap items-center gap-2" role="status">
				<Text as="span" role="label" tone="secondary">
					Could not read this run's details.
				</Text>
				<Button
					variant="outline"
					size="sm"
					disabled={status.isFetching}
					onClick={() => void status.refetch()}
				>
					Retry
				</Button>
			</div>
		);
	const params = Object.entries(status.data.params ?? {});
	const result = status.data.result;
	return (
		<div className="grid min-w-0 gap-3">
			<div className="grid gap-1">
				<Text as="strong" role="label">
					Given
				</Text>
				{params.length > 0 ? (
					<ul className="m-0 grid list-none gap-0.5 p-0">
						{params.map(([name, value]) => (
							<li key={name} className="min-w-0 wrap-anywhere">
								<Text as="span" role="body" tone="secondary">
									{inputLabel(name)}:{" "}
								</Text>
								<Text as="span" role="body">
									{valueText(value)}
								</Text>
							</li>
						))}
					</ul>
				) : (
					<Text role="body" tone="secondary" className="m-0">
						Nothing was given.
					</Text>
				)}
			</div>
			<div className="grid gap-1">
				<Text as="strong" role="label">
					Produced
				</Text>
				<Text role="body" tone="secondary" className="m-0 wrap-anywhere">
					{run.resultSummary?.trim() ||
						(result == null
							? "No result was recorded."
							: "A result was recorded; see technical details.")}
				</Text>
			</div>
			{result != null ? (
				<Collapsible>
					<CollapsibleDefaultTrigger>
						Technical details
					</CollapsibleDefaultTrigger>
					<CollapsibleDefaultContent keepMounted>
						<pre className="m-0 max-h-64 overflow-auto px-2 pt-1 pb-2 text-kumo-subtle type-tedix-control whitespace-pre-wrap break-words">
							{JSON.stringify(result, null, 2)}
						</pre>
					</CollapsibleDefaultContent>
				</Collapsible>
			) : null}
		</div>
	);
}

function RecentRunRow({ run }: { run: SkillRunSummary }) {
	const [open, setOpen] = useState(false);
	const result = skillRunResultLine(run, new Date());
	const started = run.startedAt ? normalizeD1Timestamp(run.startedAt) : null;
	const duration = formatDurationBetween(run.startedAt, run.completedAt);
	return (
		<li data-run-id={run.id} className="grid min-w-0 gap-1 px-4 py-3">
			<span className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
				<RouterLink
					to="/work/runs/$runId"
					params={{ runId: run.id }}
					className="inline-flex min-h-11 items-center"
				>
					<RunStatusChip status={run.status} />
				</RouterLink>
				<Text as="span" role="label" tone="secondary">
					{run.trigger ? SKILL_RUN_TRIGGER_LABELS[run.trigger] : "Not recorded"}
					{started ? " · " : ""}
					{started ? (
						<time dateTime={run.startedAt!} title={absoluteTime(started)}>
							{relativeTime(started)}
						</time>
					) : null}
					{duration ? ` · ${duration}` : ""}
				</Text>
			</span>
			{result ? (
				<Text
					role="body"
					tone={result.tone}
					className="m-0 line-clamp-2 break-words"
					title={result.text}
				>
					{result.text}
				</Text>
			) : null}
			<Collapsible open={open} onOpenChange={setOpen}>
				<CollapsibleDefaultTrigger>
					Inputs and outputs
				</CollapsibleDefaultTrigger>
				<CollapsibleDefaultContent>
					{open ? (
						<div className="px-2 pt-1 pb-2">
							<RunInputsOutputs run={run} />
						</div>
					) : null}
				</CollapsibleDefaultContent>
			</Collapsible>
		</li>
	);
}

function SkillRecentRuns({ skillId }: { skillId: string }) {
	const runs = useQuery(skillRunsQueryOptions(skillId, undefined, RECENT_RUNS));
	const rows = (runs.data?.runs ?? []).slice(0, RECENT_RUNS);
	return (
		<PageSection aria-labelledby="skill-recent-runs-title">
			<SectionHeader>
				<SectionHeading>
					<SectionTitle id="skill-recent-runs-title">Recent runs</SectionTitle>
				</SectionHeading>
				<Button
					variant="ghost"
					size="sm"
					render={
						<RouterLink to="/skills/$skillId/runs" params={{ skillId }} />
					}
				>
					View all runs
				</Button>
			</SectionHeader>
			<ListQueryBoundary
				query={runs}
				errorTitle={runs.data ? "Could not refresh runs" : "Runs unavailable"}
				errorDescription={
					runs.data
						? "Showing previously loaded runs; their status may be out of date."
						: undefined
				}
			/>
			{runs.data ? (
				rows.length === 0 ? (
					<Empty
						appearance="inline"
						title="No runs yet"
						description="This skill has not run."
					/>
				) : (
					<ul
						aria-label="Recent runs"
						className="m-0 grid list-none divide-y divide-kumo-line border-kumo-line border-y p-0"
					>
						{rows.map((run) => (
							<RecentRunRow key={run.id} run={run} />
						))}
					</ul>
				)
			) : null}
		</PageSection>
	);
}

function SkillUsesSection({ skill }: { skill: SkillEntry }) {
	const installed = useQuery(installedAppEligibilityQueryOptions());
	const documents = deriveSkillDocumentUse(skill);
	return (
		<PageSection aria-labelledby="skill-uses-title">
			<SectionHeader>
				<SectionHeading>
					<SectionTitle id="skill-uses-title">
						What it uses and produces
					</SectionTitle>
					<SectionDescription>
						The apps it calls, and the documents and sheets it reads and writes.
					</SectionDescription>
				</SectionHeading>
			</SectionHeader>
			<SkillConnectionsList skill={skill} installed={installed} />
			{documents.length > 0 ? (
				<ul
					aria-label="Documents and sheets"
					className="m-0 flex list-none flex-wrap items-center gap-2 p-0"
				>
					{documents.map((use) => (
						<li key={`${use.kind}-${use.access}`}>
							<Badge variant="secondary">
								{use.access === "reads" ? "Reads" : "Writes"}{" "}
								{use.kind === "sheet" ? "sheets" : "documents"}
							</Badge>
						</li>
					))}
					<li>
						<Button
							variant="ghost"
							size="sm"
							render={<RouterLink to="/outputs" />}
						>
							Open documents
						</Button>
					</li>
				</ul>
			) : (
				<Text role="body" tone="secondary" className="m-0">
					No documents or sheets are named in this skill.
				</Text>
			)}
		</PageSection>
	);
}

function SkillFeedbackSection({
	successCount,
	failureCount,
}: {
	successCount: number;
	failureCount: number;
}) {
	return (
		<PageSection aria-labelledby="skill-feedback-title">
			<SectionHeader>
				<SectionHeading>
					<SectionTitle id="skill-feedback-title">Feedback</SectionTitle>
				</SectionHeading>
			</SectionHeader>
			<Text role="body" className="m-0">
				{successCount + failureCount > 0
					? `${formatCount(successCount)} found it helpful · ${formatCount(failureCount)} found it unhelpful`
					: "No feedback yet."}
			</Text>
		</PageSection>
	);
}
