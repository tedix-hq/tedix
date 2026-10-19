import { describe, expect, it } from "vite-plus/test";
import {
	DeckCuratorRankerConfigSchema,
	type DeckRankExample,
} from "../schemas/deck-curator";
import {
	deckRankSignal,
	orderCuratedDeck,
	retrieveDeckExamples,
} from "./deck-curator";

const config = DeckCuratorRankerConfigSchema.parse({ enabled: true });
function example(id: string, title = `Past decision ${id}`): DeckRankExample {
	return {
		id,
		cardId: id,
		title,
		summary: "A concrete relationship follow-up",
		label: "VALUABLE",
		evidenceRef: `learning:${id}`,
		decidedAt: "2026-10-18T10:00:00.000Z",
	};
}
describe("personal example retrieval", () => {
	it("excludes all current cohort ids and normalized titles, deduplicates past decisions and retrieves eight", () => {
		const pool = [
			example("current"),
			example("alias", "  CURRENT   title "),
			example("duplicate"),
			example("duplicate"),
			...Array.from({ length: 10 }, (_, i) => example(`prior-${i}`)),
		];
		const result = retrieveDeckExamples(
			{ title: "follow-up", summary: "relationship" },
			pool,
			[{ id: "current", title: "Current title" }],
		);
		expect(result).toHaveLength(8);
		expect(
			result.some((row) => row.cardId === "current" || row.cardId === "alias"),
		).toBe(false);
		expect(new Set(result.map((row) => row.cardId)).size).toBe(8);
	});
	it("uses the latest explicit verdict and does not fabricate missing examples", () => {
		const old = example("one");
		const latest = {
			...old,
			id: "new-verdict",
			label: "NOISE" as const,
			decidedAt: "2026-10-19T10:00:00.000Z",
		};
		expect(
			retrieveDeckExamples(
				{ title: "review", summary: "relationship" },
				[old, latest],
				[],
			),
		).toEqual([latest]);
	});
});
it("ignores contradictory model confidence and abstains on malformed final output", () => {
	expect(
		deckRankSignal("a", '{"label":"NOISE","p_valuable":0.99}', [], config),
	).toMatchObject({ label: "NOISE", penalty: -10 });
	expect(
		deckRankSignal("a", '{"label":"VALUABLE","p_valuable":0}', [], config),
	).toMatchObject({ label: "VALUABLE", penalty: 0 });
	for (const text of [null, "I think NOISE", '{"label":"approve"}'])
		expect(deckRankSignal("a", text, [], config)).toMatchObject({
			penalty: 0,
			reason: "model_failed",
		});
});
it("never hides, raises a score or demotes a critical card behind a model-ranked card", () => {
	const cards = [
		{ id: "noise", score: 20 },
		{ id: "valuable", score: 15 },
		{ id: "critical", score: -100 },
	];
	const signals = cards.map((card) =>
		deckRankSignal(card.id, '{"label":"NOISE"}', [], config),
	);
	signals[1]!.penalty = 100;
	const ordered = orderCuratedDeck(cards, signals, new Set(["critical"]));
	expect(ordered.map((card) => card.id)).toEqual([
		"critical",
		"valuable",
		"noise",
	]);
	expect(ordered.map((card) => card.score)).toEqual([-100, 15, 10]);
	expect(cards[0]!.score).toBe(20);
});
