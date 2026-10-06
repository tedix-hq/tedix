import { describe, expect, it } from "vite-plus/test";
import { ApplyTemplateInputSchema } from "../contracts/templates";
import { ExtractionConfigExpandedSchema } from "./extraction-config";

const config = {
	method: "agent",
	arrayKey: "items",
	siteName: "Example",
	siteSearchInstructions: "Browse listings",
	prompt: "Extract items",
	schema: { type: "object" },
	siteContext: "Regional catalog",
	quality: {
		minScore: 0.8,
		rejectIncomplete: true,
		logWarnings: false,
		requiredFields: ["title"],
	},
};
describe("extraction configuration", () => {
	it("preserves supported template context and active quality controls", () => {
		expect(ExtractionConfigExpandedSchema.parse(config)).toEqual(config);
		const input = ApplyTemplateInputSchema.parse({
			templateId: crypto.randomUUID(),
			organizationId: crypto.randomUUID(),
			name: "Catalog",
			slug: "catalog",
			primaryDomain: "example.com",
			extractionConfigOverrides: {
				siteContext: config.siteContext,
				quality: config.quality,
			},
		});
		expect(input.extractionConfigOverrides).toEqual({
			siteContext: config.siteContext,
			quality: config.quality,
		});
	});
	it("rejects unsupported options without mutating the input", () => {
		for (const extra of [
			{ enabled: true },
			{ currency: "EUR" },
			{ priceFormat: "english" },
			{ normalization: {} },
			{ urlPatterns: {} },
			{ promptOnlyMode: true },
			{ customStoredField: { version: 1 } },
			{ agent: { timeout: 1 } },
			{ quality: { minImages: 1 } },
			{ stopConditions: { unexpected: 1 } },
		]) {
			const input = { ...config, ...extra };
			const before = structuredClone(input);
			expect(ExtractionConfigExpandedSchema.safeParse(input).success).toBe(
				false,
			);
			expect(input).toEqual(before);
		}
	});
	it("retains arbitrary data keys inside schemas and field mappings", () => {
		const input = {
			...config,
			schema: { custom: { enabled: true } },
			fieldMappings: { customField: ["custom_source"] },
			quality: { minScore: 0, rejectIncomplete: false, logWarnings: false },
		};
		expect(ExtractionConfigExpandedSchema.parse(input)).toEqual(input);
	});
});
