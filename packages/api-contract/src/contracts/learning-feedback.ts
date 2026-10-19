import "@orpc/openapi/extensions/route";
import { oc } from "@orpc/contract";
import { baseErrors } from "../errors";
import { AttentionViewInputSchema } from "../schemas/attention";
import * as z from "zod";
import {
	DecisionExposureInputSchema,
	DecisionCalibrationSchema,
	DecisionInstrumentationProofSchema,
	DecisionLearningConfigSchema,
	DecisionLearningModelSchema,
	LearningCorrectionInputSchema,
} from "../schemas/decision-learning";
import {
	AnalyzeRecurringLearningIssuesInputSchema,
	AnalyzeRecurringLearningIssuesOutputSchema,
	AttributeLearningFeedbackInputSchema,
	AttributeLearningFeedbackOutputSchema,
	EvaluateLearningImprovementInputSchema,
	EvaluateLearningImprovementOutputSchema,
	GetLearningFeedbackSummaryInputSchema,
	GetLearningFeedbackSummaryOutputSchema,
	ListLearningImprovementProposalsInputSchema,
	ListLearningImprovementProposalsOutputSchema,
	ListLearningInteractionsInputSchema,
	ListLearningInteractionsOutputSchema,
	ProposeLearningImprovementInputSchema,
	ProposeLearningImprovementOutputSchema,
	RecordLearningInteractionInputSchema,
	RecordLearningInteractionOutputSchema,
	RecordLearningMeasurementInputSchema,
	RecordLearningMeasurementOutputSchema,
	ReviewLearningImprovementInputSchema,
	ReviewLearningImprovementOutputSchema,
} from "../schemas/learning-feedback";

export const learningFeedbackContract = oc
	.route({ tags: ["learning-feedback"], prefix: "/learning-feedback" })
	.errors(baseErrors)
	.router({
		cardContextPrompt: oc
			.route({
				operationId: "record_card_context_view",
				summary:
					"Ask whether this visibly presented card has a sampled context question",
			})
			.input(
				AttentionViewInputSchema.extend({
					cardId: z.string().min(1).max(200),
					sourceFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
				}),
			)
			.output(z.object({ ask: z.boolean() })),
		cardContext: oc
			.route({
				operationId: "record_card_context",
				summary: "Record your sampled card context feedback",
			})
			.input(
				z.strictObject({
					cardId: z.string().min(1).max(200),
					clientEventId: z.uuid(),
					enough: z.boolean(),
					chip: z
						.enum(["who", "why_now", "cost", "risk", "draft", "too_long"])
						.optional(),
				}),
			)
			.output(z.object({ saved: z.literal(true) })),
		model: oc.input(z.object({})).output(DecisionLearningModelSchema),
		recordExposure: oc
			.route({
				operationId: "record_decision_exposure",
				summary: "Record your bounded Deck exposure context",
			})
			.input(DecisionExposureInputSchema)
			.output(z.object({ id: z.string() })),
		getCalibration: oc
			.route({
				operationId: "get_decision_calibration",
				summary:
					"Read approval calibration for one card class in your organization",
			})
			.input(z.object({ classId: z.string().min(1).max(100) }))
			.output(DecisionCalibrationSchema),
		getInstrumentation: oc
			.route({
				operationId: "get_decision_instrumentation",
				summary:
					"Read your decision exposure snapshots, alternatives and receipt-linked labels",
			})
			.input(
				z.object({
					cardId: z.string().min(1).max(200),
					limit: z.number().int().min(1).max(100).default(20),
				}),
			)
			.output(DecisionInstrumentationProofSchema),
		configure: oc
			.input(DecisionLearningConfigSchema)
			.output(DecisionLearningConfigSchema),
		correct: oc
			.input(LearningCorrectionInputSchema)
			.output(RecordLearningInteractionOutputSchema),
		recordInteraction: oc
			.route({
				method: "POST",
				path: "/interactions",
				summary: "Record an idempotent product interaction learning signal",
			})
			.input(RecordLearningInteractionInputSchema)
			.output(RecordLearningInteractionOutputSchema),
		listInteractions: oc
			.route({
				method: "GET",
				path: "/interactions",
				summary: "List scoped product interaction learning signals",
			})
			.input(ListLearningInteractionsInputSchema)
			.output(ListLearningInteractionsOutputSchema),
		attributeFeedback: oc
			.route({
				method: "POST",
				path: "/attributions",
				summary: "Link feedback signals to a versioned learning change",
			})
			.input(AttributeLearningFeedbackInputSchema)
			.output(AttributeLearningFeedbackOutputSchema),
		recordMeasurement: oc
			.route({
				method: "POST",
				path: "/measurements",
				summary: "Record a baseline or follow-up recurrence measurement",
			})
			.input(RecordLearningMeasurementInputSchema)
			.output(RecordLearningMeasurementOutputSchema),
		getSummary: oc
			.route({
				method: "GET",
				path: "/summary",
				summary:
					"Compare feedback recurrence before and after a learning change",
			})
			.input(GetLearningFeedbackSummaryInputSchema)
			.output(GetLearningFeedbackSummaryOutputSchema),
		analyzeRecurringIssues: oc
			.route({
				method: "GET",
				path: "/recurring-issues",
				summary:
					"Group recurring negative interactions into evidence candidates",
			})
			.input(AnalyzeRecurringLearningIssuesInputSchema)
			.output(AnalyzeRecurringLearningIssuesOutputSchema),
		proposeImprovement: oc
			.route({
				method: "POST",
				path: "/improvements",
				summary: "Propose an evidence-linked governed learning improvement",
			})
			.input(ProposeLearningImprovementInputSchema)
			.output(ProposeLearningImprovementOutputSchema),
		listImprovements: oc
			.route({
				method: "GET",
				path: "/improvements",
				summary: "List governed learning improvement proposals",
			})
			.input(ListLearningImprovementProposalsInputSchema)
			.output(ListLearningImprovementProposalsOutputSchema),
		evaluateImprovement: oc
			.route({
				method: "POST",
				path: "/improvements/{proposalId}/evaluation",
				summary:
					"Evaluate a proposal against an exact baseline and follow-up measurement pair",
			})
			.input(EvaluateLearningImprovementInputSchema)
			.output(EvaluateLearningImprovementOutputSchema),
		reviewImprovement: oc
			.route({
				method: "POST",
				path: "/improvements/{proposalId}/review",
				summary: "Approve or reject a proposal through a human-only gate",
			})
			.input(ReviewLearningImprovementInputSchema)
			.output(ReviewLearningImprovementOutputSchema),
	});

export type LearningFeedbackContract = typeof learningFeedbackContract;
