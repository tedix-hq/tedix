import { useMemo } from "react";
import type { CollabParticipant } from "@/collab/presence";
import { useCollabDoc } from "@/lib/use-collab-doc";

/** The room a runtime app shares: who is using it now, and its live updates. */
export function appPresenceDocKey(gadgetId: string): string {
	return `app:${gadgetId}`;
}

/**
 * Join the app's own room and report who else is in it. The room carries no
 * document of its own, so it is grounded on the app's current revision with
 * empty text; a new revision carries the room forward. `view` names the tab
 * this person has open, so others see "Drafts" or "Code" next to the name.
 */
export function useAppPresence({
	workspaceId,
	gadgetId,
	revision,
	appName,
	view,
	enabled,
}: {
	workspaceId: string;
	gadgetId: string;
	revision: { id: string; revision: number } | null | undefined;
	appName: string | undefined;
	view: string;
	enabled: boolean;
}): CollabParticipant[] {
	const revisionId = revision?.id ?? null;
	const revisionNumber = revision?.revision ?? null;
	const canonical = useMemo(
		() =>
			revisionNumber === null
				? null
				: { text: "", revision: revisionNumber, revisionId },
		[revisionId, revisionNumber],
	);
	const { participants } = useCollabDoc({
		workspaceId,
		docKey: appPresenceDocKey(gadgetId),
		enabled: enabled && canonical !== null,
		canonical,
		location: {
			surface: "canvas",
			artifactKind: "gadget",
			...(appName ? { artifactLabel: appName } : {}),
			selectionLabel: view,
		},
	});
	return participants;
}

/**
 * One roster from the app's room and the manifest's editing room. A person in
 * both appears once, with the app room's entry, which says which tab they are on.
 */
export function mergeAppPresence(
	appRoom: readonly CollabParticipant[],
	editorRoom: readonly CollabParticipant[],
): CollabParticipant[] {
	const seen = new Set(appRoom.map((participant) => participant.key));
	return [
		...appRoom,
		...editorRoom.filter((participant) => !seen.has(participant.key)),
	];
}
