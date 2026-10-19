import * as z from "zod";
import { CardHistorySchema, CardTextSchema } from "./card-revisions";
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
