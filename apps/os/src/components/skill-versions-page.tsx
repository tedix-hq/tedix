import { useQuery } from "@tanstack/react-query";
import { useParams } from "@tanstack/react-router";
import { Alert, AlertDescription, AlertTitle } from "@/components/kumo/alert";
import { Badge } from "@/components/kumo/badge";
import { Button } from "@/components/kumo/button";
import { Card, CardContent } from "@/components/kumo/card";
import { Collection } from "@/components/kumo/page";
import {
	Collapsible,
	CollapsibleContent,
	CollapsibleTrigger,
} from "@/components/kumo/collapsible";
import { ListSkeleton } from "@/components/list-skeleton";
import { Text } from "@/components/kumo/text";
import {
	skillDetailQueryOptions,
	skillRevisionsQueryOptions,
} from "@/lib/os-query-options";
import { formatCount } from "@/lib/format";
import { relativeTime } from "@/lib/time";

export function SkillVersionsPage() {
	const { skillId } = useParams({ from: "/_session/_tenant/skills/$skillId" });
	const detail = useQuery(skillDetailQueryOptions(skillId));
	const revisions = useQuery(skillRevisionsQueryOptions(skillId));
	const sorted = [...(revisions.data?.revisions ?? [])].sort(
		(a, b) => (b.revision ?? 0) - (a.revision ?? 0),
	);
	return (
		<div className="grid gap-4">
			<Text role="body" tone="secondary" className="m-0">
				Observed executed revisions only. Edits that never ran do not appear.
			</Text>
			{revisions.data ? (
				<Text role="label" tone="secondary" className="m-0">
					Evidence sampled {formatCount(revisions.data.sampledRunCount)} runs
					{revisions.data.mayBeTruncated
						? " · the bounded sample may omit older executions"
						: " · complete within the requested bound"}
					.
				</Text>
			) : null}
			{revisions.isPending ? <ListSkeleton /> : null}
			{revisions.isError ? (
				<Alert variant="destructive">
					<AlertTitle>Versions unavailable</AlertTitle>
					<AlertDescription>
						{(revisions.error as Error).message}
					</AlertDescription>
				</Alert>
			) : null}
			{revisions.data ? (
				<Card>
					<CardContent className="p-0">
						{sorted.length === 0 ? (
							<Text role="body" tone="secondary" className="m-0 p-6">
								No revisions have observed execution yet.
							</Text>
						) : (
							<Collection appearance="inline">
								{sorted.map((revision) => {
									const current =
										revision.revision === detail.data?.entry?.revision;
									return (
										<li key={revision.runId} className="grid gap-1 px-4 py-3">
											<span className="flex items-center gap-2">
												<Text as="strong" role="body">
													Revision {revision.revision ?? "unknown"}
												</Text>
												{current ? (
													<Badge variant="secondary">Current</Badge>
												) : null}
											</span>
											<Text as="span" role="label" tone="secondary">
												Observed {formatCount(revision.observedRunCount)} times
												· {formatCount(revision.completedCount)} completed ·{" "}
												{formatCount(revision.failedCount)} failed ·{" "}
												{formatCount(revision.canceledCount)} canceled
												{revision.lastObservedAt
													? ` · last ${relativeTime(revision.lastObservedAt)}`
													: ""}
											</Text>
											{current && detail.data?.entry?.revisionReasoning ? (
												<Text
													role="label"
													className="m-0 mt-1 rounded-lg bg-kumo-tint p-3"
												>
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
													<Text as="span" role="label" tone="secondary">
														Workflow SHA-256:{" "}
														{revision.workflowSourceSha256 ?? "not recorded"}
													</Text>
													<Text as="span" role="label" tone="secondary">
														SKILL.md SHA-256:{" "}
														{revision.skillDocSha256 ?? "not recorded"}
													</Text>
													<Text as="span" role="label" tone="secondary">
														Worker:{" "}
														{revision.workerVersionTag ??
															revision.workerVersionId ??
															"legacy / not recorded"}{" "}
														· compatibility{" "}
														{revision.executionCompatibilityHash ??
															"not recorded"}
													</Text>
													<Text as="span" role="label" tone="secondary">
														Runtime variants: {revision.runtimeVariants.length}{" "}
														· drift{" "}
														{revision.runtimeDriftBlocked
															? "blocked"
															: revision.runtimeDriftObserved
																? "observed"
																: "not observed"}
													</Text>
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
										</li>
									);
								})}
							</Collection>
						)}
					</CardContent>
				</Card>
			) : null}
		</div>
	);
}
