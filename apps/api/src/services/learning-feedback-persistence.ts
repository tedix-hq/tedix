import type {
	LearningFeedbackAttribution,
	LearningFeedbackMeasurement,
	LearningImprovementProposal,
	LearningInteractionEvent,
} from "@tedix/api-contract/schemas/learning-feedback";
import {
	attributeLearningFeedback as attributeLearningFeedbackRows,
	getLearningAttributionById as getLearningAttributionRowById,
	getLearningAttributionsForEvents as getLearningAttributionRowsForEvents,
	getLearningImprovementProposal as getLearningImprovementProposalRow,
	getLearningInteractionsByIds as getLearningInteractionRowsByIds,
	getLearningMeasurementsByIds as getLearningMeasurementRowsByIds,
	listLearningImprovementProposals as listLearningImprovementProposalRows,
	listLearningInteractions as listLearningInteractionRows,
	proposeLearningImprovement as proposeLearningImprovementRow,
	recordLearningInteraction as recordLearningInteractionRow,
	recordLearningMeasurement as recordLearningMeasurementRow,
	updateLearningImprovementProposal as updateLearningImprovementProposalRow,
} from "@tedix/db/queries/learning-feedback";
import type {
	LearningFeedbackAttributionRow,
	LearningFeedbackMeasurementRow,
	LearningImprovementProposalRow,
	LearningInteractionEventRow,
} from "@tedix/db/schema/learning-feedback";

export function learningInteractionRowToContract(
	row: LearningInteractionEventRow,
): LearningInteractionEvent {
	return { ...row, metadata: row.metadata ?? null };
}

export function learningAttributionRowToContract(
	row: LearningFeedbackAttributionRow,
): LearningFeedbackAttribution {
	return { ...row, metadata: row.metadata ?? null };
}

export function learningMeasurementRowToContract(
	row: LearningFeedbackMeasurementRow,
): LearningFeedbackMeasurement {
	return { ...row, metadata: row.metadata ?? null };
}

export function learningProposalRowToContract(
	row: LearningImprovementProposalRow,
): LearningImprovementProposal {
	const { certificationEvidenceRefs: _persistenceOnly, ...proposal } = row;
	return proposal;
}

export async function recordLearningInteraction(
	...args: Parameters<typeof recordLearningInteractionRow>
) {
	const result = await recordLearningInteractionRow(...args);
	return { ...result, event: learningInteractionRowToContract(result.event) };
}

export async function listLearningInteractions(
	...args: Parameters<typeof listLearningInteractionRows>
) {
	return (await listLearningInteractionRows(...args)).map(
		learningInteractionRowToContract,
	);
}

export async function getLearningInteractionsByIds(
	...args: Parameters<typeof getLearningInteractionRowsByIds>
) {
	return (await getLearningInteractionRowsByIds(...args)).map(
		learningInteractionRowToContract,
	);
}

export async function attributeLearningFeedback(
	...args: Parameters<typeof attributeLearningFeedbackRows>
) {
	const result = await attributeLearningFeedbackRows(...args);
	return {
		...result,
		attributions: result.attributions.map(learningAttributionRowToContract),
	};
}

export async function getLearningAttributionById(
	...args: Parameters<typeof getLearningAttributionRowById>
) {
	const row = await getLearningAttributionRowById(...args);
	return row ? learningAttributionRowToContract(row) : null;
}

export async function getLearningAttributionsForEvents(
	...args: Parameters<typeof getLearningAttributionRowsForEvents>
) {
	return (await getLearningAttributionRowsForEvents(...args)).map(
		learningAttributionRowToContract,
	);
}

export async function getLearningMeasurementsByIds(
	...args: Parameters<typeof getLearningMeasurementRowsByIds>
) {
	return (await getLearningMeasurementRowsByIds(...args)).map(
		learningMeasurementRowToContract,
	);
}

export async function recordLearningMeasurement(
	...args: Parameters<typeof recordLearningMeasurementRow>
) {
	const result = await recordLearningMeasurementRow(...args);
	return {
		...result,
		measurement: learningMeasurementRowToContract(result.measurement),
	};
}

export async function proposeLearningImprovement(
	...args: Parameters<typeof proposeLearningImprovementRow>
) {
	const result = await proposeLearningImprovementRow(...args);
	return {
		...result,
		proposal: learningProposalRowToContract(result.proposal),
	};
}

export async function getLearningImprovementProposal(
	...args: Parameters<typeof getLearningImprovementProposalRow>
) {
	const row = await getLearningImprovementProposalRow(...args);
	return row ? learningProposalRowToContract(row) : null;
}

export async function updateLearningImprovementProposal(
	...args: Parameters<typeof updateLearningImprovementProposalRow>
) {
	const row = await updateLearningImprovementProposalRow(...args);
	return row ? learningProposalRowToContract(row) : null;
}

export async function listLearningImprovementProposals(
	...args: Parameters<typeof listLearningImprovementProposalRows>
) {
	return (await listLearningImprovementProposalRows(...args)).map(
		learningProposalRowToContract,
	);
}
