import { act, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it } from "vite-plus/test";
import { useWorkspaceChat } from "./use-workspace-chat";
import type {
	createWorkspaceChatClient,
	WorkspaceChatClient,
	WorkspaceChatSnapshot,
} from "./workspace-chat-client";
import { initialWorkspaceChatState } from "./workspace-chat-state";

(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

function harness() {
	const clients: Array<{
		client: WorkspaceChatClient;
		assign: (id: string) => void;
		closed: () => boolean;
	}> = [];
	const announced: string[] = [];
	const createClient: typeof createWorkspaceChatClient = ({
		conversationId,
	}) => {
		let closed = false;
		let snapshot: WorkspaceChatSnapshot = {
			state: initialWorkspaceChatState(conversationId),
			connection: { phase: "open", since: 0 },
			catchingUp: false,
		};
		const listeners = new Set<() => void>();
		const client: WorkspaceChatClient = {
			getSnapshot: () => snapshot,
			getConversationId: () => snapshot.state.conversationId,
			subscribe: (listener) => {
				listeners.add(listener);
				return () => listeners.delete(listener);
			},
			sendTurn: () => "turn",
			decideApproval() {},
			cancelTurn() {},
			loadEarlier() {},
			forceDrop() {},
			retry() {},
			close: () => {
				closed = true;
			},
		};
		clients.push({
			client,
			closed: () => closed,
			assign: (id) => {
				snapshot = {
					...snapshot,
					state: { ...snapshot.state, conversationId: id },
				};
				for (const listener of listeners) listener();
			},
		});
		return client;
	};
	function Probe({ conversationId }: { conversationId: string | null }) {
		const { client } = useWorkspaceChat(
			"workspace",
			conversationId,
			createClient,
		);
		useEffect(() => {
			const assigned = client?.getConversationId();
			if (conversationId === null && assigned) announced.push(assigned);
		}, [client, conversationId, client?.getSnapshot().state.conversationId]);
		return null;
	}
	const host = document.createElement("div");
	const root = createRoot(host);
	return {
		clients,
		announced,
		render: (conversationId: string | null) =>
			act(() => root.render(<Probe conversationId={conversationId} />)),
		close: () => act(() => root.unmount()),
	};
}

describe("useWorkspaceChat selection", () => {
	it("never announces the previous conversation when opening a blank draft", () => {
		const test = harness();
		try {
			test.render("existing");
			test.render(null);
			expect(test.announced).toEqual([]);
			expect(test.clients).toHaveLength(2);
			expect(test.clients[0]?.closed()).toBe(true);
			expect(test.clients[1]?.client.getConversationId()).toBeNull();
		} finally {
			test.close();
		}
	});

	it("keeps the first-turn stream when its assigned id reaches the URL, then allows another draft", () => {
		const test = harness();
		try {
			test.render(null);
			act(() => test.clients[0]!.assign("assigned"));
			expect(test.announced).toEqual(["assigned"]);
			test.render("assigned");
			expect(test.clients).toHaveLength(1);
			expect(test.clients[0]?.closed()).toBe(false);
			test.render(null);
			expect(test.announced).toEqual(["assigned"]);
			expect(test.clients).toHaveLength(2);
		} finally {
			test.close();
		}
	});
});
