/**
 * oRPC Cognitive Stack Router
 *
 * Thin namespace composition over cohesive knowledge, skill catalog,
 * governance, workflow-run, and muscle-memory handler slices.
 */
import {
	skillsArchive,
	skillsArchiveMany,
	skillsRestore,
} from "./cognitive-skill-archives";
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
	skillsRetireUnstartedWorkflow,
	skillsResumeWorkflow,
	skillsRevokeSkillRun,
} from "./cognitive-skill-runs/lifecycle";
import {
	skillsRemoveSchedule,
	skillsPauseSchedule,
	skillsResumeSchedule,
	skillsUpdateSchedule,
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
	skillsGetWorkflowRunTimeline,
	skillsListWorkflowRetryCandidates,
	skillsListWorkflowSteps,
	skillsListWorkflowToolCalls,
	skillsRunWorkflowCancel,
	skillsRunWorkflowHistory,
	skillsRunWorkflowSendEvent,
	skillsRunWorkflowStatus,
} from "./cognitive-skill-runs/run-reads";
import { skillsGetWorkflowStepTediActivity } from "./cognitive-skill-runs/tedi-activity";
import {
	skillsCheckWorkItemWatch,
	skillsStartWorkItemWatch,
} from "./cognitive-skill-runs/watch";
import { skillsRunWorkflow } from "./cognitive-skill-runs/run-start";
import {
	skillsClearRunSensitiveDataLatch,
	skillsGetRunSensitiveDataLatch,
} from "./cognitive-skill-runs/sensitive-data-latch";
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
	archive: skillsArchive,
	archiveMany: skillsArchiveMany,
	restore: skillsRestore,
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
	startWorkItemWatch: skillsStartWorkItemWatch,
	checkWorkItemWatch: skillsCheckWorkItemWatch,
	runWorkflowSendEvent: skillsRunWorkflowSendEvent,
	runWorkflowHistory: skillsRunWorkflowHistory,
	listWorkflowRetryCandidates: skillsListWorkflowRetryCandidates,
	inspectWorkflowRun: skipOutputValidation(skillsInspectWorkflowRun),
	getWorkflowRunTimeline: skillsGetWorkflowRunTimeline,
	getWorkflowStepTediActivity: skillsGetWorkflowStepTediActivity,
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
	getRunSensitiveDataLatch: skillsGetRunSensitiveDataLatch,
	clearRunSensitiveDataLatch: skillsClearRunSensitiveDataLatch,
	resumeWorkflow: skillsResumeWorkflow,
	removeSchedule: skillsRemoveSchedule,
	pauseSchedule: skillsPauseSchedule,
	resumeSchedule: skillsResumeSchedule,
	updateSchedule: skillsUpdateSchedule,
	restartWorkflow: skillsRestartWorkflow,
	retireUnstartedWorkflow: skillsRetireUnstartedWorkflow,
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
