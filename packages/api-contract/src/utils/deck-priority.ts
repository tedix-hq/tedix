import type {
	DeckPriority,
	DeckPriorityBand,
	DeckPriorityFactor,
} from "../schemas/deck-priority";
import { calendarDay } from "./card-schedule";
import { factoryCardScore } from "./card-priority";
import { deadlineOverdue } from "./deck-ask";

/** Everything one ask's priority is computed from; every field is optional. */
export type DeckPriorityInput = {
	/** The ask's own deadline: request due date or decision/approval expiry. */
	deadline?: string | null;
	/** The linked Work Item's deadline, else its due date. */
	workDeadline?: string | null;
	/** Accepted Work Items waiting on the ask's Work (graph reach or relations). */
	blocks?: number;
	/** A waiting Work Item has a live Attempt. */
	blocksRunning?: boolean;
	/** Answering commits money. */
	costs?: boolean;
	riskLevel?: string | null;
	/** Protected by policy: an approval, consent or human-reserved action. */
	critical?: boolean;
	objective?: { top?: boolean } | null;
	requestedAt?: string | null;
	/** A factory's own 0–1 priority. */
	factoryScore?: number;
	/** The learned ranker's score; only breaks near-ties. */
	learnedScore?: number;
};

const BAND_ORDER: Record<DeckPriorityBand, number> = {
	today: 0,
	week: 1,
	whenever: 2,
};
const HOUR = 3_600_000;
const dayFormats = new Map<string, Intl.DateTimeFormat>();

function validDate(value?: string | null) {
	return value && Number.isFinite(Date.parse(value)) ? value : null;
}

function isDateOnly(value: string) {
	return /^\d{4}-\d{2}-\d{2}$/.test(value);
}

/** "Mon 17 Nov" in the viewer's timezone; a date-only value is that calendar day. */
export function deckPriorityDay(value: string, timeZone?: string) {
	const zone = isDateOnly(value) ? "UTC" : timeZone;
	const key = zone ?? "";
	let format = dayFormats.get(key);
	if (!format) {
		format = new Intl.DateTimeFormat("en-GB", {
			weekday: "short",
			day: "numeric",
			month: "short",
			timeZone: zone,
		});
		dayFormats.set(key, format);
	}
	return format.format(
		new Date(isDateOnly(value) ? `${value}T12:00:00Z` : value),
	);
}

/** Hours until the deadline ends; a date-only deadline lasts through that day. */
export function deckDeadlineHours(
	deadline: string,
	now: Date,
	timeZone?: string,
) {
	if (!isDateOnly(deadline))
		return (Date.parse(deadline) - now.getTime()) / HOUR;
	const today = calendarDay(now, timeZone);
	const days =
		(Date.parse(`${deadline}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) /
		(24 * HOUR);
	return days * 24 + 24;
}

/** Within 48 h, a week and two weeks; a sooner deadline weighs a little more inside each step. */
function deadlineWeight(hours: number) {
	const steps: [number, number, number][] = [
		[0, 48, 45],
		[48, 7 * 24, 30],
		[7 * 24, 14 * 24, 15],
	];
	for (const [from, to, weight] of steps)
		if (hours <= to)
			return weight + 5 * (1 - (Math.max(hours, from) - from) / (to - from));
	return 5;
}

function earliest(values: (string | null | undefined)[]) {
	const valid = values.map(validDate).filter((v): v is string => Boolean(v));
	const at = (v: string) =>
		isDateOnly(v) ? Date.parse(`${v}T23:59:59Z`) : Date.parse(v);
	return valid.sort((a, b) => at(a) - at(b))[0] ?? null;
}

/**
 * One priority per ask, shared by the API projection, OS and agents:
 * deadline, blocked Work, cost or risk, and waiting time add up to a score;
 * the learned ranker only breaks near-ties. The largest factor becomes the
 * card's plain reason and the deadline and running blocked Work set its band.
 */
export function deckPriority(
	input: DeckPriorityInput,
	now: Date,
	timeZone?: string,
): DeckPriority {
	const deadline = earliest([input.deadline, input.workDeadline]);
	const overdue = deadlineOverdue(deadline, now, timeZone);
	const hours = deadline ? deckDeadlineHours(deadline, now, timeZone) : null;
	const blocks = Math.max(0, Math.floor(input.blocks ?? 0));
	const risk = input.riskLevel?.toLowerCase();
	const waitedDays = Math.max(
		0,
		Math.floor(
			(now.getTime() - (Date.parse(input.requestedAt ?? "") || now.getTime())) /
				(24 * HOUR),
		),
	);
	const factors: [DeckPriorityFactor, number, string][] = [
		[
			"overdue",
			overdue && hours !== null
				? 60 + Math.min(10, Math.floor(-hours / 24))
				: 0,
			deadline ? `Overdue since ${deckPriorityDay(deadline, timeZone)}` : "",
		],
		[
			"deadline",
			overdue || hours === null ? 0 : deadlineWeight(hours),
			deadline ? `Due ${deckPriorityDay(deadline, timeZone)}` : "",
		],
		[
			"blocks",
			blocks > 0
				? 20 + 5 * Math.min(blocks, 8) + (input.blocksRunning ? 10 : 0)
				: input.blocksRunning
					? 30
					: 0,
			blocks > 0
				? `Blocks ${blocks} ${blocks === 1 ? "task" : "tasks"}`
				: "Blocks running work",
		],
		["cost", input.costs ? 25 : 0, "Costs money"],
		[
			"risk",
			risk === "critical" ? 25 : input.critical ? 20 : risk === "high" ? 15 : 0,
			risk === "critical"
				? "Critical risk"
				: input.critical
					? "Needs your sign-off"
					: "High risk",
		],
		[
			"objective",
			input.objective?.top ? 15 : input.objective ? 5 : 0,
			input.objective?.top ? "Serves the top goal" : "Serves a goal",
		],
		[
			"waiting",
			Math.min(15, waitedDays * 1.5),
			`Waiting ${waitedDays} ${waitedDays === 1 ? "day" : "days"}`,
		],
	];
	const top = factors.reduce((best, factor) =>
		factor[1] > best[1] ? factor : best,
	);
	const factory = (factoryCardScore({ score: input.factoryScore }) ?? 0) * 10;
	const learned =
		typeof input.learnedScore === "number" &&
		Number.isFinite(input.learnedScore)
			? Math.min(1, Math.max(-1, input.learnedScore))
			: 0;
	const score =
		factors.reduce((sum, [, value]) => sum + value, 0) + factory + learned;
	const band: DeckPriorityBand =
		overdue || (hours !== null && hours <= 48) || input.blocksRunning
			? "today"
			: (hours !== null && hours <= 7 * 24) ||
				  blocks > 0 ||
				  input.costs ||
				  input.critical ||
				  risk === "critical" ||
				  risk === "high" ||
				  input.objective?.top
				? "week"
				: "whenever";
	return {
		score: Math.round(score * 100) / 100,
		band,
		factor: top[1] > 0 ? top[0] : "none",
		reason: top[1] > 0 ? top[2] : "Nothing waits on it",
		deadline,
	};
}

/** Band first, then the higher score. */
export function compareDeckPriority(
	a: Pick<DeckPriority, "band" | "score">,
	b: Pick<DeckPriority, "band" | "score">,
) {
	return BAND_ORDER[a.band] - BAND_ORDER[b.band] || b.score - a.score;
}

/** Counts per band for the For you header. */
export function deckBandCounts(
	cards: readonly { priority?: Pick<DeckPriority, "band"> }[],
) {
	const counts: Record<DeckPriorityBand, number> = {
		today: 0,
		week: 0,
		whenever: 0,
	};
	for (const card of cards) counts[card.priority?.band ?? "whenever"]++;
	return counts;
}

export type DeckTimelineDot = {
	id: string;
	label: string;
	deadline: string;
	overdue: boolean;
	/** 0 is today, 13 the last day shown; overdue dots sit at -1. */
	day: number;
};

/** Deadlines in the next 14 days, plus overdue ones, for the timeline strip. */
export function deckTimeline(
	cards: readonly {
		id: string;
		label: string;
		priority?: Pick<DeckPriority, "deadline">;
	}[],
	now: Date,
	timeZone?: string,
	days = 14,
): DeckTimelineDot[] {
	const today = Date.parse(`${calendarDay(now, timeZone)}T00:00:00Z`);
	const dots: DeckTimelineDot[] = [];
	for (const card of cards) {
		const deadline = card.priority?.deadline;
		if (!deadline) continue;
		const day = isDateOnly(deadline)
			? deadline
			: calendarDay(new Date(deadline), timeZone);
		const offset = Math.round(
			(Date.parse(`${day}T00:00:00Z`) - today) / (24 * HOUR),
		);
		const overdue = deadlineOverdue(deadline, now, timeZone);
		if (!overdue && (offset < 0 || offset >= days)) continue;
		dots.push({
			id: card.id,
			label: card.label,
			deadline,
			overdue,
			day: overdue ? -1 : offset,
		});
	}
	return dots.sort((a, b) => a.day - b.day);
}
