import { useEffect, useReducer, useRef, useSyncExternalStore } from "react";
import {
	createWorkspaceChatClient,
	type WorkspaceChatClient,
	type WorkspaceChatSnapshot,
} from "./workspace-chat-client";
import { initialWorkspaceChatState } from "./workspace-chat-state";

export type WorkspaceChatHandle = {
	snapshot: WorkspaceChatSnapshot;
	client: WorkspaceChatClient | null;
};

const IDLE: WorkspaceChatSnapshot = {
	state: initialWorkspaceChatState(null),
	connection: { phase: "connecting", attempt: 0 },
	catchingUp: true,
};

const noSubscribe = () => () => {};
const idle = () => IDLE;

/**
 * One socket to the workspace object for the life of this chat pane. A change
 * of conversation reopens it with the new subscription, except when the new id
 * is the one the object just assigned to this socket's first turn: that socket
 * already follows it, and reopening would cut the stream mid-turn.
 */
export function useWorkspaceChat(
	workspaceId: string,
	conversationId: string | null,
	createClient: typeof createWorkspaceChatClient = createWorkspaceChatClient,
	onOutputChanged?: () => void,
): WorkspaceChatHandle {
	const outputChanged = useRef(onOutputChanged);
	outputChanged.current = onOutputChanged;
	const live = useRef<{
		workspaceId: string;
		client: WorkspaceChatClient;
	} | null>(null);
	const [, rerender] = useReducer((count: number) => count + 1, 0);
	useEffect(() => {
		const previous = live.current;
		if (
			previous &&
			previous.workspaceId === workspaceId &&
			previous.client.getSnapshot().connection.phase !== "closed" &&
			previous.client.getConversationId() === conversationId
		)
			return;
		previous?.client.close();
		live.current = {
			workspaceId,
			client: createClient({
				workspaceId,
				conversationId,
				onOutputChanged: () => outputChanged.current?.(),
			}),
		};
		rerender();
	}, [workspaceId, conversationId, createClient]);
	useEffect(
		() => () => {
			live.current?.client.close();
			live.current = null;
		},
		[],
	);
	const client = live.current?.client ?? null;
	const snapshot = useSyncExternalStore(
		client?.subscribe ?? noSubscribe,
		client?.getSnapshot ?? idle,
		client?.getSnapshot ?? idle,
	);
	return { snapshot, client };
}
