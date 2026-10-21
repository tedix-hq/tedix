import * as z from "zod";
import { CardTextSchema } from "./card-revisions";
import { DeckRankExampleSchema } from "./deck-curator";
import { DecisionCardPresentationSchema } from "./decision-card-presentation";

export const DeckCuratorGrantSchema = z.strictObject({
	tediId: z.uuid(),
	recipientId: z.string().min(1),
	gadgetId: z.uuid(),
	enabled: z.boolean(),
	examples: z.array(DeckRankExampleSchema).max(100).default([]),
	trigger: z
		.strictObject({
			enabled: z.boolean(),
			skillId: z.uuid(),
			debounceSeconds: z.number().int().min(1).max(3600).default(60),
		})
		.optional(),
});
export const DeckCurationScopeSchema = z.strictObject({
	recipientId: z.string().min(1),
	gadgetId: z.uuid(),
	skipRevisedSince: z.iso.datetime().optional(),
});
/** Why a card left the Deck without being answered. */
export const DeckRetirementReasonSchema = z.enum([
	"expired",
	"handled_elsewhere",
	"superseded",
	"no_longer_relevant",
	"duplicate",
]);
export type DeckRetirementReason = z.infer<typeof DeckRetirementReasonSchema>;
export const DeckRetirementSchema = z.strictObject({
	reason: DeckRetirementReasonSchema,
	/** The Work Item that handles or supersedes the ask, when one exists. */
	workItemId: z.uuid().nullable(),
});
export const DeckCurationStateSchema = z.strictObject({
	schema: z.literal("tedix.deck-curation.v1"),
	revision: z.number().int().positive().nullable().default(null),
	draftBody: z.string().max(40000).nullable().default(null),
	status: z.enum(["open", "cancelled"]),
	internalTask: z
		.strictObject({
			taskId: z.uuid(),
			classId: z.string().min(1).max(100),
			actorType: z.enum(["tedi", "external_agent"]),
			actorId: z.string().min(1),
			handledAt: z.iso.datetime(),
			policyPack: z
				.strictObject({ id: z.string(), version: z.number() })
				.optional(),
		})
		.optional(),
	successorId: z.uuid().nullable(),
	penalty: z.number().min(-100).max(0),
	reason: z.string().max(4000),
	evidenceRefs: z.array(z.string().min(1).max(2000)).max(20),
	model: z.string().nullable(),
	exampleIds: z.array(z.string()).max(8),
	retirement: DeckRetirementSchema.optional(),
	/** The recipient's "Not useful" chip; kept apart from a declined answer. */
	notUseful: z
		.strictObject({
			reason: z.enum([
				"already_decided",
				"expired",
				"agent_could_do",
				"duplicate",
				"not_for_me",
			]),
			sourceKey: z.string().max(300),
			classKey: z.string().max(300),
		})
		.optional(),
	/** Shadow ranking: Qwen label and the second key's NOISE probability. */
	shadow: z
		.strictObject({
			label: z.enum(["VALUABLE", "NOISE"]).nullable(),
			secondKeyNoise: z.number().min(0).max(1).nullable(),
			wouldHide: z.boolean(),
			classKey: z.string().max(300),
			at: z.iso.datetime(),
		})
		.optional(),
});
export type DeckCurationState = z.infer<typeof DeckCurationStateSchema>;
export const CurateDeckCardInputSchema = DeckCurationScopeSchema.extend({
	gadgetId: z.uuid().optional(),
	requestId: z.uuid(),
	expectedRequestVersion: z.number().int().positive(),
	expectedRevision: z.number().int().nonnegative(),
	body: CardTextSchema.optional(),
	/** Display copy only; leaves the original decision and executable effects intact. */
	presentation: DecisionCardPresentationSchema.optional(),
	successorId: z.uuid().optional(),
	handleInternally: z.boolean().optional(),
	reason: CardTextSchema.max(4000),
	evidenceRefs: z.array(z.string().min(1).max(2000)).min(1).max(20),
});

const EvidenceRefsSchema = z.array(z.string().min(1).max(2000)).max(20);
/** Retire a card without answering it; the recipient can undo by restoring the prior revision. */
export const RetireDeckCardInputSchema = z.strictObject({
	requestId: z.uuid(),
	expectedRequestVersion: z.number().int().positive().optional(),
	reason: DeckRetirementReasonSchema,
	/** Required for "duplicate"; the live card that keeps the ask. */
	successorId: z.uuid().optional(),
	/** The Work Item that handled or superseded the ask. */
	workItemId: z.uuid().optional(),
	note: CardTextSchema.max(4000),
	evidenceRefs: EvidenceRefsSchema.default([]),
});
export const MergeDeckCardsInputSchema = z.strictObject({
	keepId: z.uuid(),
	duplicateIds: z.array(z.uuid()).min(1).max(20),
	note: CardTextSchema.max(4000),
	evidenceRefs: EvidenceRefsSchema.default([]),
});
export const DeckRetirementResultSchema = z.strictObject({
	requestId: z.uuid(),
	reason: DeckRetirementReasonSchema,
	revision: z.number().int().positive(),
	/** Restore this revision with revise_decision_card to undo the retirement. */
	undo: z.strictObject({
		requestId: z.uuid(),
		expectedRequestVersion: z.number().int().positive(),
		expectedRevision: z.number().int().positive(),
		restoreRevision: z.number().int().positive(),
	}),
});
