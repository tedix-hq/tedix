/**
 * oRPC Cognitive Stack Router
 *
 * Thin namespace composition over cohesive knowledge, skill catalog,
 * governance, workflow-run, and muscle-memory handler slices.
 */
import { skipOutputValidation } from "../orpc";
import {
	knowledgeGet,
	knowledgeList,
	knowledgeOpine,
	knowledgeSynthesize,
} from "./cognitive-knowledge";
import {
	muscleCrystallize,
	muscleList,
	muscleRegister,
	muscleUsage,
} from "./cognitive-muscle";
import {
	skillsAuditLowQuality,
	skillsDelete,
	skillsFind,
	skillsGet,
	skillsGetForMcp,
	skillsImprove,
	skillsListByApp,
	skillsListByOrg,
	skillsListPromotionCandidates,
	skillsListSummariesByApps,
	skillsMove,
	skillsPreview,
	skillsPromote,
	skillsRecord,
	skillsRepair,
	skillsSweepDraftTtl,
	skillsUsage,
} from "./cognitive-skill-catalog";
import {
	skillsActivateWorkflowImprovement,
	skillsApplyWorkshop,
	skillsAuditToolCoverage,
	skillsInspectWorkflowImprovement,
	skillsInspectWorkshop,
	skillsMineCandidates,
	skillsPortfolioBalance,
	skillsProposeWorkflowImprovement,
	skillsProposeWorkshop,
	skillsQuarantineWorkshop,
	skillsRejectWorkshop,
	skillsReviseWorkshop,
	skillsValidate,
} from "./cognitive-skill-governance";
import {
	skillsApproveWorkflow,
	skillsPauseWorkflow,
	skillsRejectWorkflow,
	skillsRestartWorkflow,
	skillsResumeWorkflow,
	skillsRevokeSkillRun,
} from "./cognitive-skill-runs/lifecycle";
import {
	skillsPauseSchedule,
	skillsResumeSchedule,
} from "./cognitive-skill-schedule";
import {
	skillsCompareWorkflowRevisions,
	skillsGetWorkflowReliability,
	skillsGetWorkflowRevision,
	skillsListWorkflowRevisions,
	skillsListWorkflowSchedules,
} from "./cognitive-skill-runs/revisions";
import {
	skillsGetRunArtifact,
	skillsListRunArtifacts,
	skillsRecordRunEffectObservation,
	skillsGetRunUsefulness,
} from "./cognitive-skill-runs/artifacts";
import {
	skillsInspectWorkflowRun,
	skillsListWorkflowRetryCandidates,
	skillsListWorkflowSteps,
	skillsListWorkflowToolCalls,
	skillsRunWorkflowCancel,
	skillsRunWorkflowHistory,
	skillsRunWorkflowSendEvent,
	skillsRunWorkflowStatus,
} from "./cognitive-skill-runs/run-reads";
import { skillsRunWorkflow } from "./cognitive-skill-runs/run-start";
import { skillsMoveToTedi } from "./cognitive-skill-ownership";
import { knowledgeOs, muscleOs, skillsOs } from "./cognitive-shared";
import {
	skillsGetWorkspaceDraftGrant,
	skillsSetWorkspaceDraftGrant,
	skillsProposeWorkspaceRevision,
	skillsGetWorkspaceDraftProposal,
	skillsListWorkspaceDraftProposals,
	skillsWithdrawWorkspaceDraftProposal,
} from "./cognitive-workspace-skill-drafts";

export const knowledgeContractRouter = knowledgeOs.router({
	synthesize: knowledgeSynthesize,
	opine: knowledgeOpine,
	list: skipOutputValidation(knowledgeList),
	get: skipOutputValidation(knowledgeGet),
});

export const skillsContractRouter = skillsOs.router({
	getWorkspaceDraftGrant: skillsGetWorkspaceDraftGrant,
	setWorkspaceDraftGrant: skillsSetWorkspaceDraftGrant,
	proposeWorkspaceRevision: skillsProposeWorkspaceRevision,
	getWorkspaceDraftProposal: skillsGetWorkspaceDraftProposal,
	listWorkspaceDraftProposals: skillsListWorkspaceDraftProposals,
	withdrawWorkspaceDraftProposal: skillsWithdrawWorkspaceDraftProposal,
	record: skillsRecord,
	improve: skillsImprove,
	proposeWorkshop: skillsProposeWorkshop,
	mineCandidates: skipOutputValidation(skillsMineCandidates),
	portfolioBalance: skipOutputValidation(skillsPortfolioBalance),
	proposeWorkflowImprovement: skillsProposeWorkflowImprovement,
	inspectWorkflowImprovement: skipOutputValidation(
		skillsInspectWorkflowImprovement,
	),
	activateWorkflowImprovement: skipOutputValidation(
		skillsActivateWorkflowImprovement,
	),
	inspectWorkshop: skipOutputValidation(skillsInspectWorkshop),
	reviseWorkshop: skillsReviseWorkshop,
	applyWorkshop: skipOutputValidation(skillsApplyWorkshop),
	rejectWorkshop: skillsRejectWorkshop,
	quarantineWorkshop: skillsQuarantineWorkshop,
	delete: skillsDelete,
	get: skipOutputValidation(skillsGet),
	move: skillsMove,
	moveToTedi: skillsMoveToTedi,
	listByOrg: skipOutputValidation(skillsListByOrg),
	find: skipOutputValidation(skillsFind),
	listByApp: skipOutputValidation(skillsListByApp),
	listSummariesByApps: skipOutputValidation(skillsListSummariesByApps),
	listPromotionCandidates: skipOutputValidation(skillsListPromotionCandidates),
	auditLowQuality: skipOutputValidation(skillsAuditLowQuality),
	sweepDraftTtl: skipOutputValidation(skillsSweepDraftTtl),
	getForMcp: skipOutputValidation(skillsGetForMcp),
	usage: skipOutputValidation(skillsUsage),
	validate: skillsValidate,
	auditToolCoverage: skipOutputValidation(skillsAuditToolCoverage),
	repair: skipOutputValidation(skillsRepair),
	promote: skipOutputValidation(skillsPromote),
	preview: skipOutputValidation(skillsPreview),
	runWorkflow: skillsRunWorkflow,
	recordRunEffectObservation: skillsRecordRunEffectObservation,
	getRunUsefulness: skillsGetRunUsefulness,
	runWorkflowStatus: skipOutputValidation(skillsRunWorkflowStatus),
	runWorkflowCancel: skillsRunWorkflowCancel,
	runWorkflowSendEvent: skillsRunWorkflowSendEvent,
	runWorkflowHistory: skillsRunWorkflowHistory,
	listWorkflowRetryCandidates: skillsListWorkflowRetryCandidates,
	inspectWorkflowRun: skipOutputValidation(skillsInspectWorkflowRun),
	listWorkflowSteps: skipOutputValidation(skillsListWorkflowSteps),
	listWorkflowToolCalls: skipOutputValidation(skillsListWorkflowToolCalls),
	listWorkflowRevisions: skipOutputValidation(skillsListWorkflowRevisions),
	getWorkflowRevision: skipOutputValidation(skillsGetWorkflowRevision),
	compareWorkflowRevisions: skipOutputValidation(
		skillsCompareWorkflowRevisions,
	),
	getWorkflowReliability: skipOutputValidation(skillsGetWorkflowReliability),
	listWorkflowSchedules: skillsListWorkflowSchedules,
	pauseWorkflow: skillsPauseWorkflow,
	resumeWorkflow: skillsResumeWorkflow,
	pauseSchedule: skillsPauseSchedule,
	resumeSchedule: skillsResumeSchedule,
	restartWorkflow: skillsRestartWorkflow,
	approveWorkflow: skillsApproveWorkflow,
	rejectWorkflow: skillsRejectWorkflow,
	getRunArtifact: skipOutputValidation(skillsGetRunArtifact),
	listRunArtifacts: skipOutputValidation(skillsListRunArtifacts),
	revokeSkillRun: skillsRevokeSkillRun,
});

export const muscleContractRouter = muscleOs.router({
	list: skipOutputValidation(muscleList),
	register: muscleRegister,
	crystallize: muscleCrystallize,
	usage: skipOutputValidation(muscleUsage),
});
