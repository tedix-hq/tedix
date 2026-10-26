import "@orpc/openapi/extensions/route";
import { oc } from "@orpc/contract";
import * as z from "zod";
import { baseErrors } from "../errors";
import {
	DeckCurationScopeSchema,
	CurateDeckCardInputSchema,
	DeckRetirementResultSchema,
	MergeDeckCardsInputSchema,
	RetireDeckCardInputSchema,
} from "../schemas/deck-curation";
import { CardRevisionSchema } from "../schemas/card-revisions";
import {
	DeckPipelineStatusSchema,
	MarkDeckCardNotUsefulInputSchema,
	MarkDeckCardNotUsefulResultSchema,
	RemoveDeckRuleInputSchema,
	RemoveDeckRuleResultSchema,
} from "../schemas/deck-pipeline";
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
					"Render the authenticated member’s ranked Decisions here, with full drafts, evidence, answers and authorized actions. Use when decisions deserve attention; terminal hosts receive Markdown links.",
			})
			.input(AttentionViewInputSchema)
			.output(AttentionAppViewSchema),
		showFeed: oc
			.route({
				summary: "Show your Activity",
				description:
					"Render the authenticated member’s ranked Activity (Needs you and Updates) here, including personal-agent findings and provenance. Terminal hosts receive Markdown links.",
			})
			.input(AttentionViewInputSchema)
			.output(AttentionAppViewSchema),
		rankDeckCards: oc
			.route({
				summary: "Rank the caller's Decisions without deciding or hiding cards",
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
			.route({
				summary: "List every card waiting for you",
				description:
					"Read every open decision and factory card waiting for you. This is read-only and does not answer, approve, change or hide any card.",
			})
			.input(
				AttentionViewInputSchema.extend({
					presentation: z
						.enum(["generate", "stored"])
						.default("generate")
						.describe(
							"Use stored for a projection read without generating or saving card presentation text. The default prepares display copy as needed.",
						),
				}),
			)
			.output(DeckProjectionSchema),
		getDeckCard: oc
			.route({
				summary: "Read one card waiting for you",
				description:
					"Read one open decision or factory card without answering or changing it.",
			})
			.input(
				AttentionViewInputSchema.extend({
					cardId: z.string().min(1),
					retrySummary: z.boolean().optional(),
				}),
			)
			.output(DeckCardSchema),
		decideDeckCard: oc
			.route({
				summary: "Answer a card waiting for you",
				description:
					"Answer a Decisions card. For kind factory_changes, ask the factory to rewrite the draft card; each round creates a new revision of the same draft. Use kind factory_restore to restore an earlier revision. This does not approve or execute the card.",
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
					"Correct a card's display text as its recipient or a scoped Decisions curator, with immutable audit history. The recipient needs no gadget grant and may correct credential-related text; curators may not. Supply presentation for a direct face correction without a creator session. handleInternally creates only a reversible internal task under the active organization autonomy policy as its owning agent; never answers or sends as the recipient.",
			})
			.input(CurateDeckCardInputSchema)
			.output(CardRevisionSchema),
		retireDeckCard: oc
			.route({
				summary: "Retire a Decisions card without answering it",
				description:
					"Takes a card out of the recipient's Decisions as expired, handled elsewhere, superseded, no longer relevant or a duplicate, with immutable undo history. Never answers, approves or executes the card. The recipient may retire any card; agents may retire non-critical cards they own or curate, and their own duplicates of a card that keeps the same protected ask.",
			})
			.input(RetireDeckCardInputSchema)
			.output(DeckRetirementResultSchema),
		mergeDeckCards: oc
			.route({
				summary: "Merge duplicate Decisions cards into one",
				description:
					"Keeps one live card and retires each duplicate of the same Work Item or ask as a linked duplicate, with undo history. A protected duplicate merges only into a card that is protected too.",
			})
			.input(MergeDeckCardsInputSchema)
			.output(
				z.strictObject({
					keptId: z.uuid(),
					retired: z.array(DeckRetirementResultSchema),
				}),
			),
		getDeckPipelineStatus: oc
			.route({
				summary: "Read how Decisions is being cleaned",
				description:
					"When the Decisions sweep last ran (and whether it is overdue), the rules learned from the person's Not useful reasons, and week-1 metrics: cards at 08:30, share marked not useful and undone removals.",
			})
			.input(z.strictObject({}))
			.output(DeckPipelineStatusSchema),
		markDeckCardNotUseful: oc
			.route({
				summary: "Mark a Decisions card not useful, with the reason",
				description:
					"The recipient's own feedback: already decided, expired, agent could do this, duplicate or not for me. Retires the card without answering it (undo restores it), teaches the Decisions ranker immediately, and three identical reasons from one source become a learned rule the person can remove. Declining a card is a different action.",
			})
			.input(MarkDeckCardNotUsefulInputSchema)
			.output(MarkDeckCardNotUsefulResultSchema),
		removeDeckRule: oc
			.route({
				summary: "Remove a learned Decisions rule",
				description:
					"Removes one rule Decisions learned from the person's repeated Not useful reasons. Only the person the rule serves can remove it.",
			})
			.input(RemoveDeckRuleInputSchema)
			.output(RemoveDeckRuleResultSchema),
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
