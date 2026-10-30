import { describe, expect, it } from "vite-plus/test";
import { modelCatalogEntry, modelCatalogConfig } from "../test/model-catalog";
import {
	ModelCatalogConfigSchema,
	validateCatalogFallback,
} from "./model-catalog-config";
import { ModelCatalogEntrySchema, isModelRefAllowed } from "./model-catalog";

const primary = modelCatalogEntry("azure-openai/example-custom", {
	tier: "frontier",
});
const backup = modelCatalogEntry("workers-ai/@cf/example/backup", {
	tier: "economy",
});

describe("trusted model catalog configuration", () => {
	it("accepts a configured custom ref without allowing an unknown ref or provider", () => {
		const config = modelCatalogConfig([primary, backup]);
		const opts = {
			catalog: config.entries,
			availableProviders: new Set(["azure-openai"] as const),
		};
		expect(isModelRefAllowed(primary.ref, opts)).toBe(true);
		expect(isModelRefAllowed("azure-openai/not-configured", opts)).toBe(false);
		expect(isModelRefAllowed(backup.ref, opts)).toBe(false);
		expect(config.entries[0]?.tier).toBe("frontier");
	});
	it("rejects mismatched identities, duplicate refs, and unimplemented provider capabilities", () => {
		for (const candidate of [
			{ ...primary, ref: "azure-openai/other" },
			{
				...primary,
				provider: "cloudflare",
				modelId: "other",
				ref: "cloudflare/other",
			},
			{ ...backup, imageInput: "supported" },
		])
			expect(ModelCatalogEntrySchema.safeParse(candidate).success).toBe(false);
		expect(
			ModelCatalogConfigSchema.safeParse({
				...modelCatalogConfig([primary]),
				entries: [primary, primary],
			}).success,
		).toBe(false);
	});
	it("rejects fallback and default refs absent from the same snapshot", () => {
		const config = modelCatalogConfig([primary]);
		expect(() =>
			validateCatalogFallback(
				{
					version: 1,
					maxTransitions: 1,
					ladder: { [primary.ref]: [backup.ref] },
				},
				config.entries,
			),
		).toThrow();
		expect(
			ModelCatalogConfigSchema.safeParse({
				...config,
				defaults: { kernelRouteModelRef: backup.ref },
			}).success,
		).toBe(false);
		expect(
			ModelCatalogConfigSchema.safeParse({
				...config,
				defaults: { workersAiModelRef: primary.ref },
			}).success,
		).toBe(false);
	});
	it("validates a configured fallback ladder and rejects cycles", () => {
		const fallback = {
			version: 1,
			maxTransitions: 1,
			ladder: { [primary.ref]: [backup.ref] },
		};
		expect(
			modelCatalogConfig([primary, backup], { fallback: fallback as never })
				.fallback.ladder[primary.ref],
		).toEqual([backup.ref]);
		expect(
			ModelCatalogConfigSchema.safeParse({
				version: 1,
				entries: [primary, backup],
				fallback: {
					...fallback,
					ladder: { ...fallback.ladder, [backup.ref]: [primary.ref] },
				},
			}).success,
		).toBe(false);
	});
});
