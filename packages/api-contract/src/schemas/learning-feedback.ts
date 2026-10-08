import * as z from "zod";
import { JsonValueSchema } from "./common";

export const LEARNING_INTERACTION_KINDS = [
	"accepted",
	"edited",
	"ignored",
	"rejected",
	"retried",
	"undone",
	"manually_replaced",
	"completed_elsewhere",
	// A human answered an agent's question with no tedi draft to judge: a
	// decision to learn from, neither praise nor a correction.
	"answered",
	// Lessons were delivered to (or, in a holdout session, withheld from) an
	// agent session: the exposure side of lesson effectiveness.
	"delivered",
] as const;

export const LEARNING_SCOPE_KINDS = [
	"personal",
	"tedi",
	"project",
	"organization",
	"workflow",
] as const;

export const LEARNING_SUBJECT_KINDS = [
	"memory_fact",
	"directive",
	"skill",
	"harness_version",
	"workflow",
] as const;

export const LEARNING_CHANGE_KINDS = [
	"proposed",
	"evaluated",
	"promoted",
	"rejected",
	"rolled_back",
] as const;

export const LEARNING_MEASUREMENT_WINDOWS = ["baseline", "followup"] as const;
export const LEARNING_SIGNAL_CLASSES = [
	"quality",
	"governance",
	"lifecycle",
] as const;

export const LEARNING_IMPROVEMENT_STATUSES = [
	"proposed",
	"evaluating",
	"ready_for_review",
	"approved_for_handoff",
	"rejected",
] as const;

export const LEARNING_PROMOTION_ROUTES = [
	"memory_fact_governance",
	"directive_governance",
	"skill_workshop",
	"harness_promotion",
	"workflow_improvement",
] as const;

export const LearningInteractionKindSchema = z.enum(LEARNING_INTERACTION_KINDS);
export const LearningScopeKindSchema = z.enum(LEARNING_SCOPE_KINDS);
export const LearningSubjectKindSchema = z.enum(LEARNING_SUBJECT_KINDS);
export const LearningChangeKindSchema = z.enum(LEARNING_CHANGE_KINDS);
export const LearningMeasurementWindowSchema = z.enum(
	LEARNING_MEASUREMENT_WINDOWS,
);
export const LearningImprovementStatusSchema = z.enum(
	LEARNING_IMPROVEMENT_STATUSES,
);
export const LearningPromotionRouteSchema = z.enum(LEARNING_PROMOTION_ROUTES);
export const LearningSignalClassSchema = z.enum(LEARNING_SIGNAL_CLASSES);

export const LearningScopeInputSchema = z
	.object({
		kind: LearningScopeKindSchema,
		id: z.string().trim().min(1).max(200).optional(),
	})
	.superRefine((scope, ctx) => {
		if ((scope.kind === "project" || scope.kind === "workflow") && !scope.id) {
			ctx.addIssue({
				code: "custom",
				path: ["id"],
				message: `${scope.kind} learning scope requires an id`,
			});
		}
		if (
			(scope.kind === "personal" || scope.kind === "organization") &&
			scope.id
		) {
			ctx.addIssue({
				code: "custom",
				path: ["id"],
				message: `${scope.kind} learning scope is resolved by the server`,
			});
		}
	});

const JsonMetadataSchema = z.record(z.string(), JsonValueSchema);

export const LearningInteractionEventSchema = z.object({
	id: z.string(),
	organizationId: z.string(),
	actorType: z.enum(["user", "tedi", "service", "api_key", "unknown"]),
	actorId: z.string().nullable(),
	tediId: z.string().nullable(),
	clientEventId: z.string(),
	signalClass: LearningSignalClassSchema,
	eventKind: LearningInteractionKindSchema,
	scopeKind: LearningScopeKindSchema,
	scopeId: z.string(),
	issueKey: z.string().nullable(),
	surface: z.string(),
	targetType: z.string().nullable(),
	targetId: z.string().nullable(),
	threadId: z.string().nullable(),
	runId: z.string().nullable(),
	metadata: JsonMetadataSchema.nullable(),
	occurredAt: z.string(),
	createdAt: z.string(),
});

export const RecordLearningInteractionInputSchema = z.object({
	clientEventId: z.string().trim().min(1).max(128),
	signalClass: LearningSignalClassSchema.default("quality"),
	eventKind: LearningInteractionKindSchema,
	scope: LearningScopeInputSchema,
	tediId: z.string().optional(),
	issueKey: z.string().trim().min(1).max(200).optional(),
	surface: z.string().trim().min(1).max(100),
	targetType: z.string().trim().min(1).max(100).optional(),
	targetId: z.string().trim().min(1).max(200).optional(),
	threadId: z.string().trim().min(1).max(200).optional(),
	runId: z.string().trim().min(1).max(200).optional(),
	metadata: JsonMetadataSchema.optional(),
	occurredAt: z.iso.datetime().optional(),
});

export const RecordLearningInteractionOutputSchema = z.object({
	event: LearningInteractionEventSchema,
	duplicate: z.boolean(),
});

export const ListLearningInteractionsInputSchema = z.object({
	tediId: z.string().optional(),
	eventKind: LearningInteractionKindSchema.optional(),
	scopeKind: LearningScopeKindSchema.optional(),
	scopeId: z.string().optional(),
	issueKey: z.string().optional(),
	since: z.iso.datetime().optional(),
	until: z.iso.datetime().optional(),
	limit: z.number().int().min(1).max(200).default(50),
});

export const ListLearningInteractionsOutputSchema = z.object({
	events: z.array(LearningInteractionEventSchema),
});

export const LearningFeedbackAttributionSchema = z.object({
	id: z.string(),
	organizationId: z.string(),
	clientAttributionId: z.string(),
	feedbackEventId: z.string(),
	subjectKind: LearningSubjectKindSchema,
	subjectId: z.string(),
	changeKind: LearningChangeKindSchema,
	rationale: z.string().nullable(),
	evidenceRefs: z.array(z.string()),
	metadata: JsonMetadataSchema.nullable(),
	occurredAt: z.string(),
	createdAt: z.string(),
});

export const AttributeLearningFeedbackInputSchema = z.object({
	clientAttributionId: z.string().trim().min(1).max(128),
	feedbackEventIds: z.array(z.string()).min(1).max(50),
	subjectKind: LearningSubjectKindSchema,
	subjectId: z.string().trim().min(1).max(200),
	changeKind: LearningChangeKindSchema,
	rationale: z.string().trim().min(1).max(2_000).optional(),
	evidenceRefs: z.array(z.string().trim().min(1).max(500)).max(50).default([]),
	metadata: JsonMetadataSchema.optional(),
	occurredAt: z.iso.datetime().optional(),
});

export const AttributeLearningFeedbackOutputSchema = z.object({
	attributions: z.array(LearningFeedbackAttributionSchema),
	created: z.number().int().nonnegative(),
	duplicates: z.number().int().nonnegative(),
});

export const LearningFeedbackMeasurementSchema = z.object({
	id: z.string(),
	organizationId: z.string(),
	clientMeasurementId: z.string(),
	attributionId: z.string(),
	windowKind: LearningMeasurementWindowSchema,
	windowStart: z.string(),
	windowEnd: z.string(),
	opportunityCount: z.number().int().positive(),
	recurrenceCount: z.number().int().nonnegative(),
	successCount: z.number().int().nonnegative(),
	metadata: JsonMetadataSchema.nullable(),
	createdAt: z.string(),
});

export const RecordLearningMeasurementInputSchema = z
	.object({
		clientMeasurementId: z.string().trim().min(1).max(128),
		attributionId: z.string(),
		windowKind: LearningMeasurementWindowSchema,
		windowStart: z.iso.datetime(),
		windowEnd: z.iso.datetime(),
		opportunityCount: z.number().int().min(1).max(1_000_000),
		recurrenceCount: z.number().int().min(0).max(1_000_000),
		successCount: z.number().int().min(0).max(1_000_000).default(0),
		metadata: JsonMetadataSchema.optional(),
	})
	.superRefine((measurement, ctx) => {
		if (measurement.windowEnd <= measurement.windowStart) {
			ctx.addIssue({
				code: "custom",
				path: ["windowEnd"],
				message: "windowEnd must be after windowStart",
			});
		}
		if (measurement.recurrenceCount > measurement.opportunityCount) {
			ctx.addIssue({
				code: "custom",
				path: ["recurrenceCount"],
				message: "recurrenceCount cannot exceed opportunityCount",
			});
		}
		if (measurement.successCount > measurement.opportunityCount) {
			ctx.addIssue({
				code: "custom",
				path: ["successCount"],
				message: "successCount cannot exceed opportunityCount",
			});
		}
	});

export const RecordLearningMeasurementOutputSchema = z.object({
	measurement: LearningFeedbackMeasurementSchema,
	duplicate: z.boolean(),
});

export const LearningMeasurementRateSchema = z.object({
	measurementId: z.string(),
	attributionId: z.string(),
	windowStart: z.string(),
	windowEnd: z.string(),
	opportunityCount: z.number().int(),
	recurrenceCount: z.number().int(),
	successCount: z.number().int(),
	recurrenceRate: z.number(),
	successRate: z.number(),
});

export const GetLearningFeedbackSummaryInputSchema = z.object({
	subjectKind: LearningSubjectKindSchema,
	subjectId: z.string().trim().min(1).max(200),
	issueKey: z.string().trim().min(1).max(200).optional(),
});

export const GetLearningFeedbackSummaryOutputSchema = z.object({
	subjectKind: LearningSubjectKindSchema,
	subjectId: z.string(),
	issueKey: z.string().nullable(),
	attributionCount: z.number().int().nonnegative(),
	attributedEventCount: z.number().int().nonnegative(),
	eventKinds: z.record(z.string(), z.number().int().nonnegative()),
	baseline: LearningMeasurementRateSchema.nullable(),
	followup: LearningMeasurementRateSchema.nullable(),
	recurrenceRateDelta: z.number().nullable(),
	improved: z.boolean().nullable(),
});

export const RecurringLearningIssueSchema = z.object({
	issueKey: z.string(),
	tediId: z.string().nullable(),
	scopeKind: LearningScopeKindSchema,
	scopeId: z.string(),
	occurrenceCount: z.number().int().nonnegative(),
	negativeCount: z.number().int().nonnegative(),
	acceptedCount: z.number().int().nonnegative(),
	uniqueActorCount: z.number().int().nonnegative(),
	uniqueRunCount: z.number().int().nonnegative(),
	eventKinds: z.record(z.string(), z.number().int().nonnegative()),
	evidenceEventIds: z.array(z.string()),
	firstOccurredAt: z.string(),
	lastOccurredAt: z.string(),
	eligible: z.boolean(),
});

export const AnalyzeRecurringLearningIssuesInputSchema = z.object({
	tediId: z.string().optional(),
	scopeKind: LearningScopeKindSchema.optional(),
	scopeId: z.string().optional(),
	since: z.iso.datetime().optional(),
	until: z.iso.datetime().optional(),
	minimumOccurrences: z.number().int().min(3).max(100).default(3),
	limit: z.number().int().min(1).max(100).default(25),
});

export const AnalyzeRecurringLearningIssuesOutputSchema = z.object({
	minimumOccurrences: z.number().int(),
	issues: z.array(RecurringLearningIssueSchema),
});

export const LearningImprovementProposalSchema = z.object({
	id: z.string(),
	organizationId: z.string(),
	clientProposalId: z.string(),
	tediId: z.string().nullable(),
	scopeKind: LearningScopeKindSchema,
	scopeId: z.string(),
	issueKey: z.string(),
	subjectKind: LearningSubjectKindSchema,
	subjectId: z.string(),
	status: LearningImprovementStatusSchema,
	promotionRoute: LearningPromotionRouteSchema,
	recommendation: z.string(),
	evidenceEventIds: z.array(z.string()),
	attributionId: z.string().nullable(),
	baselineMeasurementId: z.string().nullable(),
	followupMeasurementId: z.string().nullable(),
	evaluationNote: z.string().nullable(),
	reviewReason: z.string().nullable(),
	proposedByType: z.enum(["user", "tedi", "service", "api_key", "unknown"]),
	proposedById: z.string().nullable(),
	reviewedById: z.string().nullable(),
	createdAt: z.string(),
	updatedAt: z.string(),
	reviewedAt: z.string().nullable(),
});

export const ProposeLearningImprovementInputSchema = z.object({
	clientProposalId: z.string().trim().min(1).max(128),
	evidenceEventIds: z.array(z.string()).min(3).max(50),
	subjectKind: LearningSubjectKindSchema,
	subjectId: z.string().trim().min(1).max(200),
	recommendation: z.string().trim().min(1).max(4_000),
});

export const ProposeLearningImprovementOutputSchema = z.object({
	proposal: LearningImprovementProposalSchema,
	duplicate: z.boolean(),
});

export const EvaluateLearningImprovementInputSchema = z.object({
	proposalId: z.string(),
	baselineMeasurementId: z.string(),
	followupMeasurementId: z.string(),
	evaluationNote: z.string().trim().min(1).max(4_000).optional(),
});

export const EvaluateLearningImprovementOutputSchema = z.object({
	proposal: LearningImprovementProposalSchema,
	summary: GetLearningFeedbackSummaryOutputSchema,
	readyForHumanReview: z.boolean(),
});

export const ReviewLearningImprovementInputSchema = z.object({
	proposalId: z.string(),
	decision: z.enum(["approve", "reject"]),
	reason: z.string().trim().min(1).max(4_000),
});

export const ReviewLearningImprovementOutputSchema = z.object({
	proposal: LearningImprovementProposalSchema,
	requiresDownstreamCertificationAndPromotion: z.boolean(),
});

export const ListLearningImprovementProposalsInputSchema = z.object({
	tediId: z.string().optional(),
	issueKey: z.string().optional(),
	status: LearningImprovementStatusSchema.optional(),
	limit: z.number().int().min(1).max(200).default(50),
});

export const ListLearningImprovementProposalsOutputSchema = z.object({
	proposals: z.array(LearningImprovementProposalSchema),
});

export type LearningInteractionKind = z.infer<
	typeof LearningInteractionKindSchema
>;
export type LearningSignalClass = z.infer<typeof LearningSignalClassSchema>;
export type LearningScopeKind = z.infer<typeof LearningScopeKindSchema>;
export type LearningSubjectKind = z.infer<typeof LearningSubjectKindSchema>;
export type LearningChangeKind = z.infer<typeof LearningChangeKindSchema>;
export type LearningInteractionEvent = z.infer<
	typeof LearningInteractionEventSchema
>;
export type LearningFeedbackAttribution = z.infer<
	typeof LearningFeedbackAttributionSchema
>;
export type LearningFeedbackMeasurement = z.infer<
	typeof LearningFeedbackMeasurementSchema
>;
export type LearningFeedbackSummary = z.infer<
	typeof GetLearningFeedbackSummaryOutputSchema
>;
export type LearningImprovementStatus = z.infer<
	typeof LearningImprovementStatusSchema
>;
export type LearningPromotionRoute = z.infer<
	typeof LearningPromotionRouteSchema
>;
export type RecurringLearningIssue = z.infer<
	typeof RecurringLearningIssueSchema
>;
export type LearningImprovementProposal = z.infer<
	typeof LearningImprovementProposalSchema
>;
