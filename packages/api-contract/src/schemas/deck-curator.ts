import * as z from "zod";
import ranker from "../assets/deck-ranker.v1.json";

/** Inference selects display order only. This configuration grants no card authority. */
export const DeckCuratorRankerConfigSchema = z.strictObject({
	version: z.literal(1).default(1),
	enabled: z.boolean().default(false),
	model: z.string().min(1).max(200).default("@cf/qwen/qwen3-30b-a3b-fp8"),
	instructions: z.string().trim().min(1).max(8000).default(ranker.instructions),
	threshold: z.number().min(0).max(1).default(0.5),
	noisePenalty: z.number().nonnegative().max(100).default(10),
	timeoutMs: z.number().int().min(100).max(20000).default(5000),
	runTimeoutMs: z.number().int().min(100).max(10000).default(8000),
	perRunReservationMicros: z.number().int().min(0).max(1000000).default(250000),
	dailyReservationMicros: z
		.number()
		.int()
		.min(0)
		.max(10000000)
		.default(1000000),
	perCardReservationMicros: z
		.number()
		.int()
		.min(1000)
		.max(100000)
		.default(5000),
});
export type DeckCuratorRankerConfig = z.infer<
	typeof DeckCuratorRankerConfigSchema
>;

export const DeckRankExampleSchema = z.strictObject({
	id: z.string().min(1).max(200),
	cardId: z.string().min(1).max(200),
	title: z.string().trim().min(1).max(500),
	summary: z.string().trim().min(1).max(2000),
	label: z.enum(["VALUABLE", "NOISE"]),
	evidenceRef: z.string().min(1).max(2000),
	decidedAt: z.iso.datetime(),
});
export type DeckRankExample = z.infer<typeof DeckRankExampleSchema>;

export const DeckRankSignalSchema = z.strictObject({
	cardId: z.string(),
	label: z.enum(["VALUABLE", "NOISE"]).nullable(),
	penalty: z.number().nonpositive(),
	reason: z.enum([
		"critical",
		"valuable",
		"ranked_lower",
		"disabled",
		"insufficient_examples",
		"budget_exhausted",
		"time_budget",
		"model_failed",
	]),
	exampleIds: z.array(z.string()).max(8),
});
export type DeckRankSignal = z.infer<typeof DeckRankSignalSchema>;
