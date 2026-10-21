import { CaretDown } from "@phosphor-icons/react";
import { useQuery } from "@tanstack/react-query";
import { Link as RouterLink, useParams } from "@tanstack/react-router";
import { DetailUnavailable } from "@/components/detail-unavailable";
import { ListSkeleton } from "@/components/list-skeleton";
import { Badge } from "@/components/kumo/badge";
import { Button } from "@/components/kumo/button";
import {
	PageSection,
	SectionHeader,
	SectionHeading,
	SectionTitle,
} from "@/components/kumo/page";
import { ListQueryBoundary } from "@/components/list-query-boundary";
import { SkillRunTable } from "@/components/skill-runs-page";
import {
	Collapsible,
	CollapsibleContent,
	CollapsibleTrigger,
} from "@/components/kumo/collapsible";
import { MetricGrid, MetricItem } from "@/components/kumo/metric-grid";
import { Text } from "@/components/kumo/text";
import { SkillBundleTree } from "@/components/skill-bundle-tree";
import { useOsFormattingPreferences, formatCount } from "@/lib/format";
import {
	skillDetailQueryOptions,
	skillReliabilityQueryOptions,
	skillRunsQueryOptions,
} from "@/lib/os-query-options";
import { formatDurationMs } from "@/lib/time";

export function SkillOverviewPage() {
	useOsFormattingPreferences();
	const { skillId } = useParams({ from: "/_session/_tenant/skills/$skillId" });
	const detail = useQuery(skillDetailQueryOptions(skillId));
	const reliability = useQuery(skillReliabilityQueryOptions(skillId));
	const runs = useQuery(skillRunsQueryOptions(skillId));
	const skill = detail.data?.entry;
	if (detail.isPending) return <ListSkeleton rows={6} />;
	if (detail.isError || !skill)
		return <DetailUnavailable resource="Skill" error={detail.error} />;
	const runEvidence = reliability.data;
	const recentRuns = (runs.data?.runs ?? []).slice(0, 5);
	return (
		<PageSection>
			<SkillOverviewSummary
				// The page header already shows the summary (or the description).
				description={
					skill.summary && skill.summary !== skill.description
						? skill.description
						: null
				}
				tags={skill.tags ?? []}
				runEvidence={runEvidence}
				reliabilityError={reliability.isError ? reliability.error : null}
				successCount={skill.successCount}
				failureCount={skill.failureCount}
			/>
			<PageSection aria-labelledby="skill-recent-runs-title">
				<SectionHeader>
					<SectionHeading>
						<SectionTitle id="skill-recent-runs-title">
							Recent runs
						</SectionTitle>
					</SectionHeading>
					<Button
						variant="ghost"
						size="sm"
						render={
							<RouterLink to="/skills/$skillId/runs" params={{ skillId }} />
						}
					>
						View all
					</Button>
				</SectionHeader>
				<ListQueryBoundary query={runs} errorTitle="Runs unavailable" />
				{runs.data ? <SkillRunTable runs={recentRuns} /> : null}
			</PageSection>
			<Collapsible>
				<CollapsibleTrigger
					render={<Button variant="ghost" className="w-fit px-0" />}
				>
					<CaretDown size={14} /> Instructions and source
				</CollapsibleTrigger>
				<CollapsibleContent className="grid gap-4 pt-3">
					<SkillBundleTree content={skill.content} files={skill.files} />
				</CollapsibleContent>
			</Collapsible>
		</PageSection>
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
	useOsFormattingPreferences();
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
			<MetricGrid aria-label="Skill evidence" columns={2}>
				<MetricItem
					label="Observed reliability"
					value={
						reliabilityError
							? "Unavailable"
							: runEvidence && runEvidence.runCount > 0
								? runEvidence.successRate == null
									? "—"
									: `${Math.round(runEvidence.successRate * 100)}%`
								: "No runs yet"
					}
					description={
						reliabilityError ? (
							"Run evidence could not be loaded. Recent runs are listed below."
						) : (
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
									<span className="block">
										{runEvidence.warnings.join(" ")}
									</span>
								) : null}
							</>
						)
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
