import { describe, expect, it } from "vite-plus/test";
import {
	compareFactoryScore,
	factoryCardScore,
	whyThisCard,
} from "./card-priority";

describe("factoryCardScore", () => {
	it("reads only a finite 0–1 number", () => {
		expect(factoryCardScore({ score: 0.4 })).toBe(0.4);
		expect(factoryCardScore({ score: 0 })).toBe(0);
		expect(factoryCardScore({ score: 1 })).toBe(1);
		expect(factoryCardScore({})).toBeUndefined();
		expect(factoryCardScore({ score: "0.9" })).toBeUndefined();
		expect(factoryCardScore({ score: 1.5 })).toBeUndefined();
		expect(factoryCardScore({ score: -0.1 })).toBeUndefined();
		expect(factoryCardScore({ score: Number.NaN })).toBeUndefined();
	});
});

describe("compareFactoryScore", () => {
	it("puts scored cards first, highest first, and ties unscored cards", () => {
		const cards = [
			{ id: "unscored-a" },
			{ id: "low", score: 0.2 },
			{ id: "unscored-b", score: "high" },
			{ id: "high", score: 0.9 },
		];
		expect(
			cards.sort((a, b) => compareFactoryScore(a, b)).map((card) => card.id),
		).toEqual(["high", "low", "unscored-a", "unscored-b"]);
		expect(compareFactoryScore(undefined, undefined)).toBe(0);
	});
});

describe("whyThisCard", () => {
	it("names the two strongest features from a map", () => {
		expect(
			whyThisCard({ topicMatch: 0.8, fresh_thread: 0.5, low_effort: 0.1 }),
		).toBe("Why this card: topic match, fresh thread");
	});

	it("reads a list of named contributions and ignores negative ones", () => {
		expect(
			whyThisCard([
				{ name: "asked by a customer", contribution: 0.3 },
				{ label: "Hostile thread", contribution: -0.4 },
				"due this week",
			]),
		).toBe("Why this card: due this week, asked by a customer");
	});

	it("returns null when the factory supplies nothing usable", () => {
		expect(whyThisCard(undefined)).toBeNull();
		expect(whyThisCard([])).toBeNull();
		expect(whyThisCard({ stale: 0 })).toBeNull();
		expect(whyThisCard("topic")).toBeNull();
	});
});
