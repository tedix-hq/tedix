import type { ActivityFeedItem } from "@tedix/api-contract/schemas/os-activity-feed";
import { focusDay } from "@tedix/api-contract/utils/focus-feed";
import { OS_COPY } from "@/shared/os-copy";

export const ACTIVITY_WHO = [
	"all",
	"people",
	"tedis",
	"apps",
	"shipped",
] as const;
export type ActivityWho = (typeof ACTIVITY_WHO)[number];

const PEOPLE = new Set(["user", "person", "member", "human"]);
const AGENTS = new Set(["tedi", "agent", "external_agent"]);

/** Who acted: a person, a tedi (or another agent), or an app or the system. */
export function activityActorKind(item: ActivityFeedItem) {
	const type = item.actorIdentity?.type ?? "";
	if (item.tediId || AGENTS.has(type)) return "tedis";
	if (PEOPLE.has(type)) return "people";
	return "apps";
}

export function activityShipped(item: ActivityFeedItem) {
	return item.done && (item.kind === "result" || item.kind === "work");
}

export function matchesActivityWho(item: ActivityFeedItem, who: ActivityWho) {
	if (who === "all") return true;
	if (who === "shipped") return activityShipped(item);
	return activityActorKind(item) === who;
}

/** A finished or failed outcome reads as a green or red chip. */
export function activityStatus(
	item: ActivityFeedItem,
): { tone: "success" | "error"; label: string } | null {
	if (item.needsAction) return null;
	const status = OS_COPY.feed.timeline.status;
	if (item.kind === "result")
		return item.done
			? { tone: "success", label: status.finished }
			: { tone: "error", label: status.unfinished };
	if (item.kind !== "work") return null;
	if (/failed|expired|blocked/.test(item.classId))
		return { tone: "error", label: status.needsLook };
	return null;
}

const SENTENCE_BREAK = /(?<=[a-z0-9)”’"][.!?])\s+(?=[A-Z0-9€$£“"])/u;

/**
 * One bold headline and at most one muted line. The headline is the first
 * sentence; the line is the rest, or the first explanation paragraph that adds
 * something beyond the sentence and the generic receipt note.
 */
export function activityHeadline(
	item: ActivityFeedItem,
	boilerplate: readonly string[] = [],
) {
	const [first, ...rest] = item.sentence.split(SENTENCE_BREAK);
	const split = first && first.length >= 12 && rest.length > 0;
	const headline = split ? first : item.sentence;
	const remainder = split ? rest.join(" ") : "";
	const normalized = (value: string) =>
		value.toLowerCase().replace(/\s+/g, " ").trim();
	const sentence = normalized(item.sentence);
	const extra = item.explanation
		.split(/\n{2,}/)
		.map((part) => {
			const text = part.trim();
			// A body that repeats the headline keeps only what it adds.
			return normalized(text).startsWith(sentence)
				? text.slice(item.sentence.trim().length).trim()
				: text;
		})
		.find(
			(part) =>
				part &&
				!boilerplate.includes(part) &&
				!sentence.includes(normalized(part)) &&
				normalized(part) !== normalized(item.attachment?.summary ?? ""),
		);
	return { headline, detail: remainder || extra || "" };
}

export type ActivityEntry<T extends ActivityFeedItem> =
	| { kind: "item"; item: T }
	| { kind: "group"; key: string; actor: string; items: T[] };

/** Three or more back-to-back events of the same kind by the same actor fold into one row. */
export function collapseActivity<T extends ActivityFeedItem>(
	items: readonly T[],
	min = 3,
): ActivityEntry<T>[] {
	const entries: ActivityEntry<T>[] = [];
	let run: T[] = [];
	const flush = () => {
		if (run.length >= min)
			entries.push({
				kind: "group",
				key: `group:${run[0]!.id}`,
				actor: run[0]!.actor,
				items: run,
			});
		else for (const item of run) entries.push({ kind: "item", item });
		run = [];
	};
	for (const item of items) {
		const previous = run[0];
		if (
			previous &&
			!item.needsAction &&
			!previous.needsAction &&
			previous.actor === item.actor &&
			previous.classId === item.classId &&
			previous.projectId === item.projectId
		)
			run.push(item);
		else {
			flush();
			run.push(item);
		}
	}
	flush();
	return entries;
}

/** Newest first, one group per calendar day in the reader's time zone. */
export function activityDays<T extends ActivityFeedItem>(
	items: readonly T[],
	timeZone: string,
	now: Date,
	locale?: string,
) {
	const today = focusDay(now.toISOString(), timeZone);
	const yesterday = focusDay(
		new Date(now.getTime() - 86_400_000).toISOString(),
		timeZone,
	);
	const days = new Map<string, T[]>();
	for (const item of [...items].sort(
		(a, b) => b.at.localeCompare(a.at) || a.id.localeCompare(b.id),
	)) {
		const day = focusDay(item.at, timeZone);
		days.set(day, [...(days.get(day) ?? []), item]);
	}
	return [...days].map(([day, dayItems]) => ({
		day,
		label:
			day === today
				? OS_COPY.feed.timeline.today
				: day === yesterday
					? OS_COPY.feed.timeline.yesterday
					: new Intl.DateTimeFormat(locale, {
							weekday: "short",
							month: "short",
							day: "numeric",
							timeZone: "UTC",
						}).format(new Date(`${day}T12:00:00Z`)),
		items: dayItems,
	}));
}
