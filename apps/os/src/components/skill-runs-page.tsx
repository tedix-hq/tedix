import { useQuery } from "@tanstack/react-query";
import { useParams } from "@tanstack/react-router";
import type { SkillRunSummary } from "@tedix/api-contract/contracts/cognitive";
import { RunStatusChip } from "@/components/activity-runs";
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
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@/components/kumo/table";
import { Text } from "@/components/kumo/text";
import { ListQueryBoundary } from "@/components/list-query-boundary";
import {
	type SkillRunsSearch,
	hasActiveSkillRun,
} from "@/lib/skill-runs-search";
import { skillRunsQueryOptions } from "@/lib/os-query-options";
import { useOsFormattingPreferences } from "@/lib/format";
import { absoluteTime, formatDurationBetween, relativeTime } from "@/lib/time";

const STATUS_OPTIONS = [
	{ value: "all", label: "All" },
	{ value: "queued", label: "Queued" },
	{ value: "running", label: "Running" },
	{ value: "paused", label: "Paused" },
	{ value: "failed", label: "Failed" },
	{ value: "completed", label: "Completed" },
	{ value: "canceled", label: "Canceled" },
] as const;

export function SkillRunsPage({
	search,
	updateSearch,
}: {
	search: SkillRunsSearch;
	updateSearch: (patch: Partial<SkillRunsSearch>) => void;
}) {
	const { skillId } = useParams({ from: "/_session/_tenant/skills/$skillId" });
	const runs = useQuery({
		...skillRunsQueryOptions(skillId, search.status),
		refetchInterval: (query) =>
			hasActiveSkillRun(query.state.data?.runs ?? []) ? 5_000 : false,
	});
	return (
		<PageSection aria-labelledby="skill-run-history-title">
			<SectionHeader>
				<SectionHeading>
					<SectionTitle id="skill-run-history-title">Run history</SectionTitle>
					<SectionDescription>
						Status, revision, start time and duration of each run.
					</SectionDescription>
				</SectionHeading>
			</SectionHeader>
			<SegmentedControl
				ariaLabel="Filter skill runs"
				className="w-full sm:w-fit"
				compact
				value={search.status ?? "all"}
				onValueChange={(value) =>
					updateSearch({
						status:
							value === "all"
								? undefined
								: (value as SkillRunsSearch["status"]),
					})
				}
				options={STATUS_OPTIONS}
			/>
			<ListQueryBoundary query={runs} errorTitle="Runs unavailable" />
			{runs.data ? (
				<SkillRunTable
					runs={runs.data.runs}
					filtered={Boolean(search.status)}
				/>
			) : null}
		</PageSection>
	);
}

export function SkillRunTable({
	runs,
	filtered = false,
}: {
	runs: readonly SkillRunSummary[];
	filtered?: boolean;
}) {
	useOsFormattingPreferences();
	if (runs.length === 0)
		return (
			<Empty
				appearance="inline"
				title="No runs to show"
				description={
					filtered
						? "No runs match this status."
						: "This skill has not run yet."
				}
			/>
		);
	return (
		<Table scrollLabel="Skill runs">
			<TableHeader>
				<TableRow>
					<TableHead scope="col">Run</TableHead>
					<TableHead scope="col">Started</TableHead>
					<TableHead scope="col">Duration</TableHead>
				</TableRow>
			</TableHeader>
			<TableBody>
				{runs.map((run) => (
					<TableRow key={run.id}>
						<TableCell>
							<Link
								variant="record"
								href={`/work/runs/${run.id}`}
								className="inline-flex min-h-11 items-center"
							>
								<RunStatusChip status={run.status} />
							</Link>
							{run.skillRevision != null ? (
								<Text role="label" tone="secondary">
									Revision {run.skillRevision}
								</Text>
							) : null}
						</TableCell>
						<TableCell>
							{run.startedAt ? (
								<time
									dateTime={run.startedAt}
									title={absoluteTime(run.startedAt)}
								>
									{relativeTime(run.startedAt)}
								</time>
							) : (
								"Not started"
							)}
						</TableCell>
						<TableCell className="tabular-nums">
							{formatDurationBetween(run.startedAt, run.completedAt) ?? "—"}
						</TableCell>
					</TableRow>
				))}
			</TableBody>
		</Table>
	);
}
