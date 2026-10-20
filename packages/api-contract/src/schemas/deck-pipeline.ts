import * as z from "zod";
import defaults from "../assets/deck-pipeline.v1.json";

const PatternSchema = z
	.string()
	.min(1)
	.max(2000)
	.refine((value) => {
		try {
			new RegExp(value, "iu");
			return true;
		} catch {
			return false;
		}
	}, "Invalid pattern");

/** What a card needs before it may reach a person's Deck. */
export const DeckGateRequirementSchema = z.enum([
	"ask",
	"recommendation",
	"evidence",
]);
export type DeckGateRequirement = z.infer<typeof DeckGateRequirementSchema>;

/** The chips behind "Not useful"; each teaches one specific fix. */
export const DeckNotUsefulReasonSchema = z.enum([
	"already_decided",
	"expired",
	"agent_could_do",
	"duplicate",
	"not_for_me",
]);
export type DeckNotUsefulReason = z.infer<typeof DeckNotUsefulReasonSchema>;

const ModeSchema = z.enum(["off", "shadow", "enforce"]);

/** A rule learned from repeated identical "Not useful" reasons; removable config. */
export const DeckLearnedRuleSchema = z.strictObject({
	id: z.string().min(1).max(100),
	recipientId: z.string().min(1).max(200),
	/** `<creatorType>:<creatorId>[:<metadata.source>]` */
	sourceKey: z.string().min(1).max(300),
	reason: DeckNotUsefulReasonSchema,
	sentence: z.string().min(1).max(300),
	evidenceIds: z.array(z.string().min(1).max(200)).min(1).max(20),
	createdAt: z.iso.datetime(),
});
export type DeckLearnedRule = z.infer<typeof DeckLearnedRuleSchema>;

/** Per (ask kind x source) class: hiding is earned from swipes and lost on undos. */
export const DeckHidingClassSchema = z.strictObject({
	recipientId: z.string().min(1).max(200),
	classKey: z.string().min(1).max(300),
	state: z.enum(["shadow", "hiding"]),
	changedAt: z.iso.datetime(),
	reason: z.string().max(300),
	/** Most recent cards this class hid, newest last; an open one was undone. */
	recentHides: z.array(z.string().min(1).max(200)).max(50).default([]),
});
export type DeckHidingClass = z.infer<typeof DeckHidingClassSchema>;

export const DeckPipelineConfigSchema = z.strictObject({
	version: z.literal(1).default(1),
	createGate: z
		.strictObject({
			mode: ModeSchema.default(
				defaults.createGate.mode as z.infer<typeof ModeSchema>,
			),
			requirements: z
				.array(DeckGateRequirementSchema)
				.max(3)
				.default(defaults.createGate.requirements as DeckGateRequirement[]),
			askPattern: PatternSchema.default(defaults.createGate.askPattern),
			recommendationPattern: PatternSchema.default(
				defaults.createGate.recommendationPattern,
			),
		})
		.prefault({}),
	sweep: z
		.strictObject({
			mode: ModeSchema.default(
				defaults.sweep.mode as z.infer<typeof ModeSchema>,
			),
			duplicateSimilarity: z
				.number()
				.min(0.5)
				.max(1)
				.default(defaults.sweep.duplicateSimilarity),
			maxCardsPerRecipient: z
				.number()
				.int()
				.min(1)
				.max(200)
				.default(defaults.sweep.maxCardsPerRecipient),
			maxRetirementsPerRun: z
				.number()
				.int()
				.min(0)
				.max(100)
				.default(defaults.sweep.maxRetirementsPerRun),
			maxRecipients: z
				.number()
				.int()
				.min(1)
				.max(50)
				.default(defaults.sweep.maxRecipients),
			staleAfterHours: z
				.number()
				.min(0.5)
				.max(48)
				.default(defaults.sweep.staleAfterHours),
		})
		.prefault({}),
	secondKey: z
		.strictObject({
			model: z
				.enum(["@cf/cloudflare/clef-flash", "@cf/cloudflare/clef"])
				.default("@cf/cloudflare/clef-flash"),
			threshold: z
				.number()
				.min(0.5)
				.max(1)
				.default(defaults.secondKey.threshold),
			timeoutMs: z
				.number()
				.int()
				.min(100)
				.max(10000)
				.default(defaults.secondKey.timeoutMs),
			maxPerRun: z
				.number()
				.int()
				.min(0)
				.max(100)
				.default(defaults.secondKey.maxPerRun),
		})
		.prefault({}),
	earnedHiding: z
		.strictObject({
			/** No model-only hiding before this date (14 days of shadow first). */
			notBefore: z.iso.datetime().default(defaults.earnedHiding.notBefore),
			minUsefulCards: z
				.number()
				.int()
				.min(10)
				.max(1000)
				.default(defaults.earnedHiding.minUsefulCards),
			maxValuableHidden: z
				.number()
				.int()
				.min(0)
				.max(10)
				.default(defaults.earnedHiding.maxValuableHidden),
			maxKeptNotUsefulRate: z
				.number()
				.min(0)
				.max(1)
				.default(defaults.earnedHiding.maxKeptNotUsefulRate),
			demoteUndos: z
				.number()
				.int()
				.min(1)
				.max(20)
				.default(defaults.earnedHiding.demoteUndos),
			demoteWindow: z
				.number()
				.int()
				.min(2)
				.max(50)
				.default(defaults.earnedHiding.demoteWindow),
		})
		.prefault({}),
	ruleAfterReasons: z
		.number()
		.int()
		.min(2)
		.max(20)
		.default(defaults.ruleAfterReasons),
	rules: z.array(DeckLearnedRuleSchema).max(100).default([]),
	hidingClasses: z.array(DeckHidingClassSchema).max(200).default([]),
});
export type DeckPipelineConfig = z.infer<typeof DeckPipelineConfigSchema>;

/** Week-1 go/no-go numbers per recipient, measured by the sweep. */
export const DeckPipelineMetricsSchema = z.strictObject({
	recipientId: z.string().min(1).max(200),
	liveCards: z.number().int().min(0),
	/** Live cards on the first sweep after 08:30 local time. */
	morning: z
		.strictObject({ date: z.string().max(10), liveCards: z.number().int() })
		.nullable(),
	/** Last 7 days: cards the person marked not useful / cards they settled. */
	notUseful: z.number().int().min(0),
	settled: z.number().int().min(0),
	/** Sweep removals the person undid (open again), last 100 removals. */
	wrongRemovals: z.number().int().min(0),
	wrongProtectedRemovals: z.number().int().min(0),
	removals: z.number().int().min(0),
});
export type DeckPipelineMetrics = z.infer<typeof DeckPipelineMetricsSchema>;

/** Last sweep receipt, kept on the organization so every Deck read can show it. */
export const DeckSweepReceiptSchema = z.strictObject({
	at: z.iso.datetime(),
	mode: ModeSchema,
	recipients: z.number().int().min(0),
	retired: z.number().int().min(0),
	merged: z.number().int().min(0),
	proposed: z.number().int().min(0).default(0),
	ranked: z.number().int().min(0),
	hidden: z.number().int().min(0),
	wouldRetire: z.number().int().min(0),
	errors: z.number().int().min(0),
	/** Cards the sweep removed recently, to detect undone removals. */
	removed: z
		.array(
			z.strictObject({
				id: z.string().min(1).max(200),
				recipientId: z.string().min(1).max(200),
				protected: z.boolean(),
			}),
		)
		.max(200)
		.default([]),
	metrics: z.array(DeckPipelineMetricsSchema).max(50).default([]),
});
export type DeckSweepReceipt = z.infer<typeof DeckSweepReceiptSchema>;

/** What the Deck shows about its own curation. */
export const DeckPipelineStatusSchema = z.strictObject({
	lastCleanedAt: z.iso.datetime().nullable(),
	stale: z.boolean(),
	staleAfterHours: z.number(),
	lastSweep: DeckSweepReceiptSchema.omit({
		removed: true,
		metrics: true,
	}).nullable(),
	metrics: DeckPipelineMetricsSchema.nullable(),
	rules: z.array(DeckLearnedRuleSchema),
});
export type DeckPipelineStatus = z.infer<typeof DeckPipelineStatusSchema>;

export const MarkDeckCardNotUsefulInputSchema = z.strictObject({
	requestId: z.uuid(),
	expectedRequestVersion: z.number().int().positive().optional(),
	reason: DeckNotUsefulReasonSchema,
	/** For "duplicate": the live card that keeps the ask. */
	successorId: z.uuid().optional(),
	note: z.string().trim().max(500).optional(),
});
export const MarkDeckCardNotUsefulResultSchema = z.strictObject({
	requestId: z.uuid(),
	reason: DeckNotUsefulReasonSchema,
	retired: z.boolean(),
	learningEventId: z.string(),
	rule: DeckLearnedRuleSchema.nullable(),
	undo: z
		.strictObject({
			requestId: z.uuid(),
			expectedRequestVersion: z.number().int().positive(),
			expectedRevision: z.number().int().positive(),
			restoreRevision: z.number().int().positive(),
		})
		.nullable(),
});
export const RemoveDeckRuleInputSchema = z.strictObject({
	ruleId: z.string().min(1).max(100),
});
export const RemoveDeckRuleResultSchema = z.strictObject({
	removed: z.boolean(),
	rules: z.array(DeckLearnedRuleSchema),
});
