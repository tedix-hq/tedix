import * as z from "zod";
import {
	ModelCatalogEntriesSchema,
	findCatalogEntry,
	type ModelCatalogEntry,
	ModelRefSchema,
} from "./model-catalog";
import {
	ModelFallbackPolicySchema,
	type ModelFallbackPolicy,
} from "./model-fallback";

export function validateCatalogFallback(
	value: unknown,
	entries: readonly ModelCatalogEntry[],
): ModelFallbackPolicy {
	const policy = ModelFallbackPolicySchema.parse(value);
	for (const [ref, next] of Object.entries(policy.ladder)) {
		for (const candidate of [ref, ...next]) {
			const entry = findCatalogEntry(candidate, entries);
			if (
				!entry ||
				!["azure-openai", "workers-ai", "cloudflare"].includes(entry.provider)
			)
				throw new Error(
					"Fallback model is not configured for a supported provider",
				);
		}
	}
	return policy;
}

/** Published system policy data; never merged with tenant-supplied model metadata. */
export const ModelCatalogConfigSchema = z
	.strictObject({
		version: z.literal(1),
		entries: ModelCatalogEntriesSchema,
		fallback: ModelFallbackPolicySchema,
		defaults: z
			.strictObject({
				kernelRouteModelRef: ModelRefSchema.optional(),
				workersAiModelRef: ModelRefSchema.optional(),
			})
			.optional(),
	})
	.superRefine((config, ctx) => {
		try {
			validateCatalogFallback(config.fallback, config.entries);
		} catch {
			ctx.addIssue({
				code: "custom",
				path: ["fallback"],
				message: "Fallback references must be configured models",
			});
		}
		for (const [key, ref] of Object.entries(config.defaults ?? {})) {
			const entry = ref ? findCatalogEntry(ref, config.entries) : undefined;
			if (
				!entry ||
				(key === "workersAiModelRef" && entry.provider !== "workers-ai")
			)
				ctx.addIssue({
					code: "custom",
					path: ["defaults", key],
					message: "Default model must be configured for its provider",
				});
		}
	});
export type ModelCatalogConfig = z.infer<typeof ModelCatalogConfigSchema>;
