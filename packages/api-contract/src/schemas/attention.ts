import * as z from "zod";
import { DeckPipelineStatusSchema } from "./deck-pipeline";
import {
	CardHistorySchema,
	CardTextSchema,
	CardFeedbackFieldSchema,
	CardFeedbackAnchorSchema,
} from "./card-revisions";
import { JsonValueSchema } from "./common";
import { DecisionEnvelopeSchema } from "./os-decision-deck";
import { DecisionCardPresentationSchema } from "./decision-card-presentation";
import { ActivityFeedItemSchema } from "./os-activity-feed";
import {
	WorkInteractionInboxRowSchema,
	RespondToWorkInteractionInputSchema,
} from "./work-interactions";
import {
	WorkApprovalInboxRowSchema,
	DecideWorkApprovalProposalInputSchema,
} from "./work-approvals";
import { ApprovalRequestSchema } from "../contracts/tedi-approvals";

const AttentionTimeZoneSchema = z
	.string()
	.min(1)
	.max(100)
	.refine((value) => {
		try {
			new Intl.DateTimeFormat("en", { timeZone: value });
			return true;
		} catch {
			return false;
		}
	}, "Unknown IANA timezone");
export const AttentionViewInputSchema = z.strictObject({
	gadgetId: z
		.uuid()
		.optional()
		.describe(
			"Select the same Work app as the OS; required when several apps have this role.",
		),
	projectId: z.uuid().optional(),
	timeZone: AttentionTimeZoneSchema.optional(),
	limit: z.number().int().min(1).max(100).default(50),
});
/** What a card asks of the person; derived from typed card data, never stored. */
export const DeckAskKindSchema = z.enum([
	"task",
	"send",
	"decide",
	"approve_draft",
	"answer",
	"consent",
]);
export type DeckAskKind = z.infer<typeof DeckAskKindSchema>;
export const DeckOwnerTaskSchema = z.strictObject({
	presence: z.enum(["login", "mfa", "consent"]),
	steps: z.array(z.string().trim().min(1).max(1000)).min(1).max(20),
	estimatedMinutes: z.number().int().min(1).max(480),
});
export const DeckResponseOptionSchema = z.strictObject({
	id: z.string().min(1).max(100),
	label: z.string().min(1).max(120),
	body: z.string().max(2000).optional(),
});
export const DeckCardSchema = z.strictObject({
	history: CardHistorySchema.optional(),
	id: z.string().min(1),
	kind: z.string(),
	label: z.string(),
	presentation: DecisionCardPresentationSchema.nullable().optional(),
	faceText: z.string().optional(),
	project: z.string(),
	urgency: z.string(),
	decision: DecisionEnvelopeSchema.nullable(),
	source: z.string(),
	requestedAt: z.string(),
	dueAt: z.string().nullable(),
	askKind: DeckAskKindSchema.optional(),
	responseKind: z.enum(["choice", "open", "task"]).optional(),
	responseOptions: z.array(DeckResponseOptionSchema).max(8).optional(),
	ownerTask: DeckOwnerTaskSchema.nullable().optional(),
	actionable: z.boolean().optional(),
	blocksCount: z.number().int().min(0).optional(),
	/** Graph score: items waiting on this card directly or indirectly. Ranks ahead of blocksCount when present. */
	blocksScore: z.number().int().min(0).optional(),
	/** Earliest known deadline: request due date, decision expiry or approval expiry. */
	deadline: z.string().nullable().optional(),
	overdue: z.boolean().optional(),
	/** The ask's Work Item is completed or cancelled; retire the card, never show it as overdue. */
	handled: z.boolean().optional(),
	/** The ask's own expiry passed; retire the card as expired, never show it as overdue. */
	expired: z.boolean().optional(),
	/** A ready message draft that has waited longer than the Deck's staleDraftHours. */
	draftedNotSent: z.boolean().optional(),
	score: z.number(),
	interaction: WorkInteractionInboxRowSchema.optional(),
	workApproval: WorkApprovalInboxRowSchema.optional(),
	runtimeApproval: ApprovalRequestSchema.optional(),
	factory: z
		.strictObject({
			outputId: z.uuid(),
			sourceIndex: z.number().int().min(0),
			rowIndex: z.number().int().min(0),
			revision: z.number().int(),
			policyCritical: z.boolean().optional(),
			/** The factory's own 0–1 priority; the Deck sorts by it after critical cards. */
			score: z.number().min(0).max(1).optional(),
			draft: z.string(),
			why: z.string(),
			sourceText: z.string(),
		})
		.optional(),
});
export type DeckCard = z.infer<typeof DeckCardSchema>;
export const DeckProjectionSchema = z.strictObject({
	cards: z.array(DeckCardSchema),
	count: z.number().int().min(0),
	complete: z.boolean(),
	observedAt: z.iso.datetime(),
	/** Last sweep, staleness alarm, learned rules and week-1 metrics. */
	pipeline: DeckPipelineStatusSchema.optional(),
});
export const DecideDeckCardInputSchema = z.discriminatedUnion("kind", [
	z.strictObject({
		kind: z.literal("factory_changes"),
		cardId: z.string().min(1),
		gadgetId: z.uuid().optional(),
		timeZone: AttentionTimeZoneSchema.optional(),
		expectedRevision: z.number().int().positive(),
		instruction: CardTextSchema.max(8000),
	}),
	z.strictObject({
		kind: z.literal("factory_restore"),
		cardId: z.string().min(1),
		gadgetId: z.uuid().optional(),
		timeZone: AttentionTimeZoneSchema.optional(),
		expectedRevision: z.number().int().positive(),
		restoreRevision: z.number().int().positive(),
	}),
	z.strictObject({
		kind: z.literal("request_changes"),
		cardId: z.uuid(),
		gadgetId: z.uuid().optional(),
		timeZone: AttentionTimeZoneSchema.optional(),
		expectedRequestVersion: z.number().int().positive(),
		instruction: CardTextSchema.max(8000),
		field: CardFeedbackFieldSchema.optional(),
		chips: z.array(CardTextSchema.max(80)).max(3).optional(),
		anchors: z.array(CardFeedbackAnchorSchema).max(20).optional(),
	}),
	z.strictObject({
		kind: z.literal("restore_revision"),
		cardId: z.uuid(),
		gadgetId: z.uuid().optional(),
		timeZone: AttentionTimeZoneSchema.optional(),
		expectedRequestVersion: z.number().int().positive(),
		expectedRevision: z.number().int().positive(),
		restoreRevision: z.number().int().positive(),
	}),
	z.strictObject({
		kind: z.literal("factory"),
		cardId: z.string().min(1),
		gadgetId: z.uuid().optional(),
		timeZone: AttentionTimeZoneSchema.optional(),
		expectedRevision: z.number().int().positive(),
		verdict: z.enum(["useful", "not_useful"]),
		reason: CardTextSchema.max(2000),
	}),
	z.strictObject({
		kind: z.literal("interaction"),
		gadgetId: z.uuid().optional(),
		timeZone: AttentionTimeZoneSchema.optional(),
		decision: RespondToWorkInteractionInputSchema,
	}),
	z.strictObject({
		kind: z.literal("work_approval"),
		gadgetId: z.uuid().optional(),
		timeZone: AttentionTimeZoneSchema.optional(),
		decision: DecideWorkApprovalProposalInputSchema,
	}),
	z.strictObject({
		kind: z.literal("runtime_approval"),
		gadgetId: z.uuid().optional(),
		timeZone: AttentionTimeZoneSchema.optional(),
		decision: z.strictObject({
			id: z.uuid(),
			status: z.enum(["approved", "rejected"]),
			resolution: z.string().max(2000).optional(),
		}),
	}),
]);
/** Object envelope for native schema projection; the nested union retains domain narrowing. */
export const DecideDeckCardRequestSchema = z.strictObject({
	decision: DecideDeckCardInputSchema.describe(
		"Factory usefulness feedback or a bounded, unprotected interaction response. Governed and critical decisions are refused with OS/Home guidance.",
	),
});

export const FocusItemSchema = ActivityFeedItemSchema.extend({
	score: z.number(),
	unseen: z.boolean(),
	deadline: z.boolean(),
	because: z.string().optional(),
	factors: z.record(z.string(), z.number()),
});
export const ForYouProjectionSchema = z.strictObject({
	items: z.array(FocusItemSchema),
	heldCount: z.number().int().min(0),
	used: z.number().int().min(0),
	day: z.string(),
	complete: z.boolean(),
	/** Named sources that could not be fully read; empty when complete. */
	incompleteSources: z.array(z.string()).optional(),
	observedAt: z.iso.datetime(),
});

export const AttentionCardActionSchema = z.strictObject({
	id: z.string(),
	label: z.string(),
	arguments: z.record(z.string(), JsonValueSchema),
	textPath: z.string().nullable(),
	textArgumentPath: z.string().nullable(),
	statusPath: z.string(),
});
export const AttentionDisplayCardSchema = z.strictObject({
	id: z.string(),
	kind: z.string(),
	ask: z.string(),
	context: z.string().nullable().optional(),
	confidence: z.number().min(0).max(1).nullable().optional(),
	ifYes: z.string().nullable(),
	why: z.string().nullable(),
	stakes: z.string().nullable(),
	provenance: z.string().nullable(),
	evidenceUrl: z.string().nullable(),
	dueAt: z.string().nullable(),
	askKind: DeckAskKindSchema.nullable().optional(),
	responseKind: z.enum(["choice", "open", "task"]).optional(),
	ownerTask: DeckOwnerTaskSchema.nullable().optional(),
	askLabel: z.string().nullable().optional(),
	overdue: z.boolean().optional(),
	handled: z.boolean().optional(),
	expired: z.boolean().optional(),
	draftedNotSent: z.boolean().optional(),
	source: z.string(),
	draft: z.string().nullable(),
	recipient: z.string().nullable(),
	subject: z.string().nullable(),
	options: z.array(
		z.strictObject({
			id: z.string(),
			label: z.string(),
			consequence: z.string().nullable(),
		}),
	),
	actions: z.array(AttentionCardActionSchema),
	answer: z.string(),
	needsText: z.boolean(),
	status: z.string().nullable(),
});
export type AttentionDisplayCard = z.infer<typeof AttentionDisplayCardSchema>;
export const AttentionAppViewSchema = z.strictObject({
	cards: z.array(AttentionDisplayCardSchema),
	needsYou: z.array(AttentionDisplayCardSchema),
	updates: z.array(AttentionDisplayCardSchema),
	complete: z.boolean(),
	/** Named sources that could not be fully read; empty when complete. */
	incompleteSources: z.array(z.string()).optional(),
	observedAt: z.iso.datetime(),
	empty: z.boolean(),
	notice: z.string(),
	markdown: z.string(),
});

export const AttentionOfferedChoicesSchema = z.object({
	decisionCard: z
		.object({
			options: z
				.array(
					z.object({
						id: z.string(),
						label: z.string(),
						body: z.string().optional(),
					}),
				)
				.max(8),
		})
		.optional(),
	suggestedAnswers: z.array(z.string()).max(8).optional(),
});
