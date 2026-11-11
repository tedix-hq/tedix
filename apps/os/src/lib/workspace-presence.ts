import { useEffect, useMemo } from "react";
import { workspaceRoomDocKey } from "@tedix/api-contract/utils/workspace-room";
import { publishOutputRevisionNotice } from "@/lib/output-revision-notices";
import type { CollabLocation, CollabParticipant } from "@/collab/presence";
import { useCollabDoc } from "@/lib/use-collab-doc";

export function workspacePresenceDocKey(workspaceId: string): string {
	return workspaceRoomDocKey(workspaceId);
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
	const room = useCollabDoc({
		workspaceId: workspaceId ?? "",
		docKey: workspacePresenceDocKey(workspaceId ?? ""),
		enabled: enabled && workspaceId !== null,
		canonical,
		location,
	});
	// The room also carries notices of saved files. One sent while this tab
	// was not connected is gone, so every (re)connection asks open editors to
	// check their files once.
	const connected = room.status === "connected";
	useEffect(() => {
		if (connected && workspaceId)
			publishOutputRevisionNotice({ type: "resync", workspaceId });
	}, [connected, workspaceId]);
	return room.participants;
}
