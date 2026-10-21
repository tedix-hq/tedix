import * as z from "zod";
import { DECISION_GRAPH_EDGE_KINDS } from "./decision-graph";

export const DECISION_GRAPH_BACKFILL_PHASES = [
	"cards",
	"responses",
	"approvals",
	"tedi_approvals",
	"decisions",
	"work_items",
	"relations",
	"comments",
	"instructions",
	"evidence",
] as const;
export const DecisionGraphBackfillCursorSchema = z.strictObject({
	organizationId: z.string().min(1).max(200),
	phase: z.enum(DECISION_GRAPH_BACKFILL_PHASES),
	afterId: z.string().max(200),
});
export type DecisionGraphBackfillCursor = z.infer<
	typeof DecisionGraphBackfillCursorSchema
>;
export const DecisionGraphBackfillPreviewInputSchema = z.strictObject({
	cursor: DecisionGraphBackfillCursorSchema.nullable().default(null),
	limit: z.number().int().min(1).max(50).default(50),
});
export const DecisionGraphBackfillPreviewOutputSchema = z.object({
	scanned: z.number().int().min(0).max(50),
	counts: z.record(z.enum(DECISION_GRAPH_EDGE_KINDS), z.number().int().min(0)),
	nextCursor: DecisionGraphBackfillCursorSchema.nullable(),
});
