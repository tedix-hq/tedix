import { findCatalogEntry } from "@tedix/api-contract/schemas/model-catalog";
import {
	ModelGenerationSettingsSchema,
	type ModelGenerationSettings,
} from "@tedix/api-contract/schemas/model-generation";

/** Explicit per-round allowance: reasoning and Code Mode source share output
 * tokens. Omitting it let the provider stop review wakes after 256 tokens.
 * This is a ceiling, not a spend grant; admission and turn limits still apply.
 */
export const FACET_GENERATION_SETTINGS = { maxOutputTokens: 16_000 } as const;

/** A redrive of the same run keeps its admitted experiment settings. */
export function configureFacetGeneration(
	current: { runId: string | null; generation?: ModelGenerationSettings },
	next: { runId: string; generation?: ModelGenerationSettings },
): ModelGenerationSettings {
	return ModelGenerationSettingsSchema.parse(
		current.runId === next.runId
			? (current.generation ?? {})
			: (next.generation ?? {}),
	);
}

/** Azure GPT-6.1 Sol rejects explicit none (verified through Gateway BYOK).
 * Astra has the same documented restriction. Other models keep their behavior.
 */
export function supportsReasoningNone(modelRef: string): boolean {
	return !/^azure-openai\/gpt-(?:6\.1-sol|6-astra)(?:$|-)/i.test(modelRef);
}

/** Resolve against the selected model.
 * Unknown output capacity is not permission to increase it. Verified GPT-5.6/6
 * limits: https://learn.microsoft.com/en-us/azure/foundry/openai/how-to/reasoning.
 * This response allowance does not change the separate input compaction policy.
 */
export function resolveFacetGeneration(
	model: { provider: "azure-openai" | "workers-ai"; model: string },
	profile: ModelGenerationSettings = {},
	override: ModelGenerationSettings = {},
) {
	const requested = ModelGenerationSettingsSchema.parse({
		...profile,
		...override,
	});
	const maxOutputTokens =
		requested.maxOutputTokens ?? FACET_GENERATION_SETTINGS.maxOutputTokens;
	const outputLimit =
		model.provider === "azure-openai" &&
		/^(?:gpt-5\.6-(?:terra|sol|luna)|gpt-6-(?:astra|sol|luna)|gpt-6\.1-sol)$/.test(
			model.model,
		)
			? 128_000
			: FACET_GENERATION_SETTINGS.maxOutputTokens;
	if (maxOutputTokens > outputLimit)
		throw new Error(
			`Output allowance exceeds the configured ${outputLimit}-token limit of ${model.provider}/${model.model}`,
		);
	if (
		requested.reasoningEffort === "none" &&
		!supportsReasoningNone(`${model.provider}/${model.model}`)
	) {
		throw new Error(
			`Reasoning effort none is unsupported on ${model.provider}/${model.model}`,
		);
	}
	const catalog = findCatalogEntry(`${model.provider}/${model.model}`);
	const isAuto = model.model === "cloudflare/auto";
	const supportsReasoning =
		isAuto ||
		(model.provider === "azure-openai" && catalog?.reasoning === true);
	// "none" asks for no reasoning wire option, which every provider we cannot
	// forward reasoning to already satisfies by sending nothing. Only a positive
	// effort is a request the provider would silently ignore, so only that fails.
	// Direct Workers AI adapters do not expose the effort option.
	if (
		!supportsReasoning &&
		requested.reasoningEffort !== undefined &&
		requested.reasoningEffort !== "none"
	) {
		throw new Error(
			`Explicit reasoning effort is unsupported on ${model.provider}/${model.model}`,
		);
	}
	const reasoningEffort = supportsReasoning
		? (requested.reasoningEffort ?? "medium")
		: null;
	return {
		requested,
		resolved: { ...model, maxOutputTokens, reasoningEffort },
		turnConfig: {
			maxOutputTokens,
			// Provider options carry the configured reasoning budget; generic reasoning is insufficient.
			...(reasoningEffort === null
				? {}
				: {
						providerOptions: {
							[isAuto ? "cloudflareAutoRouter" : "azure"]: { reasoningEffort },
						},
					}),
		},
	};
}

/** Runtime tools use a separate scoped Computer workspace. Keep media
 * in Sessions; local eviction pointers would be inaccessible to the model.
 * The SDK hydration byte ceiling still bounds the recent context window. */
export const RUNTIME_MEDIA_EVICTION = false;
