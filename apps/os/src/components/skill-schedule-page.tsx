import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "@tanstack/react-router";
import { Alert, AlertDescription, AlertTitle } from "@/components/kumo/alert";
import { Badge } from "@/components/kumo/badge";
import { Card, CardContent } from "@/components/kumo/card";
import { Collection } from "@/components/kumo/page";
import { ListSkeleton } from "@/components/list-skeleton";
import { Text } from "@/components/kumo/text";
import { skillSpecificSchedulesQueryOptions } from "@/lib/os-query-options";
import { absoluteTime, relativeTime } from "@/lib/time";
import { useTediNames } from "@/lib/use-tedi-names";

export function SkillSchedulePage() {
	const { skillId } = useParams({ from: "/_session/_tenant/skills/$skillId" });
	const schedules = useQuery(skillSpecificSchedulesQueryOptions(skillId));
	const tediNames = useTediNames();
	return (
		<div className="grid gap-4">
			<Text role="body" tone="secondary" className="m-0">
				Canonical manifest-owned schedules for this skill. This view is
				read-only; schedule changes come from a new governed skill revision.
			</Text>
			{schedules.isPending ? <ListSkeleton /> : null}
			{schedules.isError ? (
				<Alert variant="destructive">
					<AlertTitle>Schedules unavailable</AlertTitle>
					<AlertDescription>
						{(schedules.error as Error).message}
					</AlertDescription>
				</Alert>
			) : null}
			{schedules.data ? (
				<Card>
					<CardContent className="p-0">
						{schedules.data.schedules.length === 0 ? (
							<Text role="body" tone="secondary" className="m-0 p-6">
								This skill declares no schedules.
							</Text>
						) : (
							<Collection appearance="inline">
								{schedules.data.schedules.map((schedule) => (
									<li key={schedule.id} className="grid gap-1 px-4 py-3">
										<span className="flex flex-wrap items-center gap-2">
											<Text as="strong" role="body">
												{schedule.cron}
											</Text>
											<Badge variant={schedule.enabled ? "success" : "outline"}>
												{schedule.enabled ? "Enabled" : "Disabled"}
											</Badge>
											<Text as="span" role="label" tone="secondary">
												{tediNames[schedule.tediId] ?? "tedi"}
											</Text>
										</span>
										<Text as="span" role="label" tone="secondary">
											Next fire {relativeTime(schedule.nextFireAt)}
											{schedule.lastFireAt
												? ` · last fired ${relativeTime(schedule.lastFireAt)}`
												: ""}
											{schedule.lastError
												? ` · last error: ${schedule.lastError}`
												: ""}
										</Text>
										{schedule.lastBudgetBlockedAt ? (
											<Text as="span" role="label" tone="warning">
												Budget blocked{" "}
												{relativeTime(schedule.lastBudgetBlockedAt)}
												{schedule.lastBudgetAdmissionClass
													? ` · ${schedule.lastBudgetAdmissionClass.replace(/_/g, " ")}`
													: ""}
												{schedule.lastBudgetBlockedReason
													? ` · ${schedule.lastBudgetBlockedReason}`
													: ""}
											</Text>
										) : null}
										{schedule.lastRunId ? (
											<Link
												to="/work/runs/$runId"
												params={{ runId: schedule.lastRunId }}
												className="w-fit text-xs underline"
												title={
													schedule.lastFireAt
														? absoluteTime(schedule.lastFireAt)
														: undefined
												}
											>
												Open latest run
											</Link>
										) : null}
									</li>
								))}
							</Collection>
						)}
					</CardContent>
				</Card>
			) : null}
		</div>
	);
}
