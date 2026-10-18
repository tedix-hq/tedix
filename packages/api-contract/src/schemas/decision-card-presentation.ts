import * as z from "zod";

/** Generated display copy. It carries no options, effects or authority. */
export const DecisionCardPresentationSchema = z.strictObject({
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

export const RegenerateDecisionCardInputSchema = z.strictObject({
	requestId: z.uuid(),
	expectedRequestVersion: z.number().int().positive(),
});

export type DecisionCardPresentation = z.infer<
	typeof DecisionCardPresentationSchema
>;
