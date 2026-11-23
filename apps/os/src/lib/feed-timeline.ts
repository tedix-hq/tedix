import type { ActivityFeedItem } from "@tedix/api-contract/schemas/os-activity-feed";
import { focusDay } from "@tedix/api-contract/utils/focus-feed";
import {
	machineText,
	plainFeedText,
} from "@tedix/api-contract/utils/activity-feed";
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
			case "landed_unverified":
				return { tone: "warning", label: "Awaiting verification" };
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
	// A person's own words stay as written; machine fields stay behind More.
	const person =
		PEOPLE.has(item.actorIdentity?.type ?? "") && !item.actorIdentity?.harness;
	const extra = item.explanation
		.split(/\n{2,}/)
		.filter((part) => person || !machineText(plain(part)))
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
	| {
			kind: "group";
			key: string;
			actor: string;
			items: T[];
			/** "task": every step one task took that day, newest first. */
			by: "actor" | "task";
	  };

/**
 * Accepted, started, updated: steps of one task, not separate news. A finished
 * task is the news itself and stays its own row.
 */
const taskStep = (item: ActivityFeedItem) =>
	item.kind === "work" &&
	!!item.workItemId &&
	!item.needsAction &&
	!item.stalled &&
	!item.done;

/**
 * A task's steps within the list fold into its newest step. Then three or
 * more back-to-back events of the same kind by the same actor fold into one row.
 */
export function collapseActivity<T extends ActivityFeedItem>(
	items: readonly T[],
	min = 3,
): ActivityEntry<T>[] {
	const steps = new Map<string, T[]>();
	for (const item of items)
		if (taskStep(item))
			steps.set(item.workItemId!, [
				...(steps.get(item.workItemId!) ?? []),
				item,
			]);
	const entries: ActivityEntry<T>[] = [];
	let run: T[] = [];
	const flush = () => {
		if (run.length >= min)
			entries.push({
				kind: "group",
				key: `group:${run[0]!.id}`,
				actor: run[0]!.actor,
				items: run,
				by: "actor",
			});
		else for (const item of run) entries.push({ kind: "item", item });
		run = [];
	};
	for (const item of items) {
		const task = taskStep(item) ? steps.get(item.workItemId!)! : null;
		if (task && task.length > 1) {
			flush();
			// The first one met is the newest; the later ones are already inside it.
			if (task[0] === item)
				entries.push({
					kind: "group",
					key: `task:${item.id}`,
					actor: item.actor,
					items: task,
					by: "task",
				});
			continue;
		}
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

export type StalledCauseKind =
	| "expired"
	| "failed"
	| "partial"
	| "cancelled"
	| "blocked"
	| "other";

/** Why a stalled record stopped, read from the record itself. */
function stalledCauseKind(item: ActivityFeedItem): StalledCauseKind {
	if (item.kind === "result")
		return item.resultOutcome &&
			item.resultOutcome !== "succeeded" &&
			item.resultOutcome !== "landed_unverified"
			? item.resultOutcome
			: "other";
	if (item.kind !== "work") return "other";
	const match = /blocked|expired|failed/.exec(item.classId)?.[0];
	return (match as "blocked" | "expired" | "failed" | undefined) ?? "other";
}

export interface StalledCause<T extends ActivityFeedItem> {
	key: string;
	cause: StalledCauseKind;
	/** What stalled: the Work Item's title, or the record's own headline. */
	target: string;
	/** What the newest record that says anything more reported, if any did. */
	report: string;
	/** How often it happened: finished Attempts when known, records otherwise. */
	times: number;
	/** Newest first. */
	items: T[];
}

const sameText = (text: string) =>
	text.toLowerCase().replace(/\s+/g, " ").trim();

/**
 * Stalled records that share one cause read as one row: the same Work Item
 * stopping the same way, or the same actor posting the same line. Repeats are
 * counted instead of listed, and the newest cause comes first.
 */
export function stalledCauses<T extends ActivityFeedItem>(
	items: readonly T[],
): StalledCause<T>[] {
	const notes = [OS_COPY.feed.workExplanation, OS_COPY.feed.resultExplanation];
	const endings = [
		...Object.values(OS_COPY.feed.workEvents as Record<string, string>),
		OS_COPY.feed.workUpdated,
	].map((ending) => ` ${ending}.`);
	const groups = new Map<string, { cause: StalledCauseKind; items: T[] }>();
	for (const item of [...items].sort(
		(a, b) => b.at.localeCompare(a.at) || a.id.localeCompare(b.id),
	)) {
		const cause = stalledCauseKind(item);
		const key = `stalled:${
			item.workItemId ??
			`${item.actor}|${sameText(activityHeadline(item).headline)}`
		}:${cause}`;
		const group = groups.get(key) ?? { cause, items: [] };
		group.items.push(item);
		groups.set(key, group);
	}
	return [...groups].map(([key, group]) => {
		const stories = group.items.map((item) => ({
			item,
			...activityHeadline(item, notes),
		}));
		// A Work event's line is "<title> <what happened>."; the title is the target.
		const fromEvent = stories
			.map(({ item, headline }) => {
				const ending =
					item.kind === "work"
						? endings.find((e) => headline.endsWith(e))
						: undefined;
				return ending ? headline.slice(0, -ending.length) : "";
			})
			.find(Boolean);
		const target =
			group.items.find((item) => item.attachment?.title)?.attachment?.title ??
			(fromEvent || stories[0]!.headline);
		const says = (text: string | undefined) =>
			text && !sameText(text).startsWith(sameText(target)) ? text : "";
		const report =
			stories
				.map(
					({ item, headline, detail }) =>
						says(item.attachment?.summary) || says(headline) || says(detail),
				)
				.find(Boolean) ?? "";
		return {
			key,
			cause: group.cause,
			target,
			report,
			times:
				group.items.filter((item) => item.kind === "result").length ||
				group.items.length,
			items: group.items,
		};
	});
}
