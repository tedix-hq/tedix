import type {
	DecisionCardContextItem,
	DecisionCardPreferences,
} from "../schemas/user-settings";

/** Shown at least this often before use decides whether an item stays. */
const LEARN_AFTER_SHOWN = 8;
/** Opened at least this share of the time: the item leads the strip. */
const ALWAYS_OPENED = 0.8;
/** Counts halve past this, so recent use outweighs old habits. */
const COUNT_CEILING = 200;
const STRIP_LIMIT = 3;

/** Which context items a card shows: the person's choice, else what use taught, else the card's own order. */
export function decisionCardContextItems(
	preferences: DecisionCardPreferences | undefined,
	cardType: string,
	available: readonly DecisionCardContextItem[],
): DecisionCardContextItem[] {
	const chosen = preferences?.contextItems?.[cardType];
	if (chosen)
		return available
			.filter((item) => chosen.includes(item))
			.slice(0, STRIP_LIMIT);
	const stats = preferences?.contextStats?.[cardType] ?? {};
	const rate = (item: DecisionCardContextItem) => {
		const use = stats[item];
		return use && use.shown >= LEARN_AFTER_SHOWN
			? use.opened / use.shown
			: null;
	};
	return available
		.filter((item) => rate(item) !== 0)
		.map((item, index) => ({
			item,
			rank:
				(rate(item) ?? 0) >= ALWAYS_OPENED ? index - available.length : index,
		}))
		.sort((left, right) => left.rank - right.rank)
		.slice(0, STRIP_LIMIT)
		.map(({ item }) => item);
}

/** Records one decided card: which strip items it showed and which the person opened. */
export function recordDecisionCardContextUse(
	preferences: DecisionCardPreferences | undefined,
	cardType: string,
	shown: readonly DecisionCardContextItem[],
	opened: readonly DecisionCardContextItem[],
): DecisionCardPreferences {
	const current = { ...preferences?.contextStats?.[cardType] };
	for (const item of shown) {
		const use = current[item] ?? { shown: 0, opened: 0 };
		const next = {
			shown: use.shown + 1,
			opened: use.opened + (opened.includes(item) ? 1 : 0),
		};
		current[item] =
			next.shown > COUNT_CEILING
				? {
						shown: Math.ceil(next.shown / 2),
						opened: Math.ceil(next.opened / 2),
					}
				: next;
	}
	const types = Object.keys(preferences?.contextStats ?? {});
	const contextStats = Object.fromEntries(
		[
			...types
				.filter((type) => type !== cardType)
				.slice(-49)
				.map((type) => [type, preferences!.contextStats![type]!] as const),
		].concat([[cardType, current]]),
	);
	return { ...preferences, contextStats };
}

export type DecideForMeMode = "ask" | "suggest" | "auto";

export function decideForMeMode(
	preferences: DecisionCardPreferences | undefined,
	cardType: string,
): DecideForMeMode {
	return preferences?.decideForMe?.[cardType] ?? "ask";
}
