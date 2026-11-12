import { useEffect, useMemo } from "react";
import { workspaceRoomDocKey } from "@tedix/api-contract/utils/workspace-room";
import { publishOutputRevisionNotice } from "@/lib/output-revision-notices";
import type { CollabLocation, CollabParticipant } from "@/collab/presence";
import { useCollabDoc } from "@/lib/use-collab-doc";

/** How often a tab outside the workspace's live room asks about its files. */
export const WORKSPACE_ROOM_FALLBACK_RECHECK_MS = 30_000;

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
		if (!workspaceId || !enabled) return;
		const resync = () =>
			publishOutputRevisionNotice({ type: "resync", workspaceId });
		if (connected) return resync();
		// A tab that cannot join gets no notices: the room is full (it holds
		// `MAX_SOCKETS` connections), or the network blocks the connection.
		// Until it joins, it asks whether its files changed when someone comes
		// back to it, and on a slow timer.
		const onVisible = () => {
			if (document.visibilityState === "visible") resync();
		};
		const timer = setInterval(() => {
			if (document.visibilityState === "visible") resync();
		}, WORKSPACE_ROOM_FALLBACK_RECHECK_MS);
		window.addEventListener("focus", resync);
		document.addEventListener("visibilitychange", onVisible);
		return () => {
			clearInterval(timer);
			window.removeEventListener("focus", resync);
			document.removeEventListener("visibilitychange", onVisible);
		};
	}, [connected, enabled, workspaceId]);
	return room.participants;
}
