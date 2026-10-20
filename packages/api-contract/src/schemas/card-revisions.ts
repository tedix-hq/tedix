import * as z from "zod";
import { CARD_SECRET_MESSAGE, containsCardSecret } from "../utils/card-secrets";
import { WorkProposalMetadataSchema } from "./work-interactions";

export const CardTextSchema = z
	.string()
	.trim()
	.min(1)
	.max(40000)
	.refine((value) => !containsCardSecret(value), CARD_SECRET_MESSAGE);
export const CardFeedbackFieldSchema = z.enum([
	"draft",
	"title",
	"body",
	"recommendation",
	"plan",
]);
export const CardFeedbackAnchorSchema = z.strictObject({
	quote: CardTextSchema.max(8000),
	prefix: z
		.string()
		.max(200)
		.refine((value) => !containsCardSecret(value), CARD_SECRET_MESSAGE),
	suffix: z
		.string()
		.max(200)
		.refine((value) => !containsCardSecret(value), CARD_SECRET_MESSAGE),
	field: CardFeedbackFieldSchema,
	chip: CardTextSchema.max(80).optional(),
	note: CardTextSchema.max(2000).optional(),
});
export type CardFeedbackAnchor = z.infer<typeof CardFeedbackAnchorSchema>;
export const CardRevisionSchema = z.strictObject({
	id: z.uuid(),
	orgId: z.string().min(1),
	requestId: z.uuid(),
	revision: z.number().int().positive(),
	body: z.string(),
	proposal: WorkProposalMetadataSchema.shape.proposal.nullable().default(null),
	cause: z.enum(["initial", "agent_rewrite", "human_edit", "restore"]),
	actorType: z.string(),
	actorId: z.string(),
	actorSessionId: z.string().nullable(),
	instruction: z.string().nullable(),
	responseId: z.uuid().nullable(),
	createdAt: z.iso.datetime(),
});
export type CardRevision = z.infer<typeof CardRevisionSchema>;
export const FactoryCardPendingRevisionSchema = z.strictObject({
	cardId: z.string(),
	instruction: z.string(),
	sourceRevision: z.number().int().positive(),
	runId: z.string(),
});
export const CardHistoryInputSchema = z.strictObject({
	requestId: z.uuid(),
	beforeRevision: z.number().int().positive().optional(),
});
export const RequestCardChangesInputSchema = CardHistoryInputSchema.extend({
	expectedRequestVersion: z.number().int().positive(),
	instruction: CardTextSchema.max(8000),
	field: CardFeedbackFieldSchema.optional(),
	chips: z.array(CardTextSchema.max(80)).max(3).optional(),
	anchors: z.array(CardFeedbackAnchorSchema).max(20).optional(),
});
export const ReviseCardInputSchema = CardHistoryInputSchema.extend({
	expectedRequestVersion: z.number().int().positive(),
	expectedRevision: z.number().int().nonnegative(),
	body: CardTextSchema.optional(),
	proposal: WorkProposalMetadataSchema.shape.proposal
		.refine((value) => !containsCardSecret(value), CARD_SECRET_MESSAGE)
		.optional(),
	responseId: z.uuid().optional(),
	restoreRevision: z.number().int().positive().optional(),
}).refine(
	(value) => Boolean(value.body) !== Boolean(value.restoreRevision),
	"Provide revised text or a version to restore",
);
export const CardHistorySchema = z.strictObject({
	revisions: z.array(CardRevisionSchema),
	nextBeforeRevision: z.number().int().positive().nullable(),
	pending: z
		.strictObject({
			responseId: z.uuid(),
			instruction: z.string(),
			requestedAt: z.string(),
		})
		.nullable(),
});
