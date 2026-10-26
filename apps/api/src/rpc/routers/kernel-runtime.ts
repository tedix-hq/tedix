import { readOperatorRecordsRoute } from "./kernel-runtime/operator-records";
/**
 * kernel-runtime router composition.
 * Capability handlers and shared policy live in ./kernel-runtime/.
 */
import {
	archiveConversationRoute,
	attachConversationCapabilityRoute,
	approvePlanAssignmentsRoute,
	deleteConversationRoute,
	detachConversationCapabilityRoute,
	detachConversationArtifactPinRoute,
	attachConversationArtifactPinRoute,
	listConversationArtifactPinsRoute,
	listConversationCapabilitiesRoute,
	listConversationsRoute,
	pinConversationRoute,
	readChildRunEvidenceRoute,
	readChildRunTreeRoute,
	readConversationChargesRoute,
	readConversationEventsRoute,
	readMessagesRoute,
	readRunRoute,
	readRunSetRoute,
	listPendingHomeDelegationsRoute,
	readRunTraceRoute,
	renameConversationRoute,
	resolveDelegationWorkOrderRoute,
} from "./kernel-runtime/conversations-reads";
import {
	cancelRunRoute,
	readRunEventsRoute,
	resolvePageToolRoute,
	respondApprovalRoute,
	retryDelegationRoute,
	retryRunRoute,
	steerRunRoute,
	controlRunSteeringRoute,
} from "./kernel-runtime/delegation-control";
import {
	enqueueMessageRoute,
	getRepoCommitApprovalStatusRoute,
	proposeCodemodeExecuteRoute,
	proposeRepoCommitRoute,
	startGoalLoopRoute,
} from "./kernel-runtime/execution-proposals";
import {
	executeReadOnlyToolRoute,
	listReadOnlyToolsRoute,
} from "./kernel-runtime/direct-read";
import { kernelRuntimeOs } from "./kernel-runtime/policy-normalization";
import { uploadAttachmentRoute } from "./kernel-runtime/attachments";
import { readToolResultRoute } from "./kernel-runtime/tool-results";
import { sweepDelegationAutonomyRoute } from "./kernel-runtime/delegation-autonomy-sweep";

export const kernelRuntimeContractRouter = kernelRuntimeOs.router({
	readOperatorRecords: readOperatorRecordsRoute,
	sweepDelegationAutonomy: sweepDelegationAutonomyRoute,
	listConversationCapabilities: listConversationCapabilitiesRoute,
	attachConversationCapability: attachConversationCapabilityRoute,
	detachConversationCapability: detachConversationCapabilityRoute,
	listConversationArtifactPins: listConversationArtifactPinsRoute,
	attachConversationArtifactPin: attachConversationArtifactPinRoute,
	detachConversationArtifactPin: detachConversationArtifactPinRoute,
	uploadAttachment: uploadAttachmentRoute,
	listConversations: listConversationsRoute,
	renameConversation: renameConversationRoute,
	deleteConversation: deleteConversationRoute,
	pinConversation: pinConversationRoute,
	archiveConversation: archiveConversationRoute,
	readMessages: readMessagesRoute,
	readRunSet: readRunSetRoute,
	readConversationCharges: readConversationChargesRoute,
	readConversationEvents: readConversationEventsRoute,
	listPendingHomeDelegations: listPendingHomeDelegationsRoute,
	readChildRunEvidence: readChildRunEvidenceRoute,
	readChildRunTree: readChildRunTreeRoute,
	resolveDelegationWorkOrder: resolveDelegationWorkOrderRoute,
	approvePlanAssignments: approvePlanAssignmentsRoute,
	readRun: readRunRoute,
	readRunTrace: readRunTraceRoute,
	readRunEvents: readRunEventsRoute,
	cancelRun: cancelRunRoute,
	resolvePageTool: resolvePageToolRoute,
	steerRun: steerRunRoute,
	controlRunSteering: controlRunSteeringRoute,
	// THE Home approval surface: the caller supplies a homeRunId (never a raw
	// approval UUID) and a decision; the pending target is resolved FROM THE
	// RUN — a parked home_tool_write approval card or a proposed Home plan.
	respondApproval: respondApprovalRoute,
	retryRun: retryRunRoute,
	retryDelegation: retryDelegationRoute,
	enqueueMessage: enqueueMessageRoute,
	executeReadOnlyTool: executeReadOnlyToolRoute,
	listReadOnlyTools: listReadOnlyToolsRoute,
	readToolResult: readToolResultRoute,
	startGoalLoop: startGoalLoopRoute,
	proposeRepoCommit: proposeRepoCommitRoute,
	proposeCodemodeExecute: proposeCodemodeExecuteRoute,
	getRepoCommitApprovalStatus: getRepoCommitApprovalStatusRoute,
});
