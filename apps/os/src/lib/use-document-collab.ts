/**
 * Glue between a canvas collab room and the rich document editor: remote
 * document moves delivered synchronously, and selections carried as presence.
 */
import { useMemo } from "react";
import type { OtEditSession } from "@/collab/ot/edit-session";
import type { CollabParticipant, CollabSelection } from "@/collab/presence";
import { COLLAB_DOC_PATH } from "@/collab/protocol";
import { collabParticipantColor } from "@/components/canvas-presence";
import type { DocumentCollab } from "@/components/output-editor-document";
import { parseOutputDraft } from "@/lib/canvas-draft";
import type { RemoteCursor } from "@/lib/document-remote-cursors";

/** Collaborators whose rich-text selection is in this document. */
export function remoteCursorsFromParticipants(
	participants: readonly CollabParticipant[],
): RemoteCursor[] {
	const cursors: RemoteCursor[] = [];
	for (const participant of participants) {
		const selection = participant.selection;
		if (
			!selection ||
			selection.space !== "rich-text" ||
			selection.path !== COLLAB_DOC_PATH
		)
			continue;
		cursors.push({
			key: participant.key,
			name: participant.displayName,
			color: collabParticipantColor(participant.key),
			anchor: selection.anchor,
			head: selection.head,
		});
	}
	return cursors;
}

export function useDocumentCollab(input: {
	session: OtEditSession | null;
	enabled: boolean;
	participants: readonly CollabParticipant[];
	setSelection: (selection: CollabSelection | null) => void;
}): { collab: DocumentCollab | undefined; cursors: RemoteCursor[] } {
	const { session, enabled, participants, setSelection } = input;
	const collab = useMemo<DocumentCollab | undefined>(
		() =>
			session && enabled
				? {
						subscribe: (apply) =>
							session.onRemote(() => {
								const parsed = parseOutputDraft(
									session.text(COLLAB_DOC_PATH),
									"document",
								);
								if (parsed.ok && parsed.content.kind === "document")
									apply(parsed.content);
							}),
						publishSelection: (selection) =>
							setSelection(
								selection
									? { path: COLLAB_DOC_PATH, ...selection, space: "rich-text" }
									: null,
							),
					}
				: undefined,
		[session, enabled, setSelection],
	);
	const cursors = useMemo(
		() => remoteCursorsFromParticipants(participants),
		[participants],
	);
	return { collab, cursors };
}
