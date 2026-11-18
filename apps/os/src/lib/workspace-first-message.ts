/** Workspace names are capped at 120 characters by the contract. */
export const WORKSPACE_NAME_MAX_CHARS = 120;

const WORKSPACE_NAME_MAX_WORDS = 6;
const WORKSPACE_NAME_FALLBACK = "New workspace";

/**
 * A short workspace name from the question that starts it: the first six
 * words of its first non-empty line, without trailing punctuation.
 */
export function workspaceNameFromQuestion(question: string): string {
	const firstLine =
		question
			.split("\n")
			.map((line) => line.trim())
			.find(Boolean) ?? "";
	const words = firstLine.split(/\s+/).filter(Boolean);
	const name = words
		.slice(0, WORKSPACE_NAME_MAX_WORDS)
		.join(" ")
		.replace(/[\s.,;:!?…-]+$/u, "")
		.slice(0, WORKSPACE_NAME_MAX_CHARS)
		.trim();
	return name || WORKSPACE_NAME_FALLBACK;
}

function pendingMessageKey(workspaceId: string): string {
	return `tedix.workspace-chat.pending.${workspaceId}`;
}

/**
 * Holds a message for the workspace's chat to send once it opens. Session
 * storage keeps it across the navigation and a reload, and never leaves the
 * tab. `conversation` is the conversation it belongs to, or "new".
 */
export function holdWorkspaceFirstMessage(
	workspaceId: string,
	text: string,
	conversation = "new",
): void {
	try {
		window.sessionStorage.setItem(
			pendingMessageKey(workspaceId),
			JSON.stringify({ conversation, text }),
		);
	} catch {
		// Without storage the workspace still opens; the question stays unsent.
	}
}

/**
 * Takes the held message for this workspace and conversation, once. A message
 * held for another conversation stays where it is.
 */
export function takeWorkspaceFirstMessage(
	workspaceId: string,
	conversationId: string | null,
): string | null {
	const key = pendingMessageKey(workspaceId);
	try {
		const value = window.sessionStorage.getItem(key);
		if (!value) return null;
		const pending = JSON.parse(value) as {
			conversation?: unknown;
			text?: unknown;
		};
		if (pending.conversation !== (conversationId ?? "new")) return null;
		window.sessionStorage.removeItem(key);
		return typeof pending.text === "string" && pending.text.trim()
			? pending.text
			: null;
	} catch {
		try {
			window.sessionStorage.removeItem(key);
		} catch {
			// storage unavailable
		}
		return null;
	}
}
