import * as z from "zod";
import { LessonTriggersSchema } from "./agent-session-lessons";

/** Organization policy; learning supplies context, never an execution grant. */
export const DecisionLearningConfigSchema = z.strictObject({
	version: z.literal(1).default(1),
	enabled: z.boolean().default(false),
	classifyEdits: z.boolean().default(true),
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
