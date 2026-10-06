import { CaretDown } from "@phosphor-icons/react";
import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "@tanstack/react-router";
import { RunStatusChip } from "@/components/activity-runs";
import { ListSkeleton } from "@/components/list-skeleton";
import { Alert, AlertDescription, AlertTitle } from "@/components/kumo/alert";
import { Badge } from "@/components/kumo/badge";
import { Button } from "@/components/kumo/button";
import {
	Card,
	CardContent,
	CardHeader,
	CardTitle,
} from "@/components/kumo/card";
import {
	Collapsible,
	CollapsibleContent,
	CollapsibleTrigger,
} from "@/components/kumo/collapsible";
import { MetricGrid, MetricItem } from "@/components/kumo/metric-grid";
import { Text } from "@/components/kumo/text";
import { SkillBundleTree } from "@/components/skill-bundle-tree";
import { formatCount } from "@/lib/format";
import {
	skillDetailQueryOptions,
	skillReliabilityQueryOptions,
	skillRunsQueryOptions,
} from "@/lib/os-query-options";
import { formatDurationMs, relativeTime } from "@/lib/time";

export function SkillOverviewPage() {
	const { skillId } = useParams({ from: "/_session/_tenant/skills/$skillId" });
	const detail = useQuery(skillDetailQueryOptions(skillId));
	const reliability = useQuery(skillReliabilityQueryOptions(skillId));
	const runs = useQuery(skillRunsQueryOptions(skillId));
	const skill = detail.data?.entry;
	/*
	 * `return null` collapsed two different states into a blank page: still
	 * loading, and no such skill. A skill id that does not resolve rendered an
	 * empty `main` with no heading, no skeleton and no message. Separate them so each says what it is.
	 */
	if (detail.isPending) return <ListSkeleton rows={6} />;
	if (detail.isError || !skill)
		return (
			<Alert variant="destructive">
				<AlertTitle>Skill unavailable</AlertTitle>
				<AlertDescription>
					{detail.error instanceof Error
						? detail.error.message
						: "This skill could not be loaded. It may have been removed, or the id in the link may be stale."}
				</AlertDescription>
			</Alert>
		);
	const runEvidence = reliability.data;
	const recentRuns = (runs.data?.runs ?? []).slice(0, 5);
	return (
		<div className="grid gap-5">
			<SkillOverviewSummary
				description={skill.description}
				tags={skill.tags ?? []}
				runEvidence={runEvidence}
				reliabilityError={reliability.isError ? reliability.error : null}
				successCount={skill.successCount}
				failureCount={skill.failureCount}
			/>
			<Card>
				<CardHeader className="flex-row items-center justify-between">
					<CardTitle>Recent runs</CardTitle>
					<Button
						variant="ghost"
						size="sm"
						render={<Link to="/skills/$skillId/runs" params={{ skillId }} />}
					>
						View all
					</Button>
				</CardHeader>
				<CardContent>
					{runs.isError ? (
						<Alert variant="destructive">
							<AlertTitle>Runs unavailable</AlertTitle>
							<AlertDescription>
								{(runs.error as Error).message}
							</AlertDescription>
						</Alert>
					) : recentRuns.length === 0 ? (
						<Text role="body" tone="secondary" className="m-0">
							This skill has not run yet.
						</Text>
					) : (
						<ul className="m-0 grid list-none gap-1 p-0">
							{recentRuns.map((run) => (
								<li key={run.id}>
									<Link
										to="/work/runs/$runId"
										params={{ runId: run.id }}
										className="flex items-center gap-3 rounded-lg px-3 py-2 hover:bg-kumo-tint"
									>
										<RunStatusChip status={run.status} />
										<Text as="span" role="body">
											{run.startedAt
												? relativeTime(run.startedAt)
												: "Not started"}
										</Text>
										{run.skillRevision != null ? (
											<Text
												as="span"
												role="label"
												tone="secondary"
												className="ml-auto"
											>
												revision {run.skillRevision}
											</Text>
										) : null}
									</Link>
								</li>
							))}
						</ul>
					)}
				</CardContent>
			</Card>
			<Collapsible>
				<CollapsibleTrigger
					render={<Button variant="ghost" className="w-fit px-0" />}
				>
					<CaretDown size={14} /> Advanced: instructions and source
				</CollapsibleTrigger>
				<CollapsibleContent className="grid gap-4 pt-3">
					<SkillBundleTree content={skill.content} files={skill.files} />
				</CollapsibleContent>
			</Collapsible>
		</div>
	);
}

export function SkillOverviewSummary({
	description,
	tags,
	runEvidence,
	reliabilityError,
	successCount,
	failureCount,
}: {
	description: string | null | undefined;
	tags: string[];
	runEvidence?: {
		runCount: number;
		completedCount: number;
		successRate: number | null;
		averageDurationMs: number | null;
		warnings: string[];
	};
	reliabilityError: unknown;
	successCount: number;
	failureCount: number;
}) {
	return (
		<section aria-label="Skill summary" className="grid gap-4">
			{description || tags.length ? (
				<div className="grid gap-3">
					{description ? (
						<Text role="body" className="m-0 max-w-3xl leading-relaxed">
							{description}
						</Text>
					) : null}
					<div className="flex flex-wrap gap-2">
						{tags.slice(0, 8).map((tag) => (
							<Badge key={tag} variant="secondary">
								{tag}
							</Badge>
						))}
					</div>
				</div>
			) : null}
			{reliabilityError ? (
				<Alert variant="destructive">
					<AlertTitle>Reliability unavailable</AlertTitle>
					<AlertDescription>
						{reliabilityError instanceof Error
							? reliabilityError.message
							: "The evidence projection could not be loaded."}
					</AlertDescription>
				</Alert>
			) : null}
			<MetricGrid aria-label="Skill evidence" columns={2}>
				<MetricItem
					label="Observed reliability"
					value={
						runEvidence && runEvidence.runCount > 0
							? runEvidence.successRate == null
								? "—"
								: `${Math.round(runEvidence.successRate * 100)}%`
							: "No runs yet"
					}
					description={
						<>
							{runEvidence && runEvidence.runCount > 0 ? (
								<>
									{formatCount(runEvidence.completedCount)} of{" "}
									{formatCount(runEvidence.runCount)} sampled runs completed
									{runEvidence.averageDurationMs
										? ` · typically ${formatDurationMs(runEvidence.averageDurationMs)}`
										: ""}
									.
								</>
							) : (
								"Appears after observed execution."
							)}
							{runEvidence?.warnings.length ? (
								<span className="block">{runEvidence.warnings.join(" ")}</span>
							) : null}
						</>
					}
				/>
				<MetricItem
					label="Recorded feedback"
					value={
						successCount + failureCount > 0
							? `${formatCount(successCount)} helpful · ${formatCount(failureCount)} unhelpful`
							: "No feedback yet"
					}
					description="Feedback on the procedure itself."
				/>
			</MetricGrid>
		</section>
	);
}
