import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useParams } from "@tanstack/react-router";
import type { SkillRunSummary } from "@tedix/api-contract/contracts/cognitive";
import { useMemo } from "react";
import { RunStatusChip } from "@/components/activity-runs";
import { LoadError } from "@/components/kumo/alert";
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
	AlertDialogTrigger,
} from "@/components/kumo/alert-dialog";
import { Badge } from "@/components/kumo/badge";
import { Button } from "@/components/kumo/button";

import { Empty } from "@/components/kumo/empty";
import { Link } from "@/components/kumo/link";
import {
	PageSection,
	SectionDescription,
	SectionHeader,
	SectionHeading,
	SectionTitle,
} from "@/components/kumo/page";
import { SegmentedControl } from "@/components/kumo/segmented-control";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/kumo/select";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@/components/kumo/table";
import { Text } from "@/components/kumo/text";
import { ListQueryBoundary } from "@/components/list-query-boundary";
import { osApi } from "@/lib/api";
import {
	SKILL_RUN_PAGE_SIZE,
	SKILL_RUN_TRIGGER_LABELS,
	type SkillRunRange,
	type SkillRunsSearch,
	hasActiveSkillRun,
	hasSkillRunFilter,
	isStuckSkillRun,
	skillRunLogFilter,
	skillRunResultLine,
} from "@/lib/skill-runs-search";
import { osQueryKeys, skillRunsQueryOptions } from "@/lib/os-query-options";
import { useOsFormattingPreferences } from "@/lib/format";
import { useCanManageTedis } from "@/lib/tedi-permissions";

import {
	absoluteTime,
	formatDurationBetween,
	normalizeD1Timestamp,
	relativeTime,
} from "@/lib/time";

const STATUS_OPTIONS = [
	{ value: "all", label: "All" },
	{ value: "queued", label: "Queued" },
	{ value: "running", label: "Running" },
	{ value: "paused", label: "Paused" },
	{ value: "failed", label: "Failed" },
	{ value: "completed", label: "Completed" },
	{ value: "canceled", label: "Canceled" },
] as const;

const TRIGGER_OPTIONS = [
	{ value: "all", label: "Started by anything" },
	{ value: "scheduled", label: "Scheduled" },
	{ value: "manual", label: "Manual" },
	{ value: "agent", label: "Agent or app" },
	{ value: "test", label: "Test" },
] as const;

const RANGE_OPTIONS = [
	{ value: "all", label: "All time" },
	{ value: "day", label: "Last 24 hours" },
	{ value: "week", label: "Last 7 days" },
	{ value: "month", label: "Last 30 days" },
] as const;

function FilterSelect({
	label,
	value,
	options,
	onChange,
}: {
	label: string;
	value: string;
	options: readonly { value: string; label: string }[];
	onChange: (value: string | undefined) => void;
}) {
	return (
		<Select
			value={value}
			onValueChange={(next) =>
				onChange(next == null || next === "all" ? undefined : String(next))
			}
		>
			<SelectTrigger aria-label={label} className="w-full sm:w-auto">
				<SelectValue>
					{options.find((option) => option.value === value)?.label ?? value}
				</SelectValue>
			</SelectTrigger>
			<SelectContent>
				{options.map((option) => (
					<SelectItem key={option.value} value={option.value}>
						{option.label}
					</SelectItem>
				))}
			</SelectContent>
		</Select>
	);
}

export function SkillRunsPage({
	search,
	updateSearch,
}: {
	search: SkillRunsSearch;
	updateSearch: (patch: Partial<SkillRunsSearch>) => void;
}) {
	const { skillId } = useParams({ from: "/_session/_tenant/skills/$skillId" });
	const page = search.page ?? 1;
	const canCancel = useCanManageTedis();
	// The range start is fixed while the filters stand, so polling a running
	// run re-reads one list instead of a new one every minute.
	const filter = useMemo(
		() => skillRunLogFilter(search),
		[search.status, search.trigger, search.revision, search.range, search.page],
	);
	const runs = useQuery({
		...skillRunsQueryOptions(skillId, filter, SKILL_RUN_PAGE_SIZE),
		refetchInterval: (query) =>
			hasActiveSkillRun(query.state.data?.runs ?? []) ? 5_000 : false,
	});
	// A filter change starts again at the newest runs.
	const setFilter = (patch: Partial<SkillRunsSearch>) =>
		updateSearch({ ...patch, page: undefined });
	const rows = runs.data?.runs ?? [];
	const revisions = [
		...new Set(
			[search.revision, ...rows.map((run) => run.skillRevision)].filter(
				(revision): revision is number => revision != null,
			),
		),
	].sort((a, b) => b - a);
	const filtered = hasSkillRunFilter(search);
	return (
		<PageSection aria-labelledby="skill-run-history-title">
			<SectionHeader>
				<SectionHeading>
					<SectionTitle id="skill-run-history-title">Run history</SectionTitle>
					<SectionDescription>
						Each run: how it ended, what started it, when, how long it took and
						what came of it. Open a run for its steps.
					</SectionDescription>
				</SectionHeading>
			</SectionHeader>
			<SegmentedControl
				ariaLabel="Filter skill runs"
				className="w-full sm:w-fit"
				compact
				value={search.status ?? "all"}
				onValueChange={(value) =>
					setFilter({
						status:
							value === "all"
								? undefined
								: (value as SkillRunsSearch["status"]),
					})
				}
				options={STATUS_OPTIONS}
			/>
			<div className="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap sm:items-center">
				<FilterSelect
					label="Filter by what started the run"
					value={search.trigger ?? "all"}
					options={TRIGGER_OPTIONS}
					onChange={(value) =>
						setFilter({ trigger: value as SkillRunsSearch["trigger"] })
					}
				/>
				<FilterSelect
					label="Filter by time"
					value={search.range ?? "all"}
					options={RANGE_OPTIONS}
					onChange={(value) =>
						setFilter({ range: value as SkillRunRange | undefined })
					}
				/>
				<FilterSelect
					label="Filter by revision"
					value={search.revision ? String(search.revision) : "all"}
					options={[
						{ value: "all", label: "All revisions" },
						...revisions.map((revision) => ({
							value: String(revision),
							label: `Revision ${revision}`,
						})),
					]}
					onChange={(value) =>
						setFilter({ revision: value ? Number(value) : undefined })
					}
				/>
				{filtered ? (
					<Button
						variant="ghost"
						onClick={() =>
							setFilter({
								status: undefined,
								trigger: undefined,
								range: undefined,
								revision: undefined,
							})
						}
					>
						Clear filters
					</Button>
				) : null}
			</div>
			{runs.isError && runs.data ? (
				<LoadError
					title={<>Runs could not refresh</>}
					error={runs.error}
					onRetry={() => {
						void runs.refetch();
					}}
					retrying={runs.isFetching}
					help={`Showing runs loaded ${relativeTime(new Date(runs.dataUpdatedAt).toISOString())}; they may be out of date.`}
				/>
			) : (
				<ListQueryBoundary query={runs} errorTitle="Runs unavailable" />
			)}
			{runs.data ? (
				<SkillRunTable
					runs={rows}
					filtered={filtered}
					statusOnly={
						Boolean(search.status) &&
						!search.trigger &&
						!search.range &&
						!search.revision
					}
					page={page}
					canCancel={canCancel}
				/>
			) : null}
			{runs.data && (page > 1 || rows.length >= SKILL_RUN_PAGE_SIZE) ? (
				<nav
					aria-label="Run history pages"
					className="flex items-center justify-between gap-3"
				>
					<Button
						variant="secondary"
						disabled={page <= 1}
						onClick={() =>
							updateSearch({ page: page > 2 ? page - 1 : undefined })
						}
					>
						Newer runs
					</Button>
					<Text role="label" tone="secondary">
						Page {page}
					</Text>
					<Button
						variant="secondary"
						disabled={rows.length < SKILL_RUN_PAGE_SIZE}
						onClick={() => updateSearch({ page: page + 1 })}
					>
						Older runs
					</Button>
				</nav>
			) : null}
		</PageSection>
	);
}

function CancelStuckRun({ runId }: { runId: string }) {
	const queryClient = useQueryClient();
	const cancel = useMutation({
		mutationFn: () =>
			osApi.skills.runWorkflowCancel({
				runId,
				confirmDestructive: true,
				reason: "Canceled as stuck from the skill's run history in Tedix OS",
			}),
		onSettled: () =>
			queryClient.invalidateQueries({ queryKey: osQueryKeys.skillRuns() }),
	});
	return (
		<AlertDialog>
			<AlertDialogTrigger
				render={
					<Button variant="secondary" size="sm" disabled={cancel.isPending} />
				}
			>
				Cancel
			</AlertDialogTrigger>
			<AlertDialogContent>
				<AlertDialogHeader>
					<AlertDialogTitle>Cancel this run?</AlertDialogTitle>
					<AlertDialogDescription>
						The run will be asked to stop. It can take a moment to show as
						canceled.
					</AlertDialogDescription>
				</AlertDialogHeader>
				<AlertDialogFooter>
					<AlertDialogCancel>Keep running</AlertDialogCancel>
					<AlertDialogAction
						variant="destructive"
						onClick={() => cancel.mutate()}
					>
						Cancel run
					</AlertDialogAction>
				</AlertDialogFooter>
			</AlertDialogContent>
			{cancel.isError ? (
				<Text role="label" tone="error">
					Could not cancel. Open the run to try again.
				</Text>
			) : null}
		</AlertDialog>
	);
}

export function SkillRunTable({
	runs,
	filtered = false,
	statusOnly = filtered,
	page = 1,
	canCancel = false,
}: {
	runs: readonly SkillRunSummary[];
	filtered?: boolean;
	/** The status is the only filter set. */
	statusOnly?: boolean;
	page?: number;
	/** Offer Cancel on a stuck run. */
	canCancel?: boolean;
}) {
	useOsFormattingPreferences();
	if (runs.length === 0)
		return (
			<Empty
				appearance="inline"
				title="No runs to show"
				description={
					page > 1
						? "There are no older runs."
						: !filtered
							? "This skill has not run yet."
							: statusOnly
								? "No runs match this status."
								: "No runs match these filters."
				}
			/>
		);
	const now = new Date();
	return (
		<Table scrollLabel="Skill runs" mobileLayout="stacked">
			<TableHeader>
				<TableRow>
					<TableHead scope="col">Run</TableHead>
					<TableHead scope="col">Started by</TableHead>
					<TableHead scope="col">Started</TableHead>
					<TableHead scope="col">Duration</TableHead>
					<TableHead scope="col">Result</TableHead>
				</TableRow>
			</TableHeader>
			<TableBody>
				{runs.map((run) => {
					const stuck = isStuckSkillRun(run, now);
					const result = skillRunResultLine(run, now);
					const started = run.startedAt
						? normalizeD1Timestamp(run.startedAt)
						: null;
					return (
						<TableRow key={run.id} data-run-id={run.id}>
							<TableCell label="Run">
								<span className="inline-flex flex-wrap items-center gap-2">
									<Link
										variant="record"
										href={`/work/runs/${run.id}`}
										className="inline-flex min-h-11 items-center"
									>
										<RunStatusChip status={run.status} />
									</Link>
									{stuck ? <Badge variant="warning">Stuck</Badge> : null}
								</span>
								{run.skillRevision != null ? (
									<Text role="label" tone="secondary">
										Revision {run.skillRevision}
									</Text>
								) : null}
							</TableCell>
							<TableCell label="Started by">
								{run.trigger ? (
									SKILL_RUN_TRIGGER_LABELS[run.trigger]
								) : (
									<Text as="span" tone="secondary">
										Not recorded
									</Text>
								)}
							</TableCell>
							<TableCell label="Started">
								{started ? (
									<time dateTime={run.startedAt!} title={absoluteTime(started)}>
										{relativeTime(started)}
									</time>
								) : (
									"Not started"
								)}
							</TableCell>
							<TableCell label="Duration" className="tabular-nums">
								{formatDurationBetween(run.startedAt, run.completedAt) ?? "—"}
							</TableCell>
							<TableCell
								label="Result"
								className="max-w-[28rem] whitespace-normal"
							>
								{result ? (
									<Text
										as="span"
										tone={result.tone}
										className="line-clamp-2 break-words"
										title={result.text}
									>
										{result.text}
									</Text>
								) : (
									"—"
								)}
								{stuck && canCancel ? (
									<div className="mt-1">
										<CancelStuckRun runId={run.id} />
									</div>
								) : null}
							</TableCell>
						</TableRow>
					);
				})}
			</TableBody>
		</Table>
	);
}
