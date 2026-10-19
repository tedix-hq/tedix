import * as z from "zod";
import { LessonTriggersSchema } from "./agent-session-lessons";
import { DeckCuratorRankerConfigSchema } from "./deck-curator";
import focusFeedPolicy from "../assets/focus-feed.v1.json";

const FocusFeedPolicySchema = z.strictObject({
	version: z.literal(1),
	dailyBudget: z.number().int().min(1).max(100),
	needsYouLimit: z.number().int().min(1).max(3),
	halfLifeHours: z.number().positive().max(8760),
	deadlineWindowHours: z.number().positive().max(720),
	wordsPerMinute: z.number().positive(),
	ignoredCost: z.number().nonnegative(),
	continuityBoost: z.number().nonnegative(),
	receiptValue: z.number().nonnegative(),
	actionUrgency: z.number().nonnegative(),
	stakes: z.record(z.string(), z.number().min(1).max(100)),
	importance: z.strictObject({
		low: z.number().positive(),
		normal: z.number().positive(),
		high: z.number().positive(),
		critical: z.number().positive(),
	}),
	weights: z.strictObject({
		urgency: z.number().nonnegative(),
		importance: z.number().nonnegative(),
		value: z.number().nonnegative(),
		continuity: z.number().nonnegative(),
		freshness: z.number().nonnegative(),
		attentionCost: z.number().nonnegative(),
	}),
	signals: z.record(z.string(), z.number().min(-10).max(10)),
});

/** Organization policy; learning supplies context, never an execution grant. */
export const DecisionLearningConfigSchema = z.strictObject({
	version: z.literal(1).default(1),
	enabled: z.boolean().default(false),
	classifyEdits: z.boolean().default(true),
	deckCuratorRanker: DeckCuratorRankerConfigSchema.optional(),
	focusFeed: FocusFeedPolicySchema.prefault(() =>
		FocusFeedPolicySchema.parse(focusFeedPolicy),
	),
	instrumentationRetentionDays: z.number().int().min(8).max(365).default(90),
	autoApproveClasses: z.array(z.string().min(1).max(100)).max(100).default([]),
	classifierConfidence: z.number().min(0).max(1).default(0.85),
	classifierTimeoutMs: z.number().int().min(100).max(10000).default(2500),
	preferenceModel: z
		.string()
		.min(1)
		.max(200)
		.default("@cf/meta/llama-3.2-3b-instruct"),
	historyLimit: z.number().int().min(30).max(2000).default(500),
	halfLifeDays: z.number().min(1).max(365).default(30),
	ignoredAfterMs: z.number().int().min(1000).max(60000).default(5000),
	ignoredPenalty: z.number().min(0).max(1).default(0.15),
	fastDecisionMs: z.number().int().min(100).max(3600000).default(30000),
	unchangedThreshold: z.number().int().min(1).max(100).default(5),
	auditSampleRate: z.number().min(0).max(1).default(0.1),
	minimumPreferenceExamples: z.number().int().min(1).max(100).default(2),
	shorteningRatio: z.number().min(0.1).max(0.95).default(0.8),
	deadlineWindowHours: z.number().min(1).max(720).default(24),
	timezone: z
		.string()
		.max(100)
		.default("UTC")
		.refine((value) => {
			try {
				new Intl.DateTimeFormat("en", { timeZone: value });
				return true;
			} catch {
				return false;
			}
		}, "Unknown timezone"),
	quietHours: z
		.strictObject({
			start: z.number().int().min(0).max(23),
			end: z.number().int().min(0).max(23),
		})
		.nullable()
		.default(null),
	weights: z
		.strictObject({
			personal: z.number().min(0).max(100).default(8),
			organization: z.number().min(0).max(100).default(4),
			time: z.number().min(0).max(100).default(3),
			urgency: z.number().min(0).max(100).default(30),
			urgencyLearning: z.number().min(0).max(100).default(3),
			priority: z.number().min(0).max(100).default(8),
			usefulness: z.number().min(0).max(100).default(10),
		})
		.prefault({}),
});
export type DecisionLearningConfig = z.infer<
	typeof DecisionLearningConfigSchema
>;

export const LearnedWeightSchema = z.object({
	key: z.string(),
	value: z.number(),
	examples: z.number().int(),
	evidenceIds: z.array(z.string()),
});
export const LearnedPreferenceSchema = z.object({
	classId: z.string(),
	sentence: z.string(),
	evidenceIds: z.array(z.string()),
	maxCharacters: z.number().int().positive().nullable(),
});
export const LearningLessonSchema = z.object({
	id: z.string(),
	text: z.string(),
	classId: z.string().nullable(),
	triggers: LessonTriggersSchema.optional(),
});
export const DecisionLearningModelSchema = z.object({
	config: DecisionLearningConfigSchema,
	asOf: z.string(),
	weights: z.object({
		personal: z.array(LearnedWeightSchema),
		organization: z.array(LearnedWeightSchema),
		time: z.array(LearnedWeightSchema),
		urgency: z.array(LearnedWeightSchema),
		priority: z.array(LearnedWeightSchema),
		usefulness: z.array(LearnedWeightSchema),
	}),
	preferences: z.array(LearnedPreferenceSchema),
	cardIntuitiveness: z
		.object({
			decisions: z.number().int(),
			fromCard: z.number().int(),
			percent: z.number().nullable(),
			classes: z.array(
				z.object({
					classId: z.string(),
					decisions: z.number().int(),
					fromCard: z.number().int(),
					needsBetterSummary: z.boolean(),
				}),
			),
		})
		.optional(),
	readiness: z.array(
		z.object({
			classId: z.string(),
			unchanged: z.number().int(),
			ready: z.boolean(),
			evidenceIds: z.array(z.string()),
		}),
	),
	lessons: z.array(LearningLessonSchema),
	eventCount: z.number().int(),
	receipts: z.array(
		z.object({
			eventId: z.string(),
			clientEventId: z.string().optional(),
			classId: z.string(),
			eventKind: z.string(),
			choice: z.string(),
			shortened: z.boolean(),
		}),
	),
});
export type DecisionLearningModel = z.infer<typeof DecisionLearningModelSchema>;
export type LearnedWeight = z.infer<typeof LearnedWeightSchema>;
export type LearningLesson = z.infer<typeof LearningLessonSchema>;

export const LearningCorrectionInputSchema = z.object({
	eventId: z.string().min(1).max(200),
	clientEventId: z.string().min(1).max(128),
});

export const DecisionCandidateSchema = z.strictObject({
	cardId: z.string().min(1).max(200),
	score: z.number().finite().nullable(),
	reason: z.enum([
		"shown",
		"shown_later",
		"filtered",
		"ranked_lower",
		"batched",
	]),
	position: z.number().int().min(0).max(10000).nullable(),
});

export const DecisionExposureInputSchema = z.strictObject({
	clientEventId: z.uuid(),
	sessionId: z.uuid(),
	feedOrigin: z
		.strictObject({
			sessionId: z.uuid(),
			openedAt: z.number().int().positive(),
			itemId: z.string().min(1).max(200),
		})
		.optional(),
	cardId: z.string().min(1).max(200),
	sourceVersion: z.number().int().positive().nullable(),
	position: z.number().int().min(0).max(10000),
	aboveFold: z
		.array(
			z.enum([
				"title",
				"body",
				"recommendation",
				"options",
				"stakes",
				"urgency",
				"proposer",
			]),
		)
		.max(7),
	railOpened: z.boolean(),
	timezone: z
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
		}),
	ranking: z.strictObject({
		version: z.literal("decision-learning-v1"),
		score: z.number().finite().nullable(),
		features: z
			.array(
				z.strictObject({
					level: z.string().max(100),
					contribution: z.number().finite(),
					evidenceIds: z.array(z.string().max(200)).max(20),
					reason: z.string().max(1000),
				}),
			)
			.max(50),
	}),
	candidates: z.array(DecisionCandidateSchema).min(1).max(100),
	candidateCount: z.number().int().min(1).max(10000),
	candidateSetComplete: z.boolean(),
	rankingEvidenceTruncated: z.boolean().default(false),
	selectionPolicy: z
		.literal("deterministic_current_order")
		.default("deterministic_current_order"),
	selectionProbability: z.null().default(null),
});
export type DecisionExposureInput = z.infer<typeof DecisionExposureInputSchema>;

export const DecisionSnapshotSchema = z.strictObject({
	classId: z.string(),
	projectId: z.string().nullable(),
	workItemId: z.string().nullable(),
	kind: z.string(),
	title: z.string(),
	body: z.string().nullable(),
	options: z.array(
		z.object({
			id: z.string(),
			label: z.string(),
			intent: z.string(),
			consequence: z.string().nullable(),
		}),
	),
	recommendation: z.string().nullable(),
	confidence: z.number().nullable(),
	proposerId: z.string().nullable(),
	stakes: z.strictObject({
		reversibility: z.string().nullable(),
		blastRadius: z.string().nullable(),
		protectedEffects: z.array(z.string()),
	}),
	urgency: z.strictObject({
		whyNow: z.string().nullable(),
		costOfWaiting: z.string().nullable(),
		dueAt: z.string().nullable(),
	}),
	prediction: z.strictObject({
		unchangedApprovalLikelihood: z.number().min(0).max(1).nullable(),
		modelVersion: z.string().nullable(),
	}),
});
export type DecisionSnapshot = z.infer<typeof DecisionSnapshotSchema>;
export const DecisionOutcomeSchema = z.strictObject({
	evidenceSource: z.enum(["canonical_receipt", "browser_report"]),
	label: z.enum([
		"unchanged_approval",
		"edited_then_approved",
		"not_this",
		"later",
		"decided_for_me",
		"decided",
		"unknown",
	]),
	reason: z.string().nullable(),
	exposureId: z.string(),
	receiptId: z.string(),
	decidedAt: z.string(),
	laterToDecisionMs: z.number().nullable(),
});
export type DecisionOutcome = z.infer<typeof DecisionOutcomeSchema>;
export const DecisionDelayedOutcomeSchema = z.strictObject({
	revertedOrCorrected: z.boolean().nullable(),
	lessonMined: z.boolean().nullable(),
	workCompleted: z.boolean().nullable(),
	followUpRaised: z.boolean().nullable(),
	evidenceIds: z.array(z.string()),
});
export type DecisionDelayedOutcome = z.infer<
	typeof DecisionDelayedOutcomeSchema
>;
export const DecisionCalibrationSchema = z.object({
	sampleLimit: z.literal(1000),
	asOf: z.string(),
	classId: z.string(),
	decisions: z.number().int(),
	unchanged: z.number().int(),
	observedRate: z.number().nullable(),
	predictedMean: z.number().nullable(),
	predictedCount: z.number().int(),
	pending: z.number().int(),
	statement: z.string(),
	bins: z.array(
		z.object({
			lower: z.number(),
			upper: z.number(),
			count: z.number().int(),
			predicted: z.number(),
			observed: z.number(),
		}),
	),
});
export const DecisionInstrumentationProofSchema = z.object({
	pendingLabels: z.array(
		z.object({
			receiptId: z.string(),
			window: z.enum(["day_1", "day_7"]),
			dueAt: z.string(),
			state: z.enum(["pending", "overdue"]),
		}),
	),
	exposures: z.array(
		z.object({
			id: z.string(),
			actorId: z.string(),
			cardId: z.string(),
			sessionId: z.string(),
			occurredAt: z.string(),
			expiresAt: z.string(),
			snapshot: DecisionSnapshotSchema,
			context: DecisionExposureInputSchema,
		}),
	),
	labels: z.array(
		z.object({
			id: z.string(),
			cardId: z.string(),
			window: z.enum(["immediate", "day_1", "day_7"]),
			outcome: DecisionOutcomeSchema,
			delayed: DecisionDelayedOutcomeSchema.nullable(),
			observedAt: z.string(),
		}),
	),
});
