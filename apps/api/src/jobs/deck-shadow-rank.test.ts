import type { SweepCard } from "@tedix/api-contract/utils/deck-pipeline";
import { describe, expect, it } from "vite-plus/test";
import { compareShadowRanking } from "./deck-shadow-rank";

const now = new Date("2026-10-20T12:00:00.000Z");

function card(id: string, patch: Partial<SweepCard> = {}): SweepCard {
	return {
		id,
		kind: "question",
		subject: `Fictional ask ${id}`,
		prompt: "Pick one of the two fictional options.",
		creatorType: "tedi",
		creatorId: "tedi-1",
		workItemId: null,
		dueAt: null,
		expiresAt: null,
		createdAt: "2026-10-19T09:00:00.000Z",
		metadata: {},
		protected: false,
		askKind: "answer",
		...patch,
	};
}

describe("compareShadowRanking", () => {
	const cards = [
		card("fyi"),
		card("person", { creatorType: "user" }),
		card("guarded", { protected: true }),
	];

	it("puts the rule order next to the model order with their distance", () => {
		const result = compareShadowRanking(cards, new Map(), now, "UTC");
		expect(result.ruleOrder).toEqual(["guarded", "person", "fyi"]);
		// No penalties: protected first, then input order.
		expect(result.modelOrder).toEqual(["guarded", "fyi", "person"]);
		expect(result).toMatchObject({
			pairs: 3,
			discordant: 1,
			topK: 3,
			topOverlap: 3,
		});
		expect(result.kendallTauDistance).toBeCloseTo(1 / 3);
	});

	it("applies model penalties to the model order only", () => {
		const result = compareShadowRanking(
			cards,
			new Map([["fyi", -10]]),
			now,
			"UTC",
		);
		expect(result.modelOrder).toEqual(["guarded", "person", "fyi"]);
		expect(result.ruleOrder).toEqual(result.modelOrder);
		expect(result.kendallTauDistance).toBe(0);
	});
});
