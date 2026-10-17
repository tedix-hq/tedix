import { OS_COPY } from "@/shared/os-copy";

const UUID =
	/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;

export function plainWorkText(text: string): string {
	return text
		.replace(/\bRun [0-9a-f-]{36} failed:\s*/gi, "Last run failed: ")
		.replace(UUID, "record")
		.replace(
			/\b(?:Gmail\s+)?(?:thread|message)\s*(?:id\s*)?:?\s*[0-9a-f]{16,}\b/gi,
			"Email",
		);
}

export function workDate(value: string, withTime = false): string {
	const date = new Date(value.length === 10 ? `${value}T12:00:00` : value);
	if (Number.isNaN(date.getTime())) return "Date unavailable";
	return new Intl.DateTimeFormat("en-GB", {
		weekday: "short",
		day: "numeric",
		month: "short",
		...(withTime
			? { hour: "2-digit", minute: "2-digit", hourCycle: "h23" as const }
			: {}),
	})
		.format(date)
		.replaceAll(",", "");
}

export function workDue(value: string, now = new Date()): string {
	const date = new Date(value.length === 10 ? `${value}T12:00:00` : value);
	if (Number.isNaN(date.getTime())) return OS_COPY.work.noDue;
	const day = (d: Date) => Date.UTC(d.getFullYear(), d.getMonth(), d.getDate());
	const days = Math.round((day(date) - day(now)) / 86_400_000);
	if (days === 0) return "due today";
	if (days === 1) return "due tomorrow";
	return days > 0
		? `due in ${days} days`
		: `${Math.abs(days)} ${days === -1 ? "day" : "days"} overdue`;
}

export type WorkChecklistUpdate = {
	metadata?: Record<string, unknown> | null;
};

export function workChecklist(
	description: string,
	updates: readonly WorkChecklistUpdate[] = [],
) {
	const lines = description.split(/\r?\n/);
	let fence = "";
	return lines.flatMap((line, index) => {
		const marker = line.match(/^\s*(`{3,}|~{3,})/)?.[1];
		if (marker) {
			if (!fence) fence = marker;
			else if (marker[0] === fence[0] && marker.length >= fence.length)
				fence = "";
			return [];
		}
		if (fence) return [];
		const match = line.match(/^\s*(?:[-+*]|\d+[.)])\s+\[([ xX])\]\s+(.+)$/);
		if (!match) return [];
		const key = `${index}:${line}`;
		let checked = match[1]!.toLowerCase() === "x";
		for (const update of updates) {
			const state = update.metadata?.workChecklist;
			if (
				state &&
				typeof state === "object" &&
				!Array.isArray(state) &&
				"key" in state &&
				state.key === key &&
				"checked" in state &&
				typeof state.checked === "boolean"
			)
				checked = state.checked;
		}
		return [{ key, line: index + 1, text: match[2]!, checked }];
	});
}

/** Change prose only; preserve code and link destinations exactly. */
export function workMarkdown(content: string): string {
	let fence = "";
	return content
		.split(/\r?\n/)
		.map((line) => {
			const marker = line.match(/^\s*(`{3,}|~{3,})/)?.[1];
			if (marker) {
				if (!fence) fence = marker;
				else if (marker[0] === fence[0] && marker.length >= fence.length)
					fence = "";
				return line;
			}
			if (fence) return line;
			const gmail = line.match(
				/^(.*?Gmail thread:)\s*([0-9a-f]{16,})\s*[—–-]\s*(.+)$/i,
			);
			if (gmail)
				return `${gmail[1]} [${gmail[3]}](https://mail.google.com/mail/u/0/#all/${gmail[2]})`;
			return line
				.split(/(`[^`]*`|\]\([^)]*\)|https:\/\/[^\s<>]+|\]\[[^\]]*\])/g)
				.map((part) => {
					if (/^(?:`|\]\(|https:\/\/|\]\[)/.test(part)) return part;
					return plainWorkText(part).replace(/\b\d{4}-\d{2}-\d{2}\b/g, (date) =>
						workDate(date),
					);
				})
				.join("");
		})
		.join("\n");
}

export function workReminders(
	metadata: Record<string, unknown> | null,
	description: string,
): string[] {
	const stored = metadata?.reminders;
	const reminders = Array.isArray(stored)
		? stored.flatMap((entry) => {
				const at =
					typeof entry === "string"
						? entry
						: entry && typeof entry === "object" && "at" in entry
							? entry.at
							: null;
				return typeof at === "string"
					? [`${OS_COPY.work.reminder} ${workDate(at, at.includes("T"))}`]
					: [];
			})
		: [];
	if (reminders.length) return reminders;
	return [
		...description.matchAll(
			/\b(?:follow-up|reminder)\s*:?[ \t]*(\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?Z?)?)?)/gi,
		),
	].map(
		(match) =>
			`${OS_COPY.work.reminder} ${workDate(match[1]!, match[1]!.includes("T"))}`,
	);
}
