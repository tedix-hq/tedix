import { rankSkillsRoute } from "./cognitive-runtime/jev-skills";
import { rankDiscoveryRoute } from "./cognitive-runtime/jev-discovery";
/**
 * cognitive-runtime router composition.
 * Capability handlers and shared policy live in ./cognitive-runtime/.
 */
import {
	approveRoute,
	enqueueMessageRoute,
	listApprovalsRoute,
	stopRunRoute,
} from "./cognitive-runtime/control";
import {
	listConversationsRoute,
	readMessagesRoute,
} from "./cognitive-runtime/conversations";
import {
	createArtifactShareLinkRoute,
	emitAutomationEventRoute,
	getArtifactRoute,
	getStabilityRoute,
	getStatusRoute,
	listArtifactsRoute,
	listEventsRoute,
	patchDispatchIdempotencyRoute,
	recordArtifactRoute,
	recordEventRoute,
	writeDispatchIdempotencyRoute,
} from "./cognitive-runtime/events-artifacts";
import { cognitiveRuntimeOs } from "./cognitive-runtime/events-policy";
import {
	approveArtifactReleaseRoute,
	createRedactedArtifactRevisionRoute,
	getArtifactReleaseReviewRoute,
	revokeArtifactReleaseRoute,
} from "./cognitive-runtime/artifact-releases";

export const cognitiveRuntimeContractRouter = cognitiveRuntimeOs.router({
	rankDiscovery: rankDiscoveryRoute,
	rankSkills: rankSkillsRoute,
	listConversations: listConversationsRoute,
	readMessages: readMessagesRoute,
	// Async dispatch path — returns quickly and lets the runtime turn complete
	// out-of-band. The runtime-assigned runId is correlated to the caller-minted
	// idempotencyKey via the
	// chat_dispatch_idempotency table when the first runtime event lands.
	enqueueMessage: enqueueMessageRoute,
	listApprovals: listApprovalsRoute,
	stopRun: stopRunRoute,
	approve: approveRoute,
	getStatus: getStatusRoute,
	getStability: getStabilityRoute,
	listEvents: listEventsRoute,
	recordEvent: recordEventRoute,
	listArtifacts: listArtifactsRoute,
	recordArtifact: recordArtifactRoute,
	getArtifact: getArtifactRoute,
	createArtifactShareLink: createArtifactShareLinkRoute,
	createRedactedArtifactRevision: createRedactedArtifactRevisionRoute,
	getArtifactReleaseReview: getArtifactReleaseReviewRoute,
	approveArtifactRelease: approveArtifactReleaseRoute,
	revokeArtifactRelease: revokeArtifactReleaseRoute,
	emitAutomationEvent: emitAutomationEventRoute,
	// Internal — service-binding only. Upserts a chat dispatch idempotency
	// mapping before the runId is known.
	writeDispatchIdempotency: writeDispatchIdempotencyRoute,
	// Internal — service-binding only. Fills in the runId for the oldest
	// queued mapping for (tediId, conversationId) that has no runId yet.
	// Bounded to a 5-minute lookback to avoid binding stale mappings.
	patchDispatchIdempotency: patchDispatchIdempotencyRoute,
});
