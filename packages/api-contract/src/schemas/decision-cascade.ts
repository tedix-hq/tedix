import * as z from "zod";
import { DecisionModelSchema } from "./jev";
import { ModelRefSchema } from "./model-catalog";

const proseModelRef = ModelRefSchema.refine(
	(ref) =>
		!DecisionModelSchema.safeParse(ref.replace(/^workers-ai\//, "")).success,
	{ message: "Bounded decision models cannot draft prose" },
);

export const DecisionCascadePolicySchema = z.strictObject({
	version: z.literal(1),
	revision: z.string().trim().min(1).max(100),
	mode: z.enum(["off", "evaluate"]),
	judgmentModel: DecisionModelSchema,
	draftModelRef: proseModelRef.refine((ref) => ref.startsWith("workers-ai/"), {
		message: "Drafting requires a fixed Workers AI model",
	}),
	strongModelRef: proseModelRef,
	minConfidence: z.number().min(0.5).max(1),
	riskySamples: z.literal(3),
	maxCalls: z.number().int().min(1).max(5),
});
export type DecisionCascadePolicy = z.infer<typeof DecisionCascadePolicySchema>;

/** Invalid, absent and rolled-back policies never enable evaluation. No live promotion yet. */
export function readDecisionCascadePolicy(
	metadata: unknown,
): DecisionCascadePolicy | null {
	const value =
		metadata && typeof metadata === "object" && !Array.isArray(metadata)
			? (metadata as Record<string, unknown>).decisionCascade
			: undefined;
	const parsed = DecisionCascadePolicySchema.safeParse(value);
	return parsed.success && parsed.data.mode === "evaluate" ? parsed.data : null;
}

export const CascadeCitationSchema = z.strictObject({
	id: z.string().trim().min(1).max(200),
	revision: z.string().trim().min(1).max(200),
});
export type CascadeCitation = z.infer<typeof CascadeCitationSchema>;

/** The judgment tier cannot emit a brief or propose arguments. */
export const CascadeJudgmentSchema = z.strictObject({
	label: z.string().trim().min(1).max(100),
	confidence: z.number().min(0).max(1),
	citations: z.array(CascadeCitationSchema).max(20),
});
export const CascadeDraftSchema = CascadeJudgmentSchema.extend({
	brief: z.string().trim().min(1).max(4000),
});
export type CascadeJudgment = z.infer<typeof CascadeJudgmentSchema>;
export type CascadeDraft = z.infer<typeof CascadeDraftSchema>;

/** A receipt describes an admitted send, including invalid or unavailable responses. */
export const CascadeReceiptSchema = z.strictObject({
	executionId: z.string().trim().min(1).max(200),
	requestedModel: z.string().trim().min(1).max(300),
	resolvedModel: z.string().trim().min(1).max(300).nullable(),
	latencyMs: z.number().nonnegative(),
	costMicros: z.number().int().nonnegative().nullable(),
	cacheReadTokens: z.number().int().nonnegative().nullable(),
	cacheWriteTokens: z.number().int().nonnegative().nullable(),
	usagePersisted: z.boolean(),
});
export type CascadeReceipt = z.infer<typeof CascadeReceiptSchema>;
