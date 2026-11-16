/**
 * Console controls for a manifest-owned skill schedule: turn it off and on,
 * and change when it fires. Both write through `skills.updateSchedule`,
 * which records one skill revision per change — the manifest and the
 * scheduler row cannot drift apart.
 */
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { SkillSchedule } from "@tedix/api-contract/contracts/cognitive";
import { useState } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/kumo/alert";
import { Button } from "@/components/kumo/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/kumo/dialog";
import { Input } from "@/components/kumo/input";
import { Label } from "@/components/kumo/label";
import { Text } from "@/components/kumo/text";
import { osApi } from "@/lib/api";
import { osLocale } from "@/lib/format";
import { osQueryKeys } from "@/lib/os-query-options";
import {
	cronAtLocalTime,
	scheduleInWords,
	scheduleLocalTime,
} from "@/lib/skill-schedule-words";
import { absoluteTime } from "@/lib/time";
import { cronToHuman } from "@/components/triggers-panel";

export type SkillScheduleUpdateResult = {
	skillId: string;
	cron: string;
	scheduleEnabled: boolean;
	changed: boolean;
	nextFireAt: string | null;
};

/** `skills.updateSchedule` with schedule/skill reads invalidated on settle. */
export function useUpdateSkillSchedule(
	onSuccess?: (result: SkillScheduleUpdateResult) => void,
) {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (input: { id: string; cron?: string; enabled?: boolean }) =>
			osApi.skills.updateSchedule(input),
		onSuccess: (result) => onSuccess?.(result),
		onSettled: () => {
			void queryClient.invalidateQueries({
				queryKey: osQueryKeys.skillSchedules(),
			});
			void queryClient.invalidateQueries({ queryKey: osQueryKeys.skills() });
		},
	});
}

/** The single fixed time-of-day a cron pins, when it pins one. */
export function cronFixedTime(
	cron: string,
): { hour: number; minute: number } | null {
	const fields = cron.trim().split(/\s+/);
	if (fields.length !== 5) return null;
	const [minute, hour] = fields;
	if (!/^\d+$/.test(minute!) || !/^\d+$/.test(hour!)) return null;
	const m = Number(minute);
	const h = Number(hour);
	return m <= 59 && h <= 23 ? { hour: h, minute: m } : null;
}

/** Swap only the minute and hour fields; the day pattern is preserved. */
export function retimedCron(
	cron: string,
	hour: number,
	minute: number,
): string {
	const fields = cron.trim().split(/\s+/);
	fields[0] = String(minute);
	fields[1] = String(hour);
	return fields.join(" ");
}

/** Plain-English confirmation for the status line under a schedule row. */
export function scheduleUpdateConfirmation(
	result: SkillScheduleUpdateResult,
	timezone: string,
): string {
	const cadence = `${cronToHuman(result.cron)} (UTC)`;
	if (!result.scheduleEnabled) {
		return result.changed
			? "Off — it will not run again until you turn it back on."
			: "Already off — it was not running.";
	}
	const next = result.nextFireAt
		? ` Next run ${absoluteTime(result.nextFireAt)} (${timezone}).`
		: "";
	return result.changed
		? `On — runs ${cadence}.${next}`
		: `Already set — it runs ${cadence}.${next}`;
}

const pad = (value: number) => String(value).padStart(2, "0");

/**
 * "Change time" dialog. Crons that pin one time of day get a time picker
 * that keeps the day pattern; every other shape edits the raw five-field
 * UTC expression, and the API remains the validator.
 */
export function SkillScheduleDialog({
	schedule,
	timeZone,
	close,
}: {
	schedule: SkillSchedule;
	/**
	 * The person's time zone. With it, a schedule that runs at one time on
	 * every day or on named weekdays is read and set as a local time.
	 */
	timeZone?: string;
	close: () => void;
}) {
	const fixed = cronFixedTime(schedule.cron);
	// The zone's offset on the day of the next run, fixed while the dialog is
	// open so the time typed and the time saved agree.
	const [reference] = useState(() => {
		const next = Date.parse(schedule.nextFireAt);
		return new Date(
			Number.isFinite(next) && next > Date.now() ? next : Date.now(),
		);
	});
	const localTime = timeZone
		? scheduleLocalTime(schedule.cron, timeZone, reference)
		: null;
	const inWords = (value: string) =>
		(timeZone
			? scheduleInWords(value, timeZone, { reference, locale: osLocale() }).text
			: null) ?? `Runs ${cronToHuman(value)} (UTC)`;
	const [time, setTime] = useState(
		() =>
			localTime ??
			(fixed ? `${pad(fixed.hour)}:${pad(fixed.minute)}` : "09:00"),
	);
	const [cron, setCron] = useState(schedule.cron);
	const update = useUpdateSkillSchedule(close);
	const draft = (() => {
		if (!fixed) return cron.trim();
		if (timeZone && localTime !== null)
			return (
				cronAtLocalTime(schedule.cron, time, timeZone, reference) ??
				schedule.cron
			);
		const [hour, minute] = time.split(":").map(Number);
		return retimedCron(schedule.cron, hour ?? 0, minute ?? 0);
	})();
	// A cleared time input parses as 00:00; require a value rather than
	// silently retiming to midnight.
	const timeMissing = fixed !== null && time.trim() === "";
	const submit = () => {
		if (update.isPending || timeMissing) return;
		if (draft === schedule.cron) close();
		else update.mutate({ id: schedule.skillId, cron: draft });
	};
	return (
		<Dialog
			open
			onOpenChange={(open) => {
				if (!open && !update.isPending) close();
			}}
		>
			<DialogContent showCloseButton={!update.isPending}>
				<DialogHeader>
					<DialogTitle>Change schedule</DialogTitle>
					<DialogDescription>
						{localTime !== null && timeZone
							? `It currently runs ${inWords(schedule.cron).replace(/^E/, "e")}, in your time zone (${timeZone}). The change is saved as a new version of the skill.`
							: `It currently runs ${cronToHuman(schedule.cron)} (UTC). The change is saved as a new revision of the skill.`}
					</DialogDescription>
				</DialogHeader>
				<form
					className="grid gap-4"
					onSubmit={(event) => {
						event.preventDefault();
						submit();
					}}
				>
					{fixed ? (
						<div className="grid gap-2">
							<Label htmlFor="schedule-time">
								{localTime !== null ? "Time" : "Time (UTC)"}
							</Label>
							<Input
								id="schedule-time"
								type="time"
								value={time}
								onChange={(event) => setTime(event.target.value)}
								disabled={update.isPending}
								autoFocus
							/>
							<Text role="label" tone="secondary">
								{localTime !== null
									? timeMissing
										? "Enter a time."
										: `${inWords(draft)}.`
									: `Runs ${cronToHuman(draft)} (UTC)`}
							</Text>
						</div>
					) : (
						<div className="grid gap-2">
							<Label htmlFor="schedule-cron">Schedule (UTC)</Label>
							<Input
								id="schedule-cron"
								value={cron}
								onChange={(event) => setCron(event.target.value)}
								placeholder="0 9 * * 1"
								disabled={update.isPending}
								autoFocus
							/>
							<Text role="label" tone="secondary">
								Five fields: minute, hour, day of month, month, weekday — e.g.{" "}
								<code>0 9 * * 1-5</code> for weekdays at 9 AM.
							</Text>
						</div>
					)}
					{update.isError && (
						<Alert variant="destructive">
							<AlertTitle>Schedule not updated</AlertTitle>
							<AlertDescription>
								{(update.error as Error).message}
							</AlertDescription>
						</Alert>
					)}
					<DialogFooter>
						<Button
							type="button"
							variant="outline"
							disabled={update.isPending}
							onClick={close}
						>
							Cancel
						</Button>
						<Button type="submit" disabled={update.isPending || timeMissing}>
							{update.isPending ? "Saving…" : "Save"}
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}
