import { useQuery } from "@tanstack/react-query";
import { useParams } from "@tanstack/react-router";
import { useEffect, useReducer } from "react";
import { Badge } from "@/components/kumo/badge";
import { Link } from "@/components/kumo/link";
import {
	Collection,
	PageSection,
	SectionHeader,
	SectionHeading,
	SectionTitle,
	SectionDescription,
} from "@/components/kumo/page";
import { Empty, EmptyDescription } from "@/components/kumo/empty";
import { ListQueryBoundary } from "@/components/list-query-boundary";
import { errorMessage } from "@/lib/orpc-error";
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
		<PageSection
			aria-labelledby="skill-schedules-title"
			className="[overflow-wrap:anywhere] [&_button]:min-h-11 [&_button]:min-w-11"
		>
			<SectionHeader>
				<SectionHeading>
					<SectionTitle id="skill-schedules-title">Schedule</SectionTitle>
					<SectionDescription>
						Schedules defined by this skill. To change them, publish a new
						revision.
					</SectionDescription>
				</SectionHeading>
			</SectionHeader>
			<Text role="label" tone="secondary" className="m-0">
				Cron timezone: UTC · Timestamps: {timezone}
			</Text>
			<ListQueryBoundary
				query={schedules}
				errorTitle={
					schedules.data
						? "Could not refresh schedules"
						: "Schedules unavailable"
				}
				errorDescription={
					schedules.data
						? `Showing previously loaded schedules; their status may be out of date. ${errorMessage(schedules.error, "Schedules could not be read.")}`
						: undefined
				}
			/>
			{schedules.data &&
				(schedules.data.schedules.length === 0 ? (
					<Empty appearance="inline">
						<EmptyDescription>
							This skill declares no schedules.
						</EmptyDescription>
					</Empty>
				) : (
					<Collection>
						{schedules.data.schedules.map((schedule) => (
							<li key={schedule.id} className="grid min-w-0 gap-1 px-4 py-3">
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
								</Text>
								{schedule.lastError ? (
									<Text as="span" role="label" tone="warning">
										Last error: {schedule.lastError}
									</Text>
								) : null}
								{schedule.lastBudgetBlockedAt ? (
									<Text as="span" role="label" tone="warning">
										Budget blocked {relativeTime(schedule.lastBudgetBlockedAt)}
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
										href={`/work/runs/${schedule.lastRunId}`}
										variant="inline"
										className="flex min-h-11 min-w-11 w-fit items-center"
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
				))}
		</PageSection>
	);
}
