/**
 * Deterministic Deck ranking with no model calls: the baseline the model
 * ranker is measured against, and the fallback when it cannot run.
 *
 * Invariant: a human-addressed critical ask is never ranked below noise. Tier 1
 * sorts before every other tier whatever the deadline, author or age.
 *
 * Tiers (lower ranks first):
 * 1. critical: approvals, outbound sends, security, money out, credentials;
 * 2. a deadline within the window (48 h by default), including overdue asks;
 * 3. an ask from a named person;
 * 4. a recurring or factory ask;
 * 5. FYI.
 * Ties: nearer deadline first (no deadline last), then newest, then id.
 *
 * Tier definitions are data (`RuleRankConfig`) so a stored row can replace the
 * default later; this module holds only the engine.
 */
import { calendarDay, factoryCardDeadline } from "./card-schedule";
import { humanReservedActionClasses } from "./approval-policy";

export type RuleRankTier = 1 | 2 | 3 | 4 | 5;

export type RuleRankCard = {
	id: string;
	kind: string;
	subject: string;
	prompt: string;
	creatorType: string;
	dueAt: string | null;
	createdAt: string;
	metadata: Record<string, unknown>;
	/** Caller's policy verdict (protected or critical); never downgraded here. */
	critical?: boolean;
};

export type RuleRankConfig = {
	version: 1;
	criticalKinds: readonly string[];
	deadlineWindowMs: number;
	personCreatorTypes: readonly string[];
	recurringCreatorTypes: readonly string[];
	recurringMetadataKeys: readonly string[];
};

export const DEFAULT_RULE_RANK: RuleRankConfig = {
	version: 1,
	criticalKinds: ["approval", "outbound"],
	deadlineWindowMs: 48 * 60 * 60 * 1000,
	personCreatorTypes: ["user"],
	recurringCreatorTypes: ["system"],
	recurringMetadataKeys: ["factory", "factoryCycle", "schedule", "recurrence"],
};

const TIER_REASONS: Record<RuleRankTier, string> = {
	1: "critical ask",
	2: "deadline soon",
	3: "asked by a person",
	4: "recurring or factory ask",
	5: "for your information",
};

const DAY_MS = 24 * 60 * 60 * 1000;

/** Deadline as a sortable instant; a date-only deadline counts until its UTC day ends. */
function deadlineMs(deadline: string | null): number | null {
	if (!deadline) return null;
	const ms = /^\d{4}-\d{2}-\d{2}$/.test(deadline)
		? Date.parse(`${deadline}T00:00:00.000Z`) + DAY_MS - 1
		: Date.parse(deadline);
	return Number.isFinite(ms) ? ms : null;
}

function withinWindow(
	deadline: string,
	now: Date,
	timeZone: string,
	windowMs: number,
): boolean {
	const horizon = new Date(now.getTime() + windowMs);
	// A date-only deadline is a calendar date in the viewer's timezone.
	if (/^\d{4}-\d{2}-\d{2}$/.test(deadline))
		return deadline <= calendarDay(horizon, timeZone);
	const ms = Date.parse(deadline);
	return Number.isFinite(ms) && ms <= horizon.getTime();
}

export function ruleRankTier(
	card: RuleRankCard,
	now: Date,
	timeZone: string,
	config: RuleRankConfig = DEFAULT_RULE_RANK,
): { tier: RuleRankTier; deadline: string | null; reason: string } {
	// Deadline fields only: show-from and reminder dates never make an ask urgent.
	const deadline = factoryCardDeadline({
		dueAt: card.dueAt,
		metadata: card.metadata,
		action: card.prompt,
		why: card.subject,
		runCreatedAt: card.createdAt,
	});
	const reserved = humanReservedActionClasses(
		`${card.subject}\n${card.prompt}`,
	);
	let tier: RuleRankTier;
	let detail = "";
	if (card.critical || config.criticalKinds.includes(card.kind)) tier = 1;
	else if (reserved.length) {
		tier = 1;
		detail = `: ${reserved.join(", ")}`;
	} else if (
		deadline &&
		withinWindow(deadline, now, timeZone, config.deadlineWindowMs)
	) {
		tier = 2;
		detail = ` (due ${deadline})`;
	} else if (config.personCreatorTypes.includes(card.creatorType)) tier = 3;
	else if (
		config.recurringCreatorTypes.includes(card.creatorType) ||
		config.recurringMetadataKeys.some((key) => card.metadata[key] != null)
	)
		tier = 4;
	else tier = 5;
	return { tier, deadline, reason: `${TIER_REASONS[tier]}${detail}` };
}

/** Returns a new array; the input is never mutated. */
export function ruleRankDeck<T extends RuleRankCard>(
	cards: readonly T[],
	now: Date,
	timeZone: string,
	config: RuleRankConfig = DEFAULT_RULE_RANK,
): { card: T; tier: RuleRankTier; reason: string }[] {
	return cards
		.map((card) => {
			const ranked = ruleRankTier(card, now, timeZone, config);
			return {
				card,
				tier: ranked.tier,
				reason: ranked.reason,
				due: deadlineMs(ranked.deadline) ?? Number.POSITIVE_INFINITY,
				created: Date.parse(card.createdAt) || 0,
			};
		})
		.sort(
			(a, b) =>
				a.tier - b.tier ||
				(a.due === b.due ? 0 : a.due < b.due ? -1 : 1) ||
				b.created - a.created ||
				(a.card.id < b.card.id ? -1 : a.card.id > b.card.id ? 1 : 0),
		)
		.map(({ card, tier, reason }) => ({ card, tier, reason }));
}

/** Pairwise disagreement and top-k overlap between two orders of the same ids. */
export function compareDeckOrders(
	left: readonly string[],
	right: readonly string[],
	topK = 5,
) {
	const position = new Map(right.map((id, index) => [id, index]));
	const shared = left.filter((id) => position.has(id));
	let discordant = 0;
	for (let i = 0; i < shared.length; i += 1)
		for (let j = i + 1; j < shared.length; j += 1)
			if (position.get(shared[i]!)! > position.get(shared[j]!)!)
				discordant += 1;
	const pairs = (shared.length * (shared.length - 1)) / 2;
	const top = new Set(right.slice(0, topK));
	return {
		pairs,
		discordant,
		/** Normalized Kendall tau distance: 0 identical, 1 reversed. */
		kendallTauDistance: pairs ? discordant / pairs : 0,
		topK: Math.min(topK, left.length, right.length),
		topOverlap: left.slice(0, topK).filter((id) => top.has(id)).length,
	};
}
