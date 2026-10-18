import * as z from "zod";
import copySpec from "../assets/decision-card-copy.v2.json";

/** Generated display copy. It carries no options, effects or authority. */
const LegacyDecisionCardPresentationSchema = z.strictObject({
	version: z.literal(1),
	model: z.string().optional(),
	generatedAt: z.iso.datetime().optional(),
	title: z
		.string()
		.trim()
		.min(1)
		.max(90)
		.refine((text) => !/[\n\r]/.test(text)),
	body: z
		.string()
		.trim()
		.min(1)
		.max(600)
		.refine((text) => {
			const sentences = text.match(/[^.!?]+[.!?]+(?:\s|$)/g);
			return Boolean(sentences && sentences.length <= 2 && /[.!?]$/.test(text));
		}, "Use one or two sentences"),
	recommendation: z
		.string()
		.trim()
		.min(10)
		.max(400)
		.refine(
			(text) => /\bbecause\b/i.test(text),
			"Give the recommendation and its reason",
		),
});

const line = (limit: number) =>
	z
		.string()
		.trim()
		.min(1)
		.max(limit)
		.refine((text) => !/[\n\r]/.test(text));

/** Existing field names retain their transport shape: ASK, IF YES, WHY. */
export const DecisionCardPresentationSchema = z.union([
	LegacyDecisionCardPresentationSchema,
	z.strictObject({
		version: z.literal(2),
		model: z.string().optional(),
		generatedAt: z.iso.datetime().optional(),
		title: line(copySpec.fields.title.maxLength).refine((text) =>
			text.endsWith("?"),
		),
		body: line(copySpec.fields.body.maxLength),
		recommendation: line(copySpec.fields.recommendation.maxLength),
		stakes: line(copySpec.stakesMaxLength).optional(),
	}),
]);

export const RegenerateDecisionCardInputSchema = z.strictObject({
	requestId: z.uuid(),
	expectedRequestVersion: z.number().int().positive(),
});

export type DecisionCardPresentation = z.infer<
	typeof DecisionCardPresentationSchema
>;
