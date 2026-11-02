import * as z from "zod";

export const EvaluateLedgerModelInputSchema = z.strictObject({
	surface: z.enum(["status", "intake", "reply", "lesson"]),
	caseId: z.string().min(1).max(80),
	promptVariant: z.enum(["production", "shorter_status"]),
	modelRef: z.enum([
		"azure-openai/gpt-6-astra",
		"azure-openai/gpt-6.1-sol",
		"azure-openai/gpt-6-luna",
	]),
	evaluationId: z.uuid(),
});

export const EvaluateLedgerModelResultSchema = z.strictObject({
	evaluationId: z.uuid(),
	modelRef: EvaluateLedgerModelInputSchema.shape.modelRef,
	surface: EvaluateLedgerModelInputSchema.shape.surface,
	caseId: z.string(),
	promptVariant: EvaluateLedgerModelInputSchema.shape.promptVariant,
	systemHash: z.string(),
	inputHash: z.string(),
	status: z.enum([
		"completed",
		"incomplete",
		"http_error",
		"transport_error",
		"unavailable",
	]),
	output: z.string().nullable(),
	error: z.string().nullable(),
	providerRequestId: z.string().nullable(),
	latencyMs: z.number().nonnegative(),
	usage: z.strictObject({
		inputTokens: z.number().nullable(),
		outputTokens: z.number().nullable(),
		totalTokens: z.number().nullable(),
		cachedInputTokens: z.number().nullable(),
		reasoningTokens: z.number().nullable(),
	}),
});

export type EvaluateLedgerModelInput = z.infer<
	typeof EvaluateLedgerModelInputSchema
>;
