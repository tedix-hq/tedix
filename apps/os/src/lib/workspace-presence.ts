import { useMemo } from "react";
import type { CollabLocation, CollabParticipant } from "@/collab/presence";
import { useCollabDoc } from "@/lib/use-collab-doc";

export function workspacePresenceDocKey(workspaceId: string): string {
	return `workspace:${workspaceId}`;
}

/** Join the workspace-wide roster independently of any open document or app. */
export function useWorkspacePresence({
	workspaceId,
	location,
	enabled = true,
}: {
	workspaceId: string | null;
	location: CollabLocation;
	enabled?: boolean;
}): CollabParticipant[] {
	const canonical = useMemo(
		() => ({ text: "", revision: 0, revisionId: null }),
		[],
	);
	return useCollabDoc({
		workspaceId: workspaceId ?? "",
		docKey: workspacePresenceDocKey(workspaceId ?? ""),
		enabled: enabled && workspaceId !== null,
		canonical,
		location,
	}).participants;
}
