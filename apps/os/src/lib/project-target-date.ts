import type { Project } from "@tedix/api-contract/contracts/projects";
import { absoluteDate } from "@/lib/time";

const DAY = /^(\d{4}-\d{2}-\d{2})$/;

/**
 * A project's target date for display. Projects store it as free text, mostly
 * `YYYY-MM-DD`; anything that is not a date is shown as written.
 */
export function projectTargetLabel(
	targetDate: string | null | undefined,
): string | null {
	const value = targetDate?.trim();
	if (!value) return null;
	return /^\d{4}-\d{2}-\d{2}/.test(value) ? absoluteDate(value) : value;
}

/** True when an active project's target date has passed. */
export function isProjectOverdue(
	project: Pick<Project, "status" | "targetDate">,
	now = new Date(),
): boolean {
	const value = project.targetDate?.trim();
	if (project.status !== "active" || !value) return false;
	const day = DAY.exec(value)?.[1];
	const end = day ? Date.parse(`${day}T23:59:59.999Z`) : Date.parse(value);
	return !Number.isNaN(end) && end < now.getTime();
}

/** The calendar day a stored target date names, as a local Date, or undefined. */
export function projectTargetDay(
	targetDate: string | null | undefined,
): Date | undefined {
	const day = DAY.exec(targetDate?.trim() ?? "")?.[1];
	if (!day) return undefined;
	const [year, month, date] = day.split("-").map(Number);
	return new Date(year!, month! - 1, date!);
}

/** A picked local calendar day in the stored `YYYY-MM-DD` shape. */
export function projectTargetValue(day: Date): string {
	return [
		String(day.getFullYear()).padStart(4, "0"),
		String(day.getMonth() + 1).padStart(2, "0"),
		String(day.getDate()).padStart(2, "0"),
	].join("-");
}
