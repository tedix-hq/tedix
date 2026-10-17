import * as z from "zod";
import { OutboundStateSchema } from "./outbound";

export const OUTBOUND_REVIEW_ENTRY = "tedix:app/outbound-review";
export const OutboundReviewConfigSchema = z.strictObject({
	version: z.literal(1),
	projectId: z.uuid().optional(),
	limit: z.number().int().min(1).max(100).default(50),
	initialStatus: OutboundStateSchema.shape.status.optional(),
});
export type OutboundReviewConfig = z.infer<typeof OutboundReviewConfigSchema>;
