import * as z from "zod";

const identity = z.string().trim().min(1).max(200);
const timestamp = z.iso.datetime();
const rate = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);

/** Provider cost evidence, independent of customer prices and admission ceilings. */
export const ProviderModelRateFieldsSchema = z.strictObject({
	provider: identity.describe(
		"Exact canonical provider identifier; no model-prefix normalization.",
	),
	modelId: identity.describe("Exact provider-native model identifier."),
	deploymentScope: z
		.string()
		.trim()
		.min(1)
		.max(500)
		.describe(
			"Exact nonempty account/deployment/region scope; no provider-wide or inferred scope.",
		),
	inputTokenMin: z
		.number()
		.int()
		.min(0)
		.max(Number.MAX_SAFE_INTEGER)
		.default(0)
		.describe("Inclusive prompt input-token count, including cached tokens."),
	inputTokenMax: z
		.number()
		.int()
		.positive()
		.max(Number.MAX_SAFE_INTEGER)
		.nullable()
		.default(null)
		.describe(
			"Exclusive prompt input-token count, or null for no upper bound.",
		),
	effectiveFrom: timestamp.describe(
		"Inclusive UTC start of the evidence-backed rate version.",
	),
	inputMicrousdPerMillion: rate,
	outputMicrousdPerMillion: rate,
	cacheReadMicrousdPerMillion: rate,
	cacheWriteMicrousdPerMillion: rate,
	currency: z.literal("USD"),
	evidenceUri: z
		.url()
		.max(2048)
		.describe(
			"Stable URI of the retained reviewed source artifact; no fetching or authenticity attestation is implied.",
		),
	evidenceDigest: z
		.string()
		.regex(/^[a-f0-9]{64}$/)
		.describe(
			"SHA-256 of the exact reviewed artifact bytes, not the URL or price fields.",
		),
	verifiedAt: timestamp.describe(
		"When the publisher verified the supporting provider evidence.",
	),
	changeReason: z.string().trim().min(1).max(2000),
});

export const PublishProviderModelRateInputSchema =
	ProviderModelRateFieldsSchema.extend({
		supersedesRateVersionId: z
			.uuid()
			.nullable()
			.describe(
				"Null for an initial future publication; a current leaf UUID for a future replacement or same-start correction. Existing usage is never repriced.",
			),
	}).refine(
		(value) =>
			value.inputTokenMax === null || value.inputTokenMax > value.inputTokenMin,
		{
			message: "Input-token range must have positive width",
			path: ["inputTokenMax"],
		},
	);

export const ProviderModelRateSchema = ProviderModelRateFieldsSchema.extend({
	id: z.uuid(),
	supersedesRateVersionId: z
		.uuid()
		.nullable()
		.describe(
			"Prior immutable version replaced or corrected by this publication, or null for an original version.",
		),
	publishedAt: timestamp,
	publishedBy: z.string().min(1),
});

export const ListProviderModelRatesInputSchema = z.strictObject({
	provider: identity.optional().describe("Optional exact provider filter."),
	modelId: identity
		.optional()
		.describe("Optional exact provider-native model filter."),
	afterId: z
		.uuid()
		.optional()
		.describe("Exclusive UUID cursor from the preceding page."),
	limit: z.number().int().min(1).max(100).default(50),
});
