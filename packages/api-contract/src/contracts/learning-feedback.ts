import "@orpc/openapi/extensions/route";
import { oc } from "@orpc/contract";
import { baseErrors } from "../errors";
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
