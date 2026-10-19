import "@orpc/openapi/extensions/route";
import { oc } from "@orpc/contract";
import * as z from "zod";
import { baseErrors } from "../errors";
import {
	AttentionViewInputSchema,
	DeckProjectionSchema,
	DeckCardSchema,
	DecideDeckCardRequestSchema,
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
			.route({
				summary: "Record bounded Deck feedback",
				description:
					"Saves factory usefulness feedback and unprotected, reversible interaction responses. Critical decisions, governed approvals, handoffs and executable effects require their originating OS card or Home approval flow; this endpoint refuses them before writing.",
			})
			.input(DecideDeckCardRequestSchema)
			.output(z.strictObject({ saved: z.literal(true), cardId: z.string() })),
		listFeedForYou: oc
			.input(AttentionViewInputSchema)
			.output(ForYouProjectionSchema),
	});
