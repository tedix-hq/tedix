import "@orpc/openapi/extensions/route";
import { oc } from "@orpc/contract";
import * as z from "zod";
import { baseErrors } from "../errors";
import {
	DeckCurationScopeSchema,
	CurateDeckCardInputSchema,
} from "../schemas/deck-curation";
import { CardRevisionSchema } from "../schemas/card-revisions";
import { WorkInteractionInboxRowSchema } from "../schemas/work-interactions";
import { DeckRankSignalSchema } from "../schemas/deck-curator";
import {
	AttentionViewInputSchema,
	AttentionAppViewSchema,
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
		SERVICE_UNAVAILABLE: { message: "The writing agent is unavailable" },
	})
	.router({
		showDeck: oc
			.route({
				summary: "Show decisions that need you",
				description:
					"Render the authenticated member’s ranked decision Deck here, with full drafts, evidence, answers and authorized actions. Use when decisions deserve attention; terminal hosts receive Markdown links.",
			})
			.input(AttentionViewInputSchema)
			.output(AttentionAppViewSchema),
		showFeed: oc
			.route({
				summary: "Show your For you feed",
				description:
					"Render the authenticated member’s ranked Needs you and Updates feed here, including personal-agent findings and provenance. Terminal hosts receive Markdown links.",
			})
			.input(AttentionViewInputSchema)
			.output(AttentionAppViewSchema),
		rankDeckCards: oc
			.route({
				summary: "Rank the caller's Deck without deciding or hiding cards",
			})
			.input(AttentionViewInputSchema)
			.output(
				z.strictObject({
					cards: z.array(DeckCardSchema).max(100),
					signals: z.array(DeckRankSignalSchema).max(100),
					reservedMicros: z.number().int().nonnegative(),
					observedAt: z.iso.datetime(),
				}),
			),
		listDeckCards: oc
			.input(AttentionViewInputSchema)
			.output(DeckProjectionSchema),
		getDeckCard: oc
			.input(
				AttentionViewInputSchema.extend({
					cardId: z.string().min(1),
					retrySummary: z.boolean().optional(),
				}),
			)
			.output(DeckCardSchema),
		decideDeckCard: oc
			.route({
				summary: "Record bounded Deck feedback",
				description:
					"Requests agent rewrites, restores content revisions, saves factory usefulness feedback and records unprotected, reversible interaction responses. Revision actions use their source owner and never approve or execute the card. Critical decisions, governed approvals, handoffs and executable effects require their originating OS card or Home approval flow.",
			})
			.input(DecideDeckCardRequestSchema)
			.output(z.strictObject({ saved: z.literal(true), cardId: z.string() })),
		curationInbox: oc
			.route({
				summary: "Read the explicitly delegated recipient curation inbox",
			})
			.input(DeckCurationScopeSchema)
			.output(
				z.strictObject({
					items: z.array(WorkInteractionInboxRowSchema),
					complete: z.boolean(),
					observedAt: z.iso.datetime(),
				}),
			),
		curateDeckCard: oc
			.route({
				summary:
					"Revise or supersede a delegated card with immutable undo history. handleInternally creates only a reversible internal task under the active organization autonomy policy as its owning agent; never answers or sends as the recipient.",
			})
			.input(CurateDeckCardInputSchema)
			.output(CardRevisionSchema),
		rankCurationInbox: oc
			.route({
				summary:
					"Persist negative-only rank signals for a delegated recipient inbox",
			})
			.input(DeckCurationScopeSchema)
			.output(
				z.strictObject({
					signals: z.array(DeckRankSignalSchema),
					reservedMicros: z.number().int().nonnegative(),
				}),
			),
		listFeedForYou: oc
			.input(AttentionViewInputSchema)
			.output(ForYouProjectionSchema),
	});
