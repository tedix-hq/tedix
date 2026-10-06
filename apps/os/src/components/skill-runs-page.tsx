import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "@tanstack/react-router";
import { RunStatusChip } from "@/components/activity-runs";
import { Alert, AlertDescription, AlertTitle } from "@/components/kumo/alert";
import { Card, CardContent } from "@/components/kumo/card";
import {
	Empty,
	EmptyDescription,
	EmptyHeader,
	EmptyTitle,
} from "@/components/kumo/empty";
import {
	Collection,
	PageSection,
	SectionDescription,
	SectionHeader,
	SectionHeading,
	SectionTitle,
} from "@/components/kumo/page";
import { SegmentedControl } from "@/components/kumo/segmented-control";
import { Text } from "@/components/kumo/text";
import { ListSkeleton } from "@/components/list-skeleton";
import {
	type SkillRunsSearch,
	hasActiveSkillRun,
} from "@/lib/skill-runs-search";
import { skillRunsQueryOptions } from "@/lib/os-query-options";
import { formatDurationBetween, relativeTime } from "@/lib/time";

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
						Inspect execution status, revision, start time, and duration.
					</SectionDescription>
				</SectionHeading>
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
			</SectionHeader>
			{runs.isPending ? <ListSkeleton /> : null}
			{runs.isError ? (
				<Alert variant="destructive">
					<AlertTitle>Runs unavailable</AlertTitle>
					<AlertDescription>{(runs.error as Error).message}</AlertDescription>
				</Alert>
			) : null}
			{runs.data ? (
				<Card className="gap-0 overflow-hidden py-0">
					<CardContent className="p-0">
						{runs.data.runs.length === 0 ? (
							<Empty appearance="inline">
								<EmptyHeader>
									<EmptyTitle>No runs to show</EmptyTitle>
									<EmptyDescription>
										{search.status
											? "No runs match this status."
											: "This skill has not run yet."}
									</EmptyDescription>
								</EmptyHeader>
							</Empty>
						) : (
							<Collection appearance="inline">
								{runs.data.runs.map((run) => (
									<li key={run.id}>
										<Link
											to="/work/runs/$runId"
											params={{ runId: run.id }}
											className="grid min-h-14 min-w-0 grid-cols-[auto_minmax(0,1fr)] items-center gap-x-3 gap-y-1 px-4 py-3 text-inherit no-underline transition-colors hover:bg-kumo-tint sm:grid-cols-[auto_minmax(0,1fr)_auto]"
										>
											<RunStatusChip status={run.status} />
											<Text as="span" role="body" className="min-w-0 truncate">
												{run.startedAt
													? relativeTime(run.startedAt)
													: "Not started"}
											</Text>
											<Text
												as="span"
												role="label"
												tone="secondary"
												className="col-start-2 tabular-nums sm:col-start-auto sm:ml-auto"
											>
												{run.skillRevision != null
													? `revision ${run.skillRevision} · `
													: ""}
												{formatDurationBetween(
													run.startedAt,
													run.completedAt,
												) ?? "—"}
											</Text>
										</Link>
									</li>
								))}
							</Collection>
						)}
					</CardContent>
				</Card>
			) : null}
		</PageSection>
	);
}
