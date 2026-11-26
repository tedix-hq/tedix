import {
	listCliProjectionProcedure,
	getCheckpointProjectionProcedure,
	getManyProcedure,
} from "./work-items/creation-reads";
import {
	authorizePersonalCliReleaseProcedure,
	listAttemptCliProjectionProcedure,
	listEvidenceCliProjectionProcedure,
	listEventCliProjectionProcedure,
} from "./work-items/factory-lifecycle";
import {
	authorizeOwnedChannelProcedure,
	revokeOwnedChannelProcedure,
} from "./work-items/owned-channel";
/**
 * work-items router composition.
 * Capability handlers and shared policy live in ./work-items/.
 */
import {
	setParentProcedure,
	removeRelationProcedure,
	addRelationProcedure,
	corroborateProcedure,
	getByIdRoute,
	getOrgGraphHealthRoute,
	getWorkGraphHealthRoute,
	listActivityRoute,
	attachWorkItemSourceRoute,
	listProjectionsRoute,
	listWorkItemSourcesRoute,
	reconcileWorkItemSourcesRoute,
	listCorroborationsProcedure,
	listRelationsRoute,
	listRoute,
	runWorkGraphStewardRoute,
	upsertProjectionProcedure,
} from "./work-items/coordination-git";
import { createProcedure } from "./work-items/creation-reads";
import { addCommentProcedure } from "./work-items/lifecycle-marketing";
import { closeoutDelegatedProcedure } from "./work-items/delegated-closeout";
import {
	declineProcedure,
	listTriageProcedure,
	markDuplicateProcedure,
	snoozeProcedure,
} from "./work-items/triage";
import {
	listAgentRunsProcedure,
	tellPersonAboutAgentRunProcedure,
} from "./work-items/agent-runs";
import {
	appendAttemptStepsProcedure,
	listAttemptStepsProcedure,
	sendAttemptMessageProcedure,
	stopAttemptProcedure,
} from "./work-items/attempt-steps";
import {
	acceptProcedure,
	cancelFactoryWorkItemProcedure,
	completeProcedure,
	getReadinessProcedure,
	getAdmissionSpecificationProcedure,
	heartbeatAttemptProcedure,
	listAttemptsProcedure,
	listEventsProcedure,
	listEvidenceProcedure,
	previewEvidenceProcedure,
	settleAttemptProcedure,
	startAttemptProcedure,
	submitEvidenceProcedure,
	updateSpecificationProcedure,
	restoreFilingProcedure,
	replaceAdmissionSpecificationProcedure,
	grantLaneAttemptProcedure,
	putResourcePoolProcedure,
	putBudgetEnvelopeProcedure,
	listResourcePoolsProcedure,
	listBudgetEnvelopesProcedure,
} from "./work-items/factory-lifecycle";
import { workItemsOs } from "./work-items/policy-helpers";
import { fileAgentReviewProcedure } from "./work-items/agent-review";
import {
	getAgentScorecardProcedure,
	listAttemptProjectionProcedure,
	listReadinessProjectionProcedure,
	listRecoveryProjectionProcedure,
} from "./work-items/factory-projections";
import {
	addCaseDependencyProcedure,
	attachCaseWorkItemProcedure,
	detachCaseWorkItemProcedure,
	createCaseProcedure,
	getCaseProcedure,
	listCasesProcedure,
	updateCaseProcedure,
	reopenCaseProcedure,
	moveCaseProcedure,
} from "./work-items/cases";
import { inspectAttemptRepositoryProcedure } from "./work-items/workstation-inspection";
import { readAttemptRepositoryProcedure } from "./work-items/repository-read";
import {
	initializeRepositoryCandidateProcedure,
	readRepositoryCandidateProcedure,
	submitRepositoryCandidateProcedure,
	sealRepositoryCandidateProcedure,
} from "./work-items/repository-draft";
import {
	applyRepositoryCandidateProcedure,
	reconcileRepositoryCandidateProcedure,
} from "./work-items/repository-candidate-publication";
import { reviewAttemptRepositoryProcedure } from "./work-items/repository-review";
import { recordDelegationAutonomyFeedbackProcedure } from "./work-items/delegation-autonomy";
import { waitProcedure } from "./work-items/wait";

export const workItemsContractRouter = workItemsOs.router({
	recordDelegationAutonomyFeedback: recordDelegationAutonomyFeedbackProcedure,
	fileAgentReview: fileAgentReviewProcedure,
	listCliProjection: listCliProjectionProcedure,
	getCheckpointProjection: getCheckpointProjectionProcedure,
	listAttemptCliProjection: listAttemptCliProjectionProcedure,
	listEvidenceCliProjection: listEvidenceCliProjectionProcedure,
	listEventCliProjection: listEventCliProjectionProcedure,
	authorizeOwnedChannel: authorizeOwnedChannelProcedure,
	revokeOwnedChannel: revokeOwnedChannelProcedure,
	create: createProcedure,
	list: listRoute,
	listReadinessProjection: listReadinessProjectionProcedure,
	createCase: createCaseProcedure,
	listCases: listCasesProcedure,
	getCase: getCaseProcedure,
	updateCase: updateCaseProcedure,
	reopenCase: reopenCaseProcedure,
	moveCase: moveCaseProcedure,
	attachCaseWorkItem: attachCaseWorkItemProcedure,
	detachCaseWorkItem: detachCaseWorkItemProcedure,
	addCaseDependency: addCaseDependencyProcedure,
	getById: getByIdRoute,
	getMany: getManyProcedure,
	getWorkGraphHealth: getWorkGraphHealthRoute,
	runWorkGraphSteward: runWorkGraphStewardRoute,
	getOrgGraphHealth: getOrgGraphHealthRoute,
	listRelations: listRelationsRoute,
	listActivity: listActivityRoute,
	getAgentScorecard: getAgentScorecardProcedure,
	listAttemptProjection: listAttemptProjectionProcedure,
	listRecoveryProjection: listRecoveryProjectionProcedure,
	attachWorkItemSource: attachWorkItemSourceRoute,
	listProjections: listProjectionsRoute,
	listWorkItemSources: listWorkItemSourcesRoute,
	reconcileWorkItemSources: reconcileWorkItemSourcesRoute,
	updateSpecification: updateSpecificationProcedure,
	restoreFiling: restoreFilingProcedure,
	replaceAdmissionSpecification: replaceAdmissionSpecificationProcedure,
	grantLaneAttempt: grantLaneAttemptProcedure,
	getAdmissionSpecification: getAdmissionSpecificationProcedure,
	putResourcePool: putResourcePoolProcedure,
	putBudgetEnvelope: putBudgetEnvelopeProcedure,
	listResourcePools: listResourcePoolsProcedure,
	listBudgetEnvelopes: listBudgetEnvelopesProcedure,
	accept: acceptProcedure,
	getReadiness: getReadinessProcedure,
	cancel: cancelFactoryWorkItemProcedure,
	decline: declineProcedure,
	markDuplicate: markDuplicateProcedure,
	snooze: snoozeProcedure,
	listTriage: listTriageProcedure,
	complete: completeProcedure,
	closeoutDelegated: closeoutDelegatedProcedure,
	addComment: addCommentProcedure,
	corroborate: corroborateProcedure,
	listCorroborations: listCorroborationsProcedure,
	setParent: setParentProcedure,
	removeRelation: removeRelationProcedure,
	addRelation: addRelationProcedure,
	authorizePersonalCliRelease: authorizePersonalCliReleaseProcedure,
	startAttempt: startAttemptProcedure,
	heartbeatAttempt: heartbeatAttemptProcedure,
	appendAttemptSteps: appendAttemptStepsProcedure,
	listAttemptSteps: listAttemptStepsProcedure,
	sendAttemptMessage: sendAttemptMessageProcedure,
	stopAttempt: stopAttemptProcedure,
	listAgentRuns: listAgentRunsProcedure,
	tellPersonAboutAgentRun: tellPersonAboutAgentRunProcedure,
	settleAttempt: settleAttemptProcedure,
	listAttempts: listAttemptsProcedure,
	inspectAttemptRepository: inspectAttemptRepositoryProcedure,
	readAttemptRepository: readAttemptRepositoryProcedure,
	initializeRepositoryCandidate: initializeRepositoryCandidateProcedure,
	readRepositoryCandidate: readRepositoryCandidateProcedure,
	submitRepositoryCandidate: submitRepositoryCandidateProcedure,
	sealRepositoryCandidate: sealRepositoryCandidateProcedure,
	applyRepositoryCandidate: applyRepositoryCandidateProcedure,
	reconcileRepositoryCandidate: reconcileRepositoryCandidateProcedure,
	reviewAttemptRepository: reviewAttemptRepositoryProcedure,
	submitEvidence: submitEvidenceProcedure,
	listEvidence: listEvidenceProcedure,
	previewEvidence: previewEvidenceProcedure,
	listEvents: listEventsProcedure,
	wait: waitProcedure,
	upsertProjection: upsertProjectionProcedure,
});
