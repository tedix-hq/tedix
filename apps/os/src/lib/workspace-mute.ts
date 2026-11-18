/**
 * Muting a workspace for a while: the choices offered, when each one ends,
 * and how a mute is described. Whether a workspace is muted is decided by
 * comparing the saved end time with the clock; nothing runs when it passes.
 */

export const WORKSPACE_MUTE_CHOICES = [
	{ id: "1h", label: "1 hour" },
	{ id: "3h", label: "3 hours" },
	{ id: "tomorrow", label: "Until tomorrow morning" },
	{ id: "3d", label: "3 days" },
	{ id: "manual", label: "Until I turn it back on" },
] as const;
export type WorkspaceMuteChoice = (typeof WORKSPACE_MUTE_CHOICES)[number]["id"];

const HOUR_MS = 60 * 60_000;
/** "Tomorrow morning" is 08:00 the next day, in the person's own time zone. */
const MORNING_HOUR = 8;

/** When a choice ends, as an ISO time; null for a mute with no end. */
export function workspaceMuteUntil(
	choice: WorkspaceMuteChoice,
	now: Date,
): string | null {
	if (choice === "manual") return null;
	if (choice === "tomorrow") {
		const morning = new Date(now);
		morning.setDate(morning.getDate() + 1);
		morning.setHours(MORNING_HOUR, 0, 0, 0);
		return morning.toISOString();
	}
	const hours = { "1h": 1, "3h": 3, "3d": 72 }[choice];
	return new Date(now.getTime() + hours * HOUR_MS).toISOString();
}

/** "Muted until 14:30", "Muted until Thu 08:00", or "Muted" with no end. */
export function workspaceMuteLabel(until: string | null, now: Date): string {
	if (!until) return "Muted";
	const end = new Date(until);
	const time = `${String(end.getHours()).padStart(2, "0")}:${String(end.getMinutes()).padStart(2, "0")}`;
	if (end.toDateString() === now.toDateString()) return `Muted until ${time}`;
	const day = end.toLocaleDateString(undefined, { weekday: "short" });
	return `Muted until ${day} ${time}`;
}
