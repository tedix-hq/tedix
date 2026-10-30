import {
	buildModelRef,
	parseModelRef,
	ModelCatalogEntrySchema,
	type ModelCatalogEntry,
} from "../schemas/model-catalog";
import {
	ModelCatalogConfigSchema,
	type ModelCatalogConfig,
} from "../schemas/model-catalog-config";

/** Synthetic configuration builder; each test chooses its own explicit references. */
export function modelCatalogEntry(
	ref: string,
	overrides: Partial<ModelCatalogEntry> = {},
): ModelCatalogEntry {
	const parsed = parseModelRef(ref);
	if (!parsed) throw new Error("Invalid fixture model ref");
	return ModelCatalogEntrySchema.parse({
		ref: buildModelRef(parsed.provider, parsed.modelId),
		...parsed,
		label: parsed.modelId,
		reasoning: true,
		tier: "balanced",
		imageInput: parsed.provider === "workers-ai" ? "unsupported" : "supported",
		governance: {
			weightAccess:
				parsed.provider === "workers-ai" ? "open-weights" : "closed-weights",
			residencyControl:
				parsed.provider === "workers-ai"
					? "cloudflare-network"
					: "customer-provider",
			routingMode: "fixed",
		},
		lifecycle: "active",
		maxOutputTokens: 128_000,
		reasoningEfforts: ["none", "low", "medium", "high", "xhigh", "max"],
		...overrides,
	});
}

export function modelCatalogConfig(
	entries: readonly ModelCatalogEntry[],
	overrides: Partial<ModelCatalogConfig> = {},
): ModelCatalogConfig {
	return ModelCatalogConfigSchema.parse({
		version: 1,
		entries,
		fallback: { version: 1, maxTransitions: 0, ladder: {} },
		...overrides,
	});
}
