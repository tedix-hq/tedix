import { describe, expect, it } from "vite-plus/test";
import {
	detectBrandMention,
	scoreAeoQuery,
	summarizeAeoResults,
} from "./aeo-citation-scoring";

describe("detectBrandMention", () => {
	it("finds an exact-text, case-insensitive mention and its position", () => {
		const result = detectBrandMention(
			"For autonomous AI workers, TEDIX is a strong option.",
			"Tedix",
		);
		expect(result.mentioned).toBe(true);
		expect(result.position).toBe(27);
		expect(result.prominence).not.toBeNull();
	});

	it("returns not-mentioned when the brand never appears", () => {
		const result = detectBrandMention(
			"I'd recommend LangChain or CrewAI for this.",
			"Tedix",
		);
		expect(result).toEqual({
			name: "Tedix",
			mentioned: false,
			position: null,
			prominence: null,
		});
	});

	it("scores an earlier mention as more prominent than a later one", () => {
		const early = detectBrandMention(
			"Tedix is great. Filler filler filler.",
			"Tedix",
		);
		const late = detectBrandMention(
			"Filler filler filler. Tedix is great.",
			"Tedix",
		);
		expect(early.prominence).toBeGreaterThan(late.prominence as number);
	});

	it("handles an empty response and an empty brand safely", () => {
		expect(detectBrandMention("", "Tedix")).toEqual({
			name: "Tedix",
			mentioned: false,
			position: null,
			prominence: null,
		});
		expect(detectBrandMention("some text", "  ")).toEqual({
			name: "",
			mentioned: false,
			position: null,
			prominence: null,
		});
	});
});

describe("scoreAeoQuery", () => {
	it("grades target and competitor mentions independently", () => {
		const score = scoreAeoQuery(
			"best platform for autonomous AI workers",
			"Tedix and CrewAI both support autonomous workers.",
			"Tedix",
			["CrewAI", "LangGraph", "AutoGPT"],
		);
		expect(score.target.mentioned).toBe(true);
		expect(score.competitors.map((c) => [c.name, c.mentioned])).toEqual([
			["CrewAI", true],
			["LangGraph", false],
			["AutoGPT", false],
		]);
	});
});

describe("summarizeAeoResults", () => {
	it("computes citation rate, average prominence, and share of voice", () => {
		const scores = [
			scoreAeoQuery("q1", "Tedix leads this category.", "Tedix", ["CrewAI"]),
			scoreAeoQuery("q2", "CrewAI is a popular choice here.", "Tedix", [
				"CrewAI",
			]),
			scoreAeoQuery("q3", "No relevant brands mentioned at all.", "Tedix", [
				"CrewAI",
			]),
		];
		const summary = summarizeAeoResults(scores);

		expect(summary.totalQueries).toBe(3);
		expect(summary.citationRate).toBeCloseTo(1 / 3);
		expect(summary.averageProminence).not.toBeNull();
		// q1: target only -> 1/1; q2: competitor only -> 0/1; q3: no mentions -> excluded.
		expect(summary.shareOfVoice).toBeCloseTo(0.5);
	});

	it("returns zero/null metrics for an empty result set", () => {
		expect(summarizeAeoResults([])).toEqual({
			totalQueries: 0,
			citationRate: 0,
			averageProminence: null,
			shareOfVoice: null,
		});
	});

	it("returns null share of voice when nothing was ever mentioned", () => {
		const scores = [
			scoreAeoQuery("q1", "Nothing relevant here.", "Tedix", ["CrewAI"]),
		];
		const summary = summarizeAeoResults(scores);
		expect(summary.citationRate).toBe(0);
		expect(summary.averageProminence).toBeNull();
		expect(summary.shareOfVoice).toBeNull();
	});
});
