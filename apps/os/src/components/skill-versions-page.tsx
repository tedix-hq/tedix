import { useQuery } from "@tanstack/react-query";
import { useParams } from "@tanstack/react-router";
import { Badge } from "@/components/kumo/badge";
import { Button } from "@/components/kumo/button";
import { Empty, EmptyDescription } from "@/components/kumo/empty";
import {
	PageSection,
	SectionHeader,
	SectionHeading,
	SectionTitle,
	SectionDescription,
} from "@/components/kumo/page";
import {
	Collapsible,
	CollapsibleContent,
	CollapsibleTrigger,
} from "@/components/kumo/collapsible";
import { ListQueryBoundary } from "@/components/list-query-boundary";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@/components/kumo/table";
import { Text } from "@/components/kumo/text";
import {
	skillDetailQueryOptions,
	skillRevisionsQueryOptions,
} from "@/lib/os-query-options";
import { useOsFormattingPreferences, formatCount } from "@/lib/format";
import { absoluteTime, relativeTime } from "@/lib/time";

export function SkillVersionsPage() {
	useOsFormattingPreferences();
	const { skillId } = useParams({ from: "/_session/_tenant/skills/$skillId" });
	const detail = useQuery(skillDetailQueryOptions(skillId));
	const revisions = useQuery(skillRevisionsQueryOptions(skillId));
	const sorted = [...(revisions.data?.revisions ?? [])].sort(
		(a, b) => (b.revision ?? 0) - (a.revision ?? 0),
	);
	return (
		<PageSection
			aria-labelledby="skill-versions-title"
			className="[overflow-wrap:anywhere]"
		>
			<SectionHeader>
				<SectionHeading>
					<SectionTitle id="skill-versions-title">Versions</SectionTitle>
					<SectionDescription>
						Versions that have run. Edits that never ran do not appear.
					</SectionDescription>
				</SectionHeading>
			</SectionHeader>
			{revisions.data ? (
				<Text role="label" tone="secondary" className="m-0">
					Based on {formatCount(revisions.data.sampledRunCount)} runs
					{revisions.data.mayBeTruncated
						? " · this sample may omit older executions"
						: " · all runs in this sample"}
					.
				</Text>
			) : null}
			<ListQueryBoundary query={revisions} errorTitle="Versions unavailable" />
			{revisions.data &&
				(sorted.length === 0 ? (
					<Empty appearance="inline">
						<EmptyDescription>No versions have run yet.</EmptyDescription>
					</Empty>
				) : (
					<Table scrollLabel="Skill versions" className="table-fixed">
						<TableHeader>
							<TableRow>
								<TableHead scope="col" className="w-28 sm:w-40">
									Version
								</TableHead>
								<TableHead scope="col">Run evidence</TableHead>
							</TableRow>
						</TableHeader>
						<TableBody>
							{sorted.map((revision) => {
								const current =
									revision.revision === detail.data?.entry?.revision;
								return (
									<TableRow key={revision.runId}>
										<TableCell className="whitespace-normal align-top">
											<span className="flex flex-wrap items-center gap-2">
												<Text as="strong" role="body">
													Revision {revision.revision ?? "unknown"}
												</Text>
												{current ? (
													<Badge variant="secondary">Current</Badge>
												) : null}
											</span>
										</TableCell>
										<TableCell className="whitespace-normal align-top space-y-1">
											<Text as="span" role="label" tone="secondary">
												Observed {formatCount(revision.observedRunCount)} times
												· {formatCount(revision.completedCount)} completed ·{" "}
												{formatCount(revision.failedCount)} failed ·{" "}
												{formatCount(revision.canceledCount)} canceled
												{revision.lastObservedAt ? (
													<>
														{" "}
														· last{" "}
														<time
															dateTime={revision.lastObservedAt}
															title={absoluteTime(revision.lastObservedAt)}
														>
															{relativeTime(revision.lastObservedAt)}
														</time>
													</>
												) : null}
											</Text>
											{current && detail.data?.entry?.revisionReasoning ? (
												<Text role="label" className="m-0">
													<strong>What changed: </strong>
													{detail.data.entry.revisionReasoning}
												</Text>
											) : null}
											<Collapsible>
												<CollapsibleTrigger
													render={
														<Button
															size="sm"
															variant="ghost"
															className="w-fit px-0"
														/>
													}
												>
													Technical evidence
												</CollapsibleTrigger>
												<CollapsibleContent className="grid gap-1 pb-2">
													{[
														[
															"Workflow SHA-256",
															revision.workflowSourceSha256 ?? "not recorded",
														],
														[
															"SKILL.md SHA-256",
															revision.skillDocSha256 ?? "not recorded",
														],
														[
															"Worker",
															`${revision.workerVersionTag ?? revision.workerVersionId ?? "legacy / not recorded"} · compatibility ${revision.executionCompatibilityHash ?? "not recorded"}`,
														],
														[
															"Runtime variants",
															`${revision.runtimeVariants.length} · drift ${revision.runtimeDriftBlocked ? "blocked" : revision.runtimeDriftObserved ? "observed" : "not observed"}`,
														],
													].map(([label, value]) => (
														<Text
															as="span"
															role="label"
															tone="secondary"
															key={label}
														>
															{label}: {value}
														</Text>
													))}
													{revision.runtimeVariants.map((variant) => (
														<Text
															as="span"
															role="label"
															tone="secondary"
															key={`${variant.runId}:${variant.executionEpoch}:${variant.manifestPath}`}
														>
															{variant.observation} · epoch{" "}
															{variant.executionEpoch} · {variant.manifestPath}{" "}
															·{" "}
															{variant.workerVersionTag ??
																variant.workerVersionId ??
																"worker unknown"}
														</Text>
													))}
												</CollapsibleContent>
											</Collapsible>
										</TableCell>
									</TableRow>
								);
							})}
						</TableBody>
					</Table>
				))}
		</PageSection>
	);
}
