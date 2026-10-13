import * as z from "zod";

const micros = z.number().int().nonnegative().safe();

export const BillingInferenceSpendingInputSchema = z.object({
	limit: z.number().int().min(1).max(200).default(100),
});

export const BillingInferenceSpendingSchema = z.object({
	from: z.iso.datetime(),
	to: z.iso.datetime(),
	hasMore: z.boolean(),
	rows: z.array(
		z.object({
			id: z.string(),
			runId: z.string().nullable(),
			traceId: z.string().nullable(),
			provider: z.string(),
			model: z.string(),
			occurredAt: z.string(),
			creditAppliedMicros: micros,
			customerChargeMicros: micros,
			currency: z.literal("eur"),
			creditValueMicros: z.number().int().positive().safe().nullable(),
			rateVersionId: z.string().nullable(),
		}),
	),
});
export type BillingInferenceSpending = z.infer<
	typeof BillingInferenceSpendingSchema
>;
