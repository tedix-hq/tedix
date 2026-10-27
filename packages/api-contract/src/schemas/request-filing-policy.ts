import * as z from "zod";
import { DecisionModelSchema } from "./jev";
import defaults from "../assets/request-filing.v1.json";

export const RequestFilingPolicySchema = z.strictObject({
	version: z.literal(1),
	autoApplyConfidence: z.number().min(0).max(1),
	choice: z.strictObject({
		model: DecisionModelSchema,
		timeoutMs: z.number().int().min(1).max(24000),
		instructions: z.string().min(1),
		workInstructions: z.string().min(1),
		actionInstructions: z.string().min(1),
	}),
	digestExpiryDays: z.number().int().min(1).max(7),
});

export const REQUEST_FILING_POLICY = RequestFilingPolicySchema.parse(defaults);
