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
		return (
			<DetailUnavailable
				resource="Skill"
				error={detail.error}
				onRetry={() => detail.refetch()}
				retrying={detail.isFetching}
			/>
		);
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
				reliability={reliability}
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
				<ListQueryBoundary
					query={runs}
					errorTitle={runs.data ? "Could not refresh runs" : "Runs unavailable"}
					errorDescription={
						runs.data
							? "Showing previously loaded runs; their status may be out of date."
							: undefined
					}
				/>
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

type SkillRunEvidence = {
	runCount: number;
	completedCount: number;
	successRate: number | null;
	averageDurationMs: number | null;
	warnings: string[];
};

export type SkillReliabilityRead = {
	isPending: boolean;
	isError: boolean;
	isFetching: boolean;
	error: unknown;
	data?: SkillRunEvidence;
	refetch: () => Promise<unknown>;
};

/*
 * A read-only retry affordance for a failed evidence read — the same "Retry"
 * control ListQueryBoundary renders for list reads, kept small enough
 * to sit inside a metric's description slot.
 */
function EvidenceRetry({ query }: { query: SkillReliabilityRead }) {
	return (
		<Button
			variant="outline"
			size="sm"
			className="mt-2 w-fit"
			disabled={query.isFetching}
			onClick={() => void query.refetch()}
		>
			{query.isFetching ? "Trying again…" : "Retry"}
		</Button>
	);
}

export function SkillOverviewSummary({
	description,
	tags,
	reliability,
	successCount,
	failureCount,
}: {
	description: string | null | undefined;
	tags: string[];
	reliability: SkillReliabilityRead;
	successCount: number;
	failureCount: number;
}) {
	useOsFormattingPreferences();
	const evidence = reliability.data;
	/*
	 * React Query keeps `data` when a background refetch fails, so an error
	 * with evidence is a stale-read warning, not an outage. Only a cold
	 * failure — no evidence at all — is "Unavailable", and a pending read is
	 * explicitly "being read": neither may claim there are no executions.
	 */
	const coldError = reliability.isError && !evidence;
	const refreshError = reliability.isError && Boolean(evidence);
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
						coldError
							? "Unavailable"
							: reliability.isPending
								? "Reading…"
								: evidence && evidence.runCount > 0
									? evidence.successRate == null
										? "—"
										: `${Math.round(evidence.successRate * 100)}%`
									: "No runs yet"
					}
					description={
						coldError ? (
							<>
								Run evidence could not be loaded. Recent runs are listed below.
								<EvidenceRetry query={reliability} />
							</>
						) : reliability.isPending ? (
							"Run evidence is being read."
						) : (
							<>
								{evidence && evidence.runCount > 0 ? (
									<>
										{formatCount(evidence.completedCount)} of{" "}
										{formatCount(evidence.runCount)} sampled runs completed
										{evidence.averageDurationMs
											? ` · typically ${formatDurationMs(evidence.averageDurationMs)}`
											: ""}
										.
									</>
								) : (
									"Appears after observed execution."
								)}
								{evidence?.warnings.length ? (
									<span className="block">{evidence.warnings.join(" ")}</span>
								) : null}
								{refreshError ? (
									<>
										<span className="block" role="status">
											Could not refresh run evidence; the figures shown may be
											out of date.
										</span>
										<EvidenceRetry query={reliability} />
									</>
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
