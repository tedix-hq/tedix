import { describe, expect, it } from "vite-plus/test";
import { compareFactoryScore, factoryCardScore } from "./card-priority";

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
