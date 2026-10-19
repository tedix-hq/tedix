import * as z from "zod";
import { DecisionEnvelopeSchema } from "./os-decision-deck";
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
	id: z.string().min(1),
	kind: z.string(),
	label: z.string(),
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
		kind: z.literal("factory"),
		cardId: z.string().min(1),
		gadgetId: z.uuid().optional(),
		timeZone: AttentionTimeZoneSchema.optional(),
		expectedRevision: z.number().int().positive(),
		verdict: z.enum(["useful", "not_useful"]),
		reason: z.string().trim().min(1).max(2000),
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
