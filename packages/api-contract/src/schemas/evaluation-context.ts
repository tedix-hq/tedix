import * as z from "zod";

/** A request to narrow a certified workflow turn, not a grant of authority. */
export const EvaluationRequestSchema = z
	.object({
		policy: z.literal("isolated-evaluation-v1"),
		reviewedAgentsSha256: z.string().regex(/^[a-f0-9]{64}$/),
	})
	.strict();

export type EvaluationRequest = z.infer<typeof EvaluationRequestSchema>;
