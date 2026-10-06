import { describe, expect, it } from "vite-plus/test";
import { getExtractionConfig } from "./default-extraction-configs";
const base = {
	siteName: "Example",
	siteSearchInstructions: "Browse listings",
	prompt: "Extract items",
	arrayKey: "items",
	schema: { type: "object" },
};
describe("resolved extraction configuration", () => {
	it("retains D1 execution controls and explicit app precedence", () => {
		const controls = {
			agent: {
				maxCredits: 12,
				urls: ["https://example.com"],
				strictConstrainToURLs: true,
			},
			stopConditions: { maxClicks: 4 },
			quality: {
				minScore: 0.9,
				logWarnings: false,
				rejectIncomplete: true,
				requiredFields: ["title"],
			},
		};
		expect(
			getExtractionConfig("automotive", {
				limit: 3,

				appOverrides: { ...base, ...controls, limit: 7 },
			}),
		).toMatchObject({
			...base,
			...controls,
			limit: 7,

			method: "agent",
		});
	});
	it("preserves vertical limit defaults and requires D1 instructions", () => {
		expect(
			getExtractionConfig("automotive", { appOverrides: base }),
		).toMatchObject({ limit: 50 });
		expect(getExtractionConfig("crypto", { appOverrides: base })).toMatchObject(
			{ limit: 50 },
		);
		expect(
			getExtractionConfig("ecommerce", { appOverrides: base }),
		).toMatchObject({ limit: 30 });
		expect(() => getExtractionConfig("automotive")).toThrow(
			"No extraction prompt",
		);
	});
	it("rejects invalid persisted active controls before sending a provider request", () => {
		expect(() =>
			getExtractionConfig("automotive", {
				appOverrides: { ...base, agent: { maxCredits: -1 } },
			}),
		).toThrow();
		expect(() =>
			getExtractionConfig("automotive", {
				appOverrides: { ...base, quality: { minScore: 2 } },
			}),
		).toThrow();
	});
});
