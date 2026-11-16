import { useQuery } from "@tanstack/react-query";
import { useParams } from "@tanstack/react-router";
import { useEffect, useReducer, useState } from "react";
import type { SkillSchedule } from "@tedix/api-contract/contracts/cognitive";
import { Badge } from "@/components/kumo/badge";
import { Button } from "@/components/kumo/button";
import {
	Collapsible,
	CollapsibleDefaultContent,
	CollapsibleDefaultTrigger,
} from "@/components/kumo/collapsible";
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
import {
	SkillScheduleDialog,
	scheduleUpdateConfirmation,
	useUpdateSkillSchedule,
} from "@/components/skill-schedule-controls";
import { Text } from "@/components/kumo/text";
import { skillSpecificSchedulesQueryOptions } from "@/lib/os-query-options";
import { osLocale, osTimeZone, useOsFormattingPreferences } from "@/lib/format";
import { inputLabel } from "@/lib/skill-anatomy";
import { scheduleInWords } from "@/lib/skill-schedule-words";
import { absoluteTime, relativeTime } from "@/lib/time";
import { useTediNames } from "@/lib/use-tedi-names";

/** "Period: last_7_days" for each value a scheduled run starts with. */
function startValues(params: SkillSchedule["params"]): string[] {
	return Object.entries(params ?? {}).map(
		([name, value]) =>
			`${inputLabel(name)}: ${typeof value === "string" ? value : JSON.stringify(value)}`,
	);
}

/**
 * When the skill runs on its own. Times read in the person's time zone; the
 * stored expression, which is in UTC, stays behind Technical details.
 */
export function SkillSchedulePage() {
	useOsFormattingPreferences();
	const { skillId } = useParams({ from: "/_session/_tenant/skills/$skillId" });
	const schedules = useQuery(skillSpecificSchedulesQueryOptions(skillId));
	const tediNames = useTediNames();
	const [, tick] = useReducer((value: number) => value + 1, 0);
	const [editing, setEditing] = useState<SkillSchedule | null>(null);
	const [notices, setNotices] = useState<Record<string, string>>({});
	const now = Date.now();
	const timezone =
		osTimeZone() ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
	const inWords = (cron: string, nextFireAt?: string | null) => {
		const next = nextFireAt ? Date.parse(nextFireAt) : Number.NaN;
		// The zone's offset on the day of the next run, so the time stays
		// right across a clock change.
		return scheduleInWords(cron, timezone, {
			reference: new Date(Number.isFinite(next) && next > now ? next : now),
			locale: osLocale(),
		});
	};
	const update = useUpdateSkillSchedule((result) => {
		const cadence = inWords(result.cron, result.nextFireAt).text;
		setNotices((current) => ({
			...current,
			[result.skillId]:
				result.scheduleEnabled && cadence
					? `${result.changed ? "On" : "Already set"}. ${cadence}.${
							result.nextFireAt
								? ` Next run ${absoluteTime(result.nextFireAt)}.`
								: ""
						}`
					: scheduleUpdateConfirmation(result, timezone),
		}));
	});
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
			className="[overflow-wrap:anywhere]"
		>
			<SectionHeader>
				<SectionHeading>
					<SectionTitle id="skill-schedules-title">Schedule</SectionTitle>
					<SectionDescription>
						When this skill runs on its own. Times are in your time zone,{" "}
						{timezone}. Each change is saved as a new version.
					</SectionDescription>
				</SectionHeading>
			</SectionHeader>
			<ListQueryBoundary
				query={schedules}
				errorTitle={
					schedules.data
						? "Could not refresh schedules"
						: "Schedules unavailable"
				}
				errorDescription={
					schedules.data
						? "Showing previously loaded schedules; their status may be out of date."
						: undefined
				}
			/>
			{schedules.data &&
				(schedules.data.schedules.length === 0 ? (
					<Empty appearance="inline">
						<EmptyDescription>
							This skill has no schedule. It runs only when someone starts it.
						</EmptyDescription>
					</Empty>
				) : (
					<Collection>
						{schedules.data.schedules.map((schedule) => {
							const words = inWords(schedule.cron, schedule.nextFireAt);
							const starts = startValues(schedule.params);
							const hasNext =
								Number.isFinite(Date.parse(schedule.nextFireAt)) &&
								Date.parse(schedule.nextFireAt) > now;
							return (
								<li
									key={schedule.id}
									data-schedule-row
									className="grid min-w-0 gap-1.5 px-4 py-3"
								>
									<span className="flex flex-wrap items-center gap-2">
										<Text as="strong" role="body" data-schedule-cadence>
											{words.text ?? "Custom schedule"}
										</Text>
										<Badge variant={schedule.enabled ? "success" : "outline"}>
											{schedule.enabled ? "On" : "Off"}
										</Badge>
									</span>
									<Text as="span" role="label" tone="secondary">
										{!schedule.enabled
											? "Off · no runs planned"
											: hasNext
												? `Next run ${relativeTime(schedule.nextFireAt, new Date(now))} · ${absoluteTime(schedule.nextFireAt)}`
												: "Next run unavailable"}
										{schedule.lastFireAt
											? ` · last ran ${relativeTime(schedule.lastFireAt)}`
											: ""}
									</Text>
									<Text as="span" role="label" tone="secondary">
										Runs as {tediNames[schedule.tediId] ?? "a tedi"}
										{starts.length > 0
											? ` · starts with ${starts.join(", ")}`
											: ""}
									</Text>
									{schedule.lastError ? (
										<Text as="span" role="label" tone="warning">
											Last error: {schedule.lastError}
										</Text>
									) : null}
									{schedule.lastBudgetBlockedAt ? (
										<Text as="span" role="label" tone="warning">
											Held back by the spending limit{" "}
											{relativeTime(schedule.lastBudgetBlockedAt)}
											{schedule.lastBudgetBlockedReason
												? ` · ${schedule.lastBudgetBlockedReason}`
												: ""}
										</Text>
									) : null}
									<span className="flex flex-wrap items-center gap-2">
										<Button
											size="sm"
											variant="outline"
											disabled={update.isPending}
											onClick={() =>
												update.mutate({
													id: schedule.skillId,
													enabled: !schedule.enabled,
												})
											}
										>
											{schedule.enabled ? "Turn off" : "Turn on"}
										</Button>
										<Button
											size="sm"
											variant="outline"
											disabled={update.isPending}
											onClick={() => setEditing(schedule)}
										>
											Change time
										</Button>
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
									</span>
									{notices[schedule.skillId] ? (
										<Text
											as="span"
											role="label"
											tone="secondary"
											className="m-0"
											aria-live="polite"
										>
											{notices[schedule.skillId]}
										</Text>
									) : null}
									<Collapsible>
										<CollapsibleDefaultTrigger>
											Technical details
										</CollapsibleDefaultTrigger>
										<CollapsibleDefaultContent keepMounted>
											<ul className="m-0 grid min-w-0 list-none gap-0.5 px-2 pt-1 pb-2">
												{[
													`Stored schedule (UTC): ${schedule.cron}`,
													...(schedule.lastBudgetAdmissionClass
														? [
																`Spending class: ${schedule.lastBudgetAdmissionClass.replace(/_/g, " ")}`,
															]
														: []),
													...(starts.length > 0
														? [
																`Start values: ${JSON.stringify(schedule.params)}`,
															]
														: []),
													`Schedule id: ${schedule.id}`,
												].map((line) => (
													<li key={line}>
														<Text
															role="label"
															tone="mono-secondary"
															className="m-0 wrap-anywhere"
														>
															{line}
														</Text>
													</li>
												))}
											</ul>
										</CollapsibleDefaultContent>
									</Collapsible>
								</li>
							);
						})}
					</Collection>
				))}
			{update.isError ? (
				<p className="m-0 px-4 text-kumo-danger text-sm" role="alert">
					{(update.error as Error).message}
				</p>
			) : null}
			{editing ? (
				<SkillScheduleDialog
					schedule={editing}
					timeZone={timezone}
					close={() => setEditing(null)}
				/>
			) : null}
		</PageSection>
	);
}
