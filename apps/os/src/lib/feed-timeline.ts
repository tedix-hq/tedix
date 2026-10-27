import type { ActivityFeedItem } from "@tedix/api-contract/schemas/os-activity-feed";
import { focusDay } from "@tedix/api-contract/utils/focus-feed";
import { plainFeedText } from "@tedix/api-contract/utils/activity-feed";
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

export type ActivityStatusTone = "success" | "warning" | "neutral" | "error";

/**
 * A result's chip: green finished, amber partly done or paused, grey stopped.
 * Red "Didn't finish" is reserved for a real failure.
 */
export function activityStatus(
	item: ActivityFeedItem,
): { tone: ActivityStatusTone; label: string } | null {
	if (item.needsAction) return null;
	const status = OS_COPY.feed.timeline.status;
	if (item.kind === "result")
		switch (item.resultOutcome) {
			case "partial":
				return { tone: "warning", label: status.partial };
			case "expired":
				return { tone: "warning", label: status.paused };
			case "cancelled":
				return { tone: "neutral", label: status.stopped };
			default:
				return item.done
					? { tone: "success", label: status.finished }
					: { tone: "error", label: status.unfinished };
		}
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
	// Older stored events can still carry codes and ids; people see words.
	const plain = (text: string) => plainFeedText(text, OS_COPY.feed);
	const plainSentence = plain(item.sentence);
	const [first, ...rest] = plainSentence.split(SENTENCE_BREAK);
	const split = first && first.length >= 12 && rest.length > 0;
	const headline = split ? first : plainSentence;
	const remainder = split ? rest.join(" ") : "";
	const normalized = (value: string) =>
		value.toLowerCase().replace(/\s+/g, " ").trim();
	const sentence = normalized(plainSentence);
	const extra = item.explanation
		.split(/\n{2,}/)
		.map((part) => {
			const text = plain(part);
			// A body that repeats the headline keeps only what it adds.
			return normalized(text).startsWith(sentence)
				? text.slice(plainSentence.length).trim()
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
