import { oc } from "@orpc/contract";
import * as z from "zod";
import { baseErrors } from "../errors";
import {
	AttentionViewInputSchema,
	DeckProjectionSchema,
	DeckCardSchema,
	DecideDeckCardInputSchema,
	ForYouProjectionSchema,
} from "../schemas/attention";

/** Headless projections of the caller's OS apps; record/effect owners retain authorization. */
export const attentionContract = oc
	.errors({
		...baseErrors,
		CONFLICT: { message: "Attention projection changed or is incomplete" },
	})
	.router({
		listDeckCards: oc
			.input(AttentionViewInputSchema)
			.output(DeckProjectionSchema),
		getDeckCard: oc
			.input(AttentionViewInputSchema.extend({ cardId: z.string().min(1) }))
			.output(DeckCardSchema),
		decideDeckCard: oc
			.input(DecideDeckCardInputSchema)
			.output(z.strictObject({ saved: z.literal(true), cardId: z.string() })),
		listFeedForYou: oc
			.input(AttentionViewInputSchema)
			.output(ForYouProjectionSchema),
	});
