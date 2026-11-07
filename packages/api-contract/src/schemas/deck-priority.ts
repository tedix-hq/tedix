import * as z from "zod";

export const DeckPriorityBandSchema = z.enum(["today", "week", "whenever"]);
export type DeckPriorityBand = z.infer<typeof DeckPriorityBandSchema>;

export const DeckPriorityFactorSchema = z.enum([
	"overdue",
	"deadline",
	"blocks",
	"cost",
	"risk",
	"objective",
	"waiting",
	"none",
]);
export type DeckPriorityFactor = z.infer<typeof DeckPriorityFactorSchema>;

/** One ask's priority: the shared score, its band and the top factor in plain words. */
export const DeckPrioritySchema = z.strictObject({
	score: z.number(),
	band: DeckPriorityBandSchema,
	factor: DeckPriorityFactorSchema,
	reason: z.string().min(1).max(80),
	/** The deadline the score used: the ask's own or its Work Item's. */
	deadline: z.string().nullable(),
});
export type DeckPriority = z.infer<typeof DeckPrioritySchema>;

/** Facts about the Work an ask is filed under that rank it; server-read. */
export const DeckSourceWorkFactsSchema = z.strictObject({
	dueDate: z.string().nullable(),
	deadline: z.string().nullable(),
	riskLevel: z.string().nullable(),
	/** Accepted Work Items that wait on this Work through a blocks relation. */
	blocksCount: z.number().int().min(0),
	/** At least one of those waiting items has a live Attempt. */
	blocksRunning: z.boolean(),
});
export type DeckSourceWorkFacts = z.infer<typeof DeckSourceWorkFactsSchema>;
