import { useSyncExternalStore } from "react";

/**
 * Another pane of a workspace hands text to the chat's message box, for the
 * person to read, change and send themselves. Drafts are never sent here;
 * only an app's ask (below) is, as the person's own visible message.
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

/**
 * A workspace app asks the workspace agent to do something for the person
 * using it. Unlike a draft, the chat sends it at once, as that person's own
 * message, and shows which app it came from.
 */
export type WorkspaceChatAsk = {
	text: string;
	/** Start a new conversation, or continue the one the chat shows. */
	conversation: "new" | "current";
	fromAppId: string;
};

/** Sends the message and returns its turn id. */
type TakeAsk = (ask: WorkspaceChatAsk) => string;

const askTakers = new Map<string, Set<TakeAsk>>();
const waitingAsks = new Map<
	string,
	Array<{ ask: WorkspaceChatAsk; resolve: (turnId: string | null) => void }>
>();
/** How long an ask waits for the chat to connect before it gives up. */
const ASK_WAIT_MS = 15_000;

export type AskedTurnStatus = {
	/** `waiting`: the turn stopped until someone decides a change it proposed. */
	status: "running" | "waiting" | "done" | "error";
	/** The agent's answer so far; final once the turn is done. */
	text: string;
};
/** Turns apps asked for in this page, by turn id, with the asking app. */
const askedTurns = new Map<string, AskedTurnStatus & { appId: string }>();

/** The chat that can send this workspace's asks; gets waiting asks at once. */
export function receiveWorkspaceChatAsks(
	workspaceId: string,
	take: TakeAsk,
): () => void {
	const remove = register(askTakers, workspaceId, take);
	const asks = waitingAsks.get(workspaceId);
	if (asks) {
		waitingAsks.delete(workspaceId);
		for (const { ask, resolve } of asks) resolve(sendAsk(take, ask));
	}
	return remove;
}

function sendAsk(take: TakeAsk, ask: WorkspaceChatAsk): string {
	const turnId = take(ask);
	askedTurns.set(turnId, { appId: ask.fromAppId, status: "running", text: "" });
	return turnId;
}

/**
 * Sends an app's ask through this workspace's chat and brings the chat into
 * view. Resolves to the turn id, or null when no page shows a chat that can
 * send it.
 */
export function askWorkspaceChat(
	workspaceId: string,
	ask: WorkspaceChatAsk,
): Promise<string | null> {
	const reveal = hosts.get(workspaceId);
	if (!reveal || !ask.text.trim()) return Promise.resolve(null);
	for (const show of reveal) show();
	const take = askTakers.get(workspaceId)?.values().next().value;
	if (take) return Promise.resolve(sendAsk(take, ask));
	return new Promise((resolve) => {
		const entry = { ask, resolve };
		waitingAsks.set(workspaceId, [
			...(waitingAsks.get(workspaceId) ?? []),
			entry,
		]);
		setTimeout(() => {
			const left = waitingAsks.get(workspaceId)?.filter((e) => e !== entry);
			if (left?.length) waitingAsks.set(workspaceId, left);
			else waitingAsks.delete(workspaceId);
			resolve(null);
		}, ASK_WAIT_MS);
	});
}

/** The chat reports how an asked turn is going; other turns are ignored. */
export function noteAskedTurn(turnId: string, status: AskedTurnStatus): void {
	const asked = askedTurns.get(turnId);
	if (asked) askedTurns.set(turnId, { ...asked, ...status });
}

/** How a turn this app asked for is going, as far as this page has seen. */
export function askedTurnStatus(
	appId: string,
	turnId: string,
): AskedTurnStatus | null {
	const asked = askedTurns.get(turnId);
	if (!asked || asked.appId !== appId) return null;
	return { status: asked.status, text: asked.text };
}
