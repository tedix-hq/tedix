import * as z from "zod";
import { CardTextSchema } from "./card-revisions";
import { DeckRankExampleSchema } from "./deck-curator";

export const DeckCuratorGrantSchema = z.strictObject({
	tediId: z.uuid(),
	recipientId: z.string().min(1),
	gadgetId: z.uuid(),
	enabled: z.boolean(),
	examples: z.array(DeckRankExampleSchema).max(100).default([]),
});
export const DeckCurationScopeSchema = z.strictObject({
	recipientId: z.string().min(1),
	gadgetId: z.uuid(),
	skipRevisedSince: z.iso.datetime().optional(),
});
export const DeckCurationStateSchema = z.strictObject({
	schema: z.literal("tedix.deck-curation.v1"),
	status: z.enum(["open", "cancelled"]),
	successorId: z.uuid().nullable(),
	penalty: z.number().min(-100).max(0),
	reason: z.string().max(4000),
	evidenceRefs: z.array(z.string().min(1).max(2000)).max(20),
	model: z.string().nullable(),
	exampleIds: z.array(z.string()).max(8),
});
export type DeckCurationState = z.infer<typeof DeckCurationStateSchema>;
export const CurateDeckCardInputSchema = DeckCurationScopeSchema.extend({
	requestId: z.uuid(),
	expectedRequestVersion: z.number().int().positive(),
	expectedRevision: z.number().int().nonnegative(),
	body: CardTextSchema.optional(),
	successorId: z.uuid().optional(),
	reason: CardTextSchema.max(4000),
	evidenceRefs: z.array(z.string().min(1).max(2000)).min(1).max(20),
});
