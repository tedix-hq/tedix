/** Supported extraction configuration. Unknown options are rejected, never stripped. */
import * as z from "zod";
import { JsonValueSchema } from "./common";

export const ExtractionMethodSchema = z.literal("agent");
export type ExtractionMethod = z.infer<typeof ExtractionMethodSchema>;
export const AgentModelSchema = z.enum(["spark-1-mini", "spark-1-pro"]);
export type AgentModel = z.infer<typeof AgentModelSchema>;

export const AgentConfigSchema = z.strictObject({
	model: AgentModelSchema.optional().describe(
		"Optional Firecrawl model; the provider chooses its default when absent.",
	),
	maxCredits: z
		.number()
		.positive()
		.optional()
		.describe(
			"Optional provider credit cap; omitted from the request when absent.",
		),
	urls: z
		.array(z.url())
		.optional()
		.describe(
			"Optional navigation URLs; the agent discovers the site when absent.",
		),
	strictConstrainToURLs: z
		.boolean()
		.optional()
		.describe("Optional provider URL restriction; omitted when absent."),
});
export type AgentConfig = z.infer<typeof AgentConfigSchema>;

export const StopConditionsSchema = z.strictObject({
	maxDetailPages: z
		.number()
		.int()
		.positive()
		.optional()
		.describe("Optional detail-page limit added to the agent prompt."),
	maxListingPages: z
		.number()
		.int()
		.positive()
		.optional()
		.describe("Optional listing-page limit added to the agent prompt."),
	maxScrolls: z
		.number()
		.int()
		.positive()
		.optional()
		.describe("Optional scroll limit added to the agent prompt."),
	maxClicks: z
		.number()
		.int()
		.positive()
		.optional()
		.describe("Optional click limit added to the agent prompt."),
});
export type StopConditions = z.infer<typeof StopConditionsSchema>;

export const QualityGatesSchema = z.strictObject({
	minScore: z
		.number()
		.min(0)
		.max(1)
		.optional()
		.describe("Optional warning threshold; the workflow uses 0.7 when absent."),
	rejectIncomplete: z
		.boolean()
		.optional()
		.describe(
			"Optional filtering policy; incomplete items are retained when absent.",
		),
	logWarnings: z
		.boolean()
		.optional()
		.describe(
			"Optional detailed-warning policy; warnings are logged when absent.",
		),
	requiredFields: z
		.array(z.string().min(1))
		.optional()
		.describe(
			"Optional fields checked when rejectIncomplete is true; no field filter applies when absent.",
		),
});
export type QualityGates = z.infer<typeof QualityGatesSchema>;

export const ExtractionConfigExpandedSchema = z.strictObject({
	method: ExtractionMethodSchema,
	arrayKey: z.string().min(1),
	siteName: z.string().min(1),
	siteContext: z
		.string()
		.optional()
		.describe(
			"Optional template placeholder context; omitted when a template needs no site-specific context.",
		),
	siteSearchInstructions: z.string().min(1),
	prompt: z.string().min(1),
	schema: JsonValueSchema,
	limit: z
		.number()
		.int()
		.min(1)
		.max(100)
		.optional()
		.describe(
			"Optional item limit; workflow input or vertical defaults apply when absent.",
		),
	fieldMappings: z
		.record(z.string(), z.array(z.string()))
		.optional()
		.describe(
			"Optional source-field mappings; extraction uses vertical defaults and imports use their input mappings when absent.",
		),
	agent: AgentConfigSchema.optional().describe(
		"Optional Firecrawl request controls; provider defaults apply when absent.",
	),
	stopConditions: StopConditionsSchema.optional().describe(
		"Optional prompt instructions bounding navigation; omitted when absent.",
	),
	quality: QualityGatesSchema.optional().describe(
		"Optional extraction quality policy; default warning behavior and no field filtering apply when absent.",
	),
});
export type ExtractionConfigExpanded = z.infer<
	typeof ExtractionConfigExpandedSchema
>;
