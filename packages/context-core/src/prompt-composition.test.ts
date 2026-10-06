import { describe, expect, it } from "vite-plus/test";
import {
	measurePromptComposition,
	PROMPT_WINDOW_TARGET_SHARE,
} from "./prompt-composition.js";

/** ~4 chars per token, so 400 chars ≈ 100 tokens. */
function textOfTokens(tokens: number): string {
	return "x".repeat(tokens * 4);
}

describe("measurePromptComposition", () => {
	it("totals tokens across segments", () => {
		const report = measurePromptComposition([
			{ name: "identity", text: textOfTokens(100) },
			{ name: "brainDigest", text: textOfTokens(300) },
		]);
		expect(report.totalTokens).toBe(400);
	});

	it("orders segments largest-first and names the dominant one", () => {
		const report = measurePromptComposition([
			{ name: "identity", text: textOfTokens(100) },
			{ name: "brainDigest", text: textOfTokens(700) },
			{ name: "skills", text: textOfTokens(200) },
		]);
		expect(report.segments.map((s) => s.name)).toEqual([
			"brainDigest",
			"skills",
			"identity",
		]);
		expect(report.dominant?.name).toBe("brainDigest");
	});

	it("computes share of the assembled prompt", () => {
		const report = measurePromptComposition([
			{ name: "a", text: textOfTokens(250) },
			{ name: "b", text: textOfTokens(750) },
		]);
		const b = report.segments.find((s) => s.name === "b");
		expect(b?.shareOfPrompt).toBeCloseTo(0.75, 5);
	});

	it("computes share of the context window when known", () => {
		const report = measurePromptComposition(
			[{ name: "a", text: textOfTokens(1000) }],
			{ contextWindowTokens: 200_000 },
		);
		expect(report.shareOfWindow).toBeCloseTo(0.005, 6);
		expect(report.segments[0]?.shareOfWindow).toBeCloseTo(0.005, 6);
	});

	it("leaves window shares null when the window is unknown", () => {
		const report = measurePromptComposition([
			{ name: "a", text: textOfTokens(10) },
		]);
		expect(report.shareOfWindow).toBeNull();
		expect(report.segments[0]?.shareOfWindow).toBeNull();
		expect(report.overTarget).toBe(false);
	});

	it("keeps empty segments rather than dropping them", () => {
		// A dark producer must look different from one that was never wired up.
		const report = measurePromptComposition([
			{ name: "brainDigest", text: "" },
			{ name: "identity", text: textOfTokens(50) },
		]);
		expect(report.segments.map((s) => s.name)).toContain("brainDigest");
		expect(report.segments.find((s) => s.name === "brainDigest")?.tokens).toBe(
			0,
		);
	});

	it("handles an empty segment list without dividing by zero", () => {
		const report = measurePromptComposition([]);
		expect(report.totalTokens).toBe(0);
		expect(report.dominant).toBeNull();
		expect(report.segments).toEqual([]);
	});

	it("flags over-target only above the soft share", () => {
		const window = 100_000;
		const under = measurePromptComposition(
			[
				{
					name: "a",
					text: textOfTokens(window * PROMPT_WINDOW_TARGET_SHARE - 10),
				},
			],
			{ contextWindowTokens: window },
		);
		const over = measurePromptComposition(
			[
				{
					name: "a",
					text: textOfTokens(window * PROMPT_WINDOW_TARGET_SHARE + 10),
				},
			],
			{ contextWindowTokens: window },
		);
		expect(under.overTarget).toBe(false);
		expect(over.overTarget).toBe(true);
	});

	it("never mutates or truncates the input text", () => {
		const segments = [{ name: "a", text: textOfTokens(5000) }];
		const before = segments[0]?.text.length;
		measurePromptComposition(segments, { contextWindowTokens: 1000 });
		expect(segments[0]?.text.length).toBe(before);
	});
});
