import * as z from "zod";
import { FactSchema } from "./memory-graph";

export const MemoryBrowseInputSchema = z.strictObject({
	view: z.enum(["observations", "stale", "contradictions", "gaps"]),
	search: z.string().max(500).optional(),
	domainId: z.string().optional(),
	minConfidence: z.number().min(0).max(1).optional(),
	orderBy: z.enum(["updated", "confidence"]).default("updated"),
	limit: z.number().int().min(1).max(25).default(20),
	offset: z.number().int().min(0).max(100_000).default(0),
});

export const MemoryBrowseOutputSchema = z.strictObject({
	facts: z.array(FactSchema),
	nextOffset: z.number().nullable(),
});
