import { useSyncExternalStore } from "react";

/**
 * Another pane of a workspace hands text to the chat's message box, for the
 * person to read, change and send themselves. Nothing here sends a message.
 *
 * Two sides register per workspace. The page that shows the chat says it can
 * bring the chat into view (`hostWorkspaceChatDrafts`); the message box takes
 * the text (`receiveWorkspaceChatDrafts`). Text offered while no message box
 * is on screen waits here until one is.
 */
type Receive = (text: string) => void;

const hosts = new Map<string, Set<() => void>>();
const receivers = new Map<string, Set<Receive>>();
const waiting = new Map<string, string[]>();
const hostListeners = new Set<() => void>();

function register<T>(map: Map<string, Set<T>>, key: string, value: T) {
	const set = map.get(key) ?? new Set<T>();
	set.add(value);
	map.set(key, set);
	return () => {
		set.delete(value);
		if (set.size === 0 && map.get(key) === set) map.delete(key);
	};
}

/** The page showing this workspace's chat; `reveal` brings the chat into view. */
export function hostWorkspaceChatDrafts(
	workspaceId: string,
	reveal: () => void,
): () => void {
	const remove = register(hosts, workspaceId, reveal);
	for (const listener of hostListeners) listener();
	return () => {
		remove();
		// Nobody is left to show it: text still waiting would surprise later.
		if (!hosts.has(workspaceId)) waiting.delete(workspaceId);
		for (const listener of hostListeners) listener();
	};
}

/** The message box of this workspace's chat; gets waiting text at once. */
export function receiveWorkspaceChatDrafts(
	workspaceId: string,
	receive: Receive,
): () => void {
	const remove = register(receivers, workspaceId, receive);
	const texts = waiting.get(workspaceId);
	if (texts) {
		waiting.delete(workspaceId);
		for (const text of texts) receive(text);
	}
	return remove;
}

/**
 * Puts text into the workspace chat's message box and brings the chat into
 * view. Returns false when no page shows that chat, so nothing was offered.
 */
export function offerWorkspaceChatDraft(
	workspaceId: string,
	text: string,
): boolean {
	const reveal = hosts.get(workspaceId);
	if (!reveal || !text.trim()) return false;
	for (const show of reveal) show();
	const receive = receivers.get(workspaceId);
	if (receive?.size) for (const take of receive) take(text);
	else waiting.set(workspaceId, [...(waiting.get(workspaceId) ?? []), text]);
	return true;
}

/** Whether a page shows this workspace's chat, so text can be handed to it. */
export function useWorkspaceChatDraftHost(workspaceId: string): boolean {
	return useSyncExternalStore(
		(listener) => {
			hostListeners.add(listener);
			return () => hostListeners.delete(listener);
		},
		() => hosts.has(workspaceId),
		() => false,
	);
}
