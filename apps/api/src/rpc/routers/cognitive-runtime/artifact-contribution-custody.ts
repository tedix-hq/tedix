import type { TediRuntimeEvent } from "@tedix/api-contract/schemas/cognitive-runtime";
import type { TediArtifactRow } from "@tedix/db/queries/cognitive-runtime";

export function artifactContributionCustody(
	artifact: TediArtifactRow | null,
	event: Pick<
		TediRuntimeEvent,
		| "id"
		| "tediId"
		| "runId"
		| "conversationId"
		| "kind"
		| "payload"
		| "createdAt"
	>,
	organizationId: string,
	canonicalRetry: boolean,
): "owned" | "legacy_workstation" | "rejected_producer_context" | "conflict" {
	if (
		!artifact ||
		artifact.organizationId !== organizationId ||
		artifact.tediId !== event.tediId ||
		artifact.accessClassification !== "runtime_private"
	)
		return "conflict";
	if (
		artifact.runId === event.runId &&
		artifact.conversationId === event.conversationId
	)
		return "owned";
	if (
		artifact.runId === event.runId &&
		artifact.conversationId === null &&
		artifact.kind === "log" &&
		artifact.id.startsWith(`${event.runId}:artifact:workstation_process:`) &&
		artifact.metadata?.source === "workstation_process" &&
		artifact.metadata?.subKind === "workstation_process" &&
		artifact.metadata?.producer === "workstation-adapter"
	)
		return "legacy_workstation";
	// Preserve a recorded bad claim as rejected history, never as artifact ownership.
	if (
		canonicalRetry &&
		event.kind === "tool.completed" &&
		event.id.startsWith(`${event.runId}:native-tool.`) &&
		event.payload?.surface === "native_tool" &&
		event.payload?.name === "record_artifact" &&
		Array.isArray(event.payload.producedArtifactIds) &&
		event.payload.producedArtifactIds.includes(artifact.id) &&
		artifact.runId &&
		artifact.runId !== event.runId &&
		artifact.conversationId &&
		artifact.conversationId !== event.conversationId &&
		artifact.id.startsWith(`${artifact.runId}:artifact:v2:deliverable:`) &&
		artifact.metadata?.subKind === "deliverable" &&
		artifact.metadata?.producer === "tedi-tool" &&
		artifact.contentDigest &&
		artifact.createdAt <= event.createdAt
	)
		return "rejected_producer_context";
	return "conflict";
}
