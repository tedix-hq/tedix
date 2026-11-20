import * as z from "zod";
import {
	ModelCatalogEntriesSchema,
	findCatalogEntry,
	type ModelCatalogEntry,
	offeredInChat,
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
				/**
				 * The model a signed-in person's chat turn runs on when they
				 * picked none. It applies only where the organization, and a
				 * picked tedi, may use it. Absent means no chat default.
				 * Scheduled and other unattended turns never use it.
				 */
				personChatModelRef: ModelRefSchema.optional(),
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
				(key === "workersAiModelRef" && entry.provider !== "workers-ai") ||
				(key === "personChatModelRef" && !offeredInChat(entry))
			)
				ctx.addIssue({
					code: "custom",
					path: ["defaults", key],
					message:
						key === "personChatModelRef"
							? "Chat default must be a model that chat offers"
							: "Default model must be configured for its provider",
				});
		}
	});
export type ModelCatalogConfig = z.infer<typeof ModelCatalogConfigSchema>;
