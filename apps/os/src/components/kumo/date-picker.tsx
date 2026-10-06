import { DatePicker as KumoDatePicker } from "@cloudflare/kumo/components/date-picker";
import { CalendarBlankIcon, XIcon } from "@phosphor-icons/react";
import { useState } from "react";

import { Button } from "@/components/kumo/button";
import { Input } from "@/components/kumo/input";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@/components/kumo/popover";
import { absoluteTime } from "@/lib/time";
import { cn } from "@/lib/utils";

/**
 * Kumo's date surface, plus the composed datetime control OS actually needs.
 *
 * `DatePicker` is Kumo's react-day-picker calendar with the OS type roles
 * applied. It is **date-only**: Kumo ships no time component at all (the
 * package registry lists `DatePicker` and the deprecated `DateRangePicker` and
 * nothing else), and react-day-picker has no notion of time of day. So a bare
 * `DatePicker` cannot replace a `<input type="datetime-local">` without
 * dropping precision.
 *
 * `DateTimePicker` is that replacement: Kumo's calendar in a Popover for the
 * day, next to a discrete time field for the wall clock, next to a clear
 * button. Use it for every optional instant in OS — an expiry, a scheduled-at,
 * a cutoff — instead of `type="datetime-local"`, whose native rendering,
 * keyboard model, and clear affordance differ per browser.
 *
 * Contract worth knowing before you wire it up:
 *
 * - The value is `Date | null`, and `null` is a first-class state, not an
 *   error. Both current call sites are OPTIONAL expiries; the clear button
 *   exists so "no expiry" stays expressible.
 * - It reads and writes real `Date` instants in the browser's local zone, the
 *   same thing `new Date(datetimeLocalString)` produced. Call sites keep their
 *   wire format by calling `.toISOString()` themselves.
 * - `min` is a floor: earlier days are disabled in the calendar, the time
 *   field carries a `min` on the floor day, and a fresh selection is clamped up
 *   to `min` rather than being silently accepted in the past.
 * - Picking a day with no time yet set defaults to the END of that day
 *   (23:59). An expiry dated "Jan 2" that silently means midnight — i.e. the
 *   end of Jan 1 — is the footgun this default exists to avoid.
 * - `aria-label` is required and names the control, because a call site may
 *   have no visible `<Label>`; the time field and clear button derive their own
 *   accessible names from it.
 */
const DatePicker = KumoDatePicker;

type DateTimePickerProps = {
	id?: string;
	/** Selected instant, or `null` for "not set". */
	value: Date | null;
	/** Receives the new instant, or `null` when the value is cleared. */
	onChange: (value: Date | null) => void;
	/** Earliest selectable instant. Days before it are disabled. */
	min?: Date;
	disabled?: boolean;
	/** Trigger text while the value is `null`. */
	placeholder?: string;
	className?: string;
	/** Required: names the control for call sites with no visible label. */
	"aria-label": string;
	"aria-describedby"?: string;
	"aria-invalid"?: boolean;
};

const END_OF_DAY = "23:59";

/** Local `YYYY-MM-DD`. `toISOString()` would shift the day in any UTC offset. */
function dayKey(date: Date): string {
	return [
		String(date.getFullYear()).padStart(4, "0"),
		String(date.getMonth() + 1).padStart(2, "0"),
		String(date.getDate()).padStart(2, "0"),
	].join("-");
}

/** Local `HH:MM`, the value shape an `<input type="time">` exchanges. */
function timeKey(date: Date): string {
	return [
		String(date.getHours()).padStart(2, "0"),
		String(date.getMinutes()).padStart(2, "0"),
	].join(":");
}

function combine(day: Date, time: string): Date {
	const [hours, minutes] = time.split(":");
	const next = new Date(day);
	next.setHours(Number(hours ?? 0), Number(minutes ?? 0), 0, 0);
	return next;
}

function clampToFloor(candidate: Date, min: Date | undefined): Date {
	if (!min || candidate.getTime() >= min.getTime()) return candidate;
	// Round the floor up to the whole minute the time field can actually express.
	const floor = new Date(min);
	if (floor.getSeconds() > 0 || floor.getMilliseconds() > 0) {
		floor.setSeconds(0, 0);
		floor.setMinutes(floor.getMinutes() + 1);
	}
	return floor;
}

function DateTimePicker({
	value,
	onChange,
	min,
	disabled = false,
	placeholder = "Not set",
	className,
	id,
	"aria-label": ariaLabel,
	"aria-describedby": ariaDescribedBy,
	"aria-invalid": ariaInvalid,
}: DateTimePickerProps) {
	const [open, setOpen] = useState(false);
	// Survives a clear so re-picking a day keeps the wall clock the operator
	// already chose. `value` is authoritative whenever it exists.
	const [pendingTime, setPendingTime] = useState(END_OF_DAY);
	const time = value ? timeKey(value) : pendingTime;
	const onFloorDay = Boolean(min && value && dayKey(value) === dayKey(min));

	function selectDay(day: Date | undefined) {
		if (!day) return;
		onChange(clampToFloor(combine(day, time || END_OF_DAY), min));
		setOpen(false);
	}

	function selectTime(next: string) {
		setPendingTime(next);
		// An emptied time field keeps the instant it already had; clearing the
		// value is the clear button's job, not a side effect of blanking a field.
		if (value && next) onChange(clampToFloor(combine(value, next), min));
	}

	return (
		<div
			data-slot="date-time-picker"
			className={cn("flex flex-wrap items-center gap-2", className)}
		>
			<Popover open={open} onOpenChange={setOpen}>
				<PopoverTrigger
					id={id}
					aria-label={ariaLabel}
					aria-describedby={ariaDescribedBy}
					aria-invalid={ariaInvalid || undefined}
					disabled={disabled}
					data-slot="date-time-picker-trigger"
					className={cn(
						"inline-flex h-9 min-w-0 flex-1 items-center justify-between gap-2 rounded-lg bg-kumo-base px-3 text-left font-normal type-tedix-body text-kumo-default shadow-none ring ring-kumo-line transition-colors motion-reduce:transition-none max-sm:min-h-11 coarse:min-h-11",
						"focus:outline-none focus-visible:ring-2 focus-visible:ring-kumo-focus disabled:cursor-not-allowed disabled:opacity-50",
					)}
				>
					<span
						className={cn("truncate", value ? "" : "text-kumo-placeholder")}
					>
						{value ? absoluteTime(value.toISOString()) : placeholder}
					</span>
					<CalendarBlankIcon
						aria-hidden
						size={16}
						className="shrink-0 text-kumo-subtle"
					/>
				</PopoverTrigger>
				<PopoverContent align="start" className="w-auto p-0">
					<DatePicker
						mode="single"
						selected={value ?? undefined}
						onChange={selectDay}
						defaultMonth={value ?? min ?? undefined}
						startMonth={min}
						disabled={min ? { before: min } : undefined}
					/>
				</PopoverContent>
			</Popover>
			<Input
				type="time"
				aria-label={`${ariaLabel} time`}
				value={time}
				disabled={disabled}
				min={onFloorDay && min ? timeKey(min) : undefined}
				onChange={(event) => selectTime(event.target.value)}
				className="w-auto shrink-0"
			/>
			{value !== null && (
				<Button
					type="button"
					variant="ghost"
					size="icon-sm"
					aria-label={`Clear ${ariaLabel}`}
					disabled={disabled}
					data-slot="date-time-picker-clear"
					onClick={() => onChange(null)}
					className="shrink-0 max-sm:min-h-11 max-sm:min-w-11 coarse:min-h-11 coarse:min-w-11"
				>
					<XIcon aria-hidden size={14} />
				</Button>
			)}
		</div>
	);
}

export { DatePicker, DateTimePicker, type DateTimePickerProps };
