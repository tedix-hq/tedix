import { z } from "zod";

/** Per-round generation settings; these never replace admission or task budgets. */
export const ModelGenerationSettingsSchema = z.strictObject({
	reasoningEffort: z
		.enum(["none", "low", "medium", "high", "xhigh", "max"])
		.optional()
		.describe(
			"When absent, inherit the surface effort or use the selected model runtime default.",
		),
	maxOutputTokens: z
		.number()
		.int()
		.positive()
		.max(128_000)
		.optional()
		.describe(
			"When absent, inherit the surface allowance or use the runtime per-round completion default.",
		),
});
export type ModelGenerationSettings = z.infer<
	typeof ModelGenerationSettingsSchema
>;

/** Surface settings are resolved once at dispatch and persisted with the turn. */
export const ModelGenerationPolicySchema = z.strictObject({
	chat: ModelGenerationSettingsSchema.optional().describe(
		"When absent, chat uses runtime generation defaults.",
	),
	cron: ModelGenerationSettingsSchema.optional().describe(
		"When absent, scheduled turns inherit chat generation settings.",
	),
});
export type ModelGenerationPolicy = z.infer<typeof ModelGenerationPolicySchema>;
