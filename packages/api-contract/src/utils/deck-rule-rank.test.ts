import { describe, expect, it } from "vite-plus/test";
import {
	DEFAULT_RULE_RANK,
	compareDeckOrders,
	ruleRankDeck,
	type RuleRankCard,
} from "./deck-rule-rank";

const now = new Date("2026-10-20T12:00:00.000Z");

function card(id: string, patch: Partial<RuleRankCard> = {}): RuleRankCard {
	return {
		id,
		kind: "question",
		subject: `Fictional ask ${id}`,
		prompt: "Pick one of the two fictional options.",
		creatorType: "tedi",
		dueAt: null,
		createdAt: "2026-10-19T09:00:00.000Z",
		metadata: {},
		...patch,
	};
}

const deck = [
	card("fyi"),
	card("factory", { metadata: { factory: { cycle: 3 } } }),
	card("person", { creatorType: "user" }),
	card("deadline", { dueAt: "2026-10-21T09:00:00.000Z" }),
	card("approval", { kind: "approval" }),
	card("money", { prompt: "Pay the fictional supplier invoice of 40 EUR." }),
	card("protected", { critical: true }),
];

function shuffled<T>(items: readonly T[], seed: number): T[] {
	const copy = [...items];
	let state = seed;
	for (let i = copy.length - 1; i > 0; i -= 1) {
		state = (state * 1_103_515_245 + 12_345) % 2 ** 31;
		const j = state % (i + 1);
		[copy[i], copy[j]] = [copy[j]!, copy[i]!];
	}
	return copy;
}

describe("ruleRankDeck", () => {
	it("orders cards by tier with a reason for each", () => {
		const ranked = ruleRankDeck(deck, now, "UTC");
		expect(ranked.map(({ card, tier }) => [card.id, tier])).toEqual([
			["approval", 1],
			["money", 1],
			["protected", 1],
			["deadline", 2],
			["person", 3],
			["factory", 4],
			["fyi", 5],
		]);
		expect(ranked.find((r) => r.card.id === "money")?.reason).toMatch(
			/^critical ask: /,
		);
		expect(ranked.find((r) => r.card.id === "deadline")?.reason).toBe(
			"deadline soon (due 2026-10-21T09:00:00.000Z)",
		);
	});

	it("uses deadline fields only, never show-from dates", () => {
		const [ranked] = ruleRankDeck(
			[card("reminder", { metadata: { showFrom: "2026-10-20T13:00:00Z" } })],
			now,
			"UTC",
		);
		expect(ranked?.tier).toBe(5);
		const [due] = ruleRankDeck(
			[card("due", { metadata: { deadline: "2026-10-22" } })],
			now,
			"UTC",
		);
		expect(due?.tier).toBe(2);
	});

	it("treats overdue asks as urgent and far deadlines as not", () => {
		const ranked = ruleRankDeck(
			[
				card("far", { dueAt: "2026-11-30T09:00:00.000Z" }),
				card("overdue", { dueAt: "2026-10-01T09:00:00.000Z" }),
			],
			now,
			"UTC",
		);
		expect(ranked.map(({ card, tier }) => [card.id, tier])).toEqual([
			["overdue", 2],
			["far", 5],
		]);
	});

	it("reads a date-only deadline in the viewer's timezone", () => {
		const late = new Date("2026-10-20T23:30:00.000Z");
		const due = card("due", { metadata: { due: "2026-10-23" } });
		// 48 h later is Oct 22 in UTC but already Oct 23 in Auckland.
		expect(ruleRankDeck([due], late, "UTC")[0]?.tier).toBe(5);
		expect(ruleRankDeck([due], late, "Pacific/Auckland")[0]?.tier).toBe(2);
	});

	it("breaks ties by nearer deadline, then newest, then id", () => {
		const ranked = ruleRankDeck(
			[
				card("b-old", { kind: "approval", createdAt: "2026-10-18T09:00:00Z" }),
				card("late-due", {
					kind: "approval",
					dueAt: "2026-10-25T09:00:00Z",
				}),
				card("a-old", { kind: "approval", createdAt: "2026-10-18T09:00:00Z" }),
				card("new", { kind: "approval", createdAt: "2026-10-20T09:00:00Z" }),
				card("soon-due", {
					kind: "approval",
					dueAt: "2026-10-21T09:00:00Z",
				}),
			],
			now,
			"UTC",
		);
		expect(ranked.map(({ card }) => card.id)).toEqual([
			"soon-due",
			"late-due",
			"new",
			"a-old",
			"b-old",
		]);
	});

	it("never ranks a critical ask below an FYI card, whatever the input order", () => {
		const expected = ruleRankDeck(deck, now, "UTC").map(({ card }) => card.id);
		for (let seed = 1; seed <= 200; seed += 1) {
			const ranked = ruleRankDeck(shuffled(deck, seed), now, "UTC");
			const ids = ranked.map(({ card }) => card.id);
			const lastCritical = Math.max(
				...ranked.flatMap((r, index) => (r.tier === 1 ? [index] : [])),
			);
			const firstFyi = ranked.findIndex((r) => r.tier === 5);
			expect(lastCritical).toBeLessThan(firstFyi);
			expect(ids).toEqual(expected);
		}
	});

	it("does not mutate its input and takes the config as data", () => {
		const input = deck.map((item) => ({ ...item }));
		const snapshot = structuredClone(input);
		ruleRankDeck(input, now, "UTC");
		expect(input).toEqual(snapshot);
		const ranked = ruleRankDeck(input, now, "UTC", {
			...DEFAULT_RULE_RANK,
			personCreatorTypes: [],
		});
		expect(ranked.find((r) => r.card.id === "person")?.tier).toBe(5);
	});
});

describe("compareDeckOrders", () => {
	it("reports Kendall tau distance and top-k overlap", () => {
		expect(compareDeckOrders(["a", "b", "c"], ["a", "b", "c"])).toEqual({
			pairs: 3,
			discordant: 0,
			kendallTauDistance: 0,
			topK: 3,
			topOverlap: 3,
		});
		const reversed = compareDeckOrders(
			["a", "b", "c", "d"],
			["d", "c", "b", "a"],
			2,
		);
		expect(reversed).toMatchObject({
			pairs: 6,
			discordant: 6,
			kendallTauDistance: 1,
			topK: 2,
			topOverlap: 0,
		});
		expect(compareDeckOrders([], [])).toMatchObject({ kendallTauDistance: 0 });
	});
});
