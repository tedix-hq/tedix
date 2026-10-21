import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "@tanstack/react-router";
import { useEffect, useReducer } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/kumo/alert";
import { Badge } from "@/components/kumo/badge";
import { Button } from "@/components/kumo/button";
import { Card, CardContent } from "@/components/kumo/card";
import { Collection } from "@/components/kumo/page";
import { ListSkeleton } from "@/components/list-skeleton";
import { Text } from "@/components/kumo/text";
import { skillSpecificSchedulesQueryOptions } from "@/lib/os-query-options";
import { osTimeZone, useOsFormattingPreferences } from "@/lib/format";
import { absoluteTime, relativeTime } from "@/lib/time";
import { useTediNames } from "@/lib/use-tedi-names";

export function SkillSchedulePage() {
	useOsFormattingPreferences();
	const { skillId } = useParams({ from: "/_session/_tenant/skills/$skillId" });
	const schedules = useQuery(skillSpecificSchedulesQueryOptions(skillId));
	const tediNames = useTediNames();
	const [, tick] = useReducer((value: number) => value + 1, 0);
	const now = Date.now();
	const timezone =
		osTimeZone() ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
	useEffect(() => {
		const next = Math.min(
			...(schedules.data?.schedules ?? [])
				.filter((schedule) => schedule.enabled)
				.map((schedule) => Date.parse(schedule.nextFireAt))
				.filter((time) => Number.isFinite(time) && time > now),
		);
		if (!Number.isFinite(next)) return;
		const timer = setTimeout(tick, Math.min(next - now, 2_147_483_647));
		return () => clearTimeout(timer);
	}, [schedules.data, now]);
	return (
		<div className="grid min-w-0 gap-4 [overflow-wrap:anywhere]">
			<Text role="body" tone="secondary" className="m-0">
				Canonical manifest-owned schedules for this skill. This view is
				read-only; schedule changes come from a new skill revision.
			</Text>
			<Text role="label" tone="secondary" className="m-0">
				Cron timezone: UTC · Timestamps: {timezone}
			</Text>
			{schedules.isPending ? <ListSkeleton /> : null}
			{schedules.isError ? (
				<Alert variant="destructive">
					<AlertTitle>
						{schedules.data
							? "Could not refresh schedules"
							: "Schedules unavailable"}
					</AlertTitle>
					<AlertDescription>
						{schedules.data
							? "Showing previously loaded schedules; their status may be out of date. "
							: ""}
						{(schedules.error as Error).message}
						<Button
							variant="outline"
							className="mt-3 min-h-11 min-w-11"
							disabled={schedules.isFetching}
							onClick={() => void schedules.refetch()}
						>
							{schedules.isFetching ? "Retrying…" : "Retry schedules"}
						</Button>
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
									<li
										key={schedule.id}
										className="grid min-w-0 gap-1 px-4 py-3"
									>
										<span className="flex flex-wrap items-center gap-2">
											<Text as="strong" role="body">
												{schedule.cron}
											</Text>
											<Badge variant={schedule.enabled ? "success" : "outline"}>
												{schedule.enabled ? "Enabled" : "Paused"}
											</Badge>
											<Text as="span" role="label" tone="secondary">
												{tediNames[schedule.tediId] ?? "tedi"}
											</Text>
										</span>
										<Text as="span" role="label" tone="secondary">
											{!schedule.enabled
												? "Paused · not scheduled"
												: Number.isFinite(Date.parse(schedule.nextFireAt)) &&
													  Date.parse(schedule.nextFireAt) > now
													? `Next run ${relativeTime(schedule.nextFireAt, new Date(now))} · ${absoluteTime(schedule.nextFireAt)}`
													: "Next run unavailable"}
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
												className="flex min-h-11 min-w-11 w-fit items-center text-xs underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
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
