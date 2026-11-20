/**
 * The unsent message of a workspace chat, kept per conversation for this
 * browser tab so it survives a reload and a switch to another conversation.
 * `null` is the new conversation, before its first message.
 */
function draftKey(workspaceId: string, conversationId: string | null) {
	return `tedix.workspace-chat.draft.${workspaceId}.${conversationId ?? "new"}`;
}

export function readWorkspaceChatDraft(
	workspaceId: string,
	conversationId: string | null,
): string {
	try {
		return (
			window.sessionStorage.getItem(draftKey(workspaceId, conversationId)) ?? ""
		);
	} catch {
		return "";
	}
}

export function writeWorkspaceChatDraft(
	workspaceId: string,
	conversationId: string | null,
	text: string,
) {
	try {
		const key = draftKey(workspaceId, conversationId);
		if (text) window.sessionStorage.setItem(key, text);
		else window.sessionStorage.removeItem(key);
	} catch {
		// Storage can be unavailable; the draft still lives on this page.
	}
}
