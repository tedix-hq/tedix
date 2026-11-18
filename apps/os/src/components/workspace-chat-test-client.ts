import type {
	createWorkspaceChatClient,
	WorkspaceChatClient,
	WorkspaceChatSnapshot,
} from "@/lib/workspace-chat-client";
import type { WorkspaceChatLedgerEvent } from "@/lib/workspace-chat-protocol";
import {
	applyWorkspaceChatEvents,
	initialWorkspaceChatState,
} from "@/lib/workspace-chat-state";

/** Test only: a chat client whose snapshot the test drives by hand. */
export function fakeWorkspaceChatClient(conversationId: string | null) {
	let snapshot: WorkspaceChatSnapshot = {
		state: initialWorkspaceChatState(conversationId),
		connection: { phase: "open", since: 0 },
		catchingUp: false,
	};
	const listeners = new Set<() => void>();
	const calls: unknown[][] = [];
	const client: WorkspaceChatClient = {
		getSnapshot: () => snapshot,
		getConversationId: () => snapshot.state.conversationId,
		subscribe(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		sendTurn(input) {
			calls.push(["sendTurn", input]);
			return "client-turn";
		},
		decideApproval(approvalId, decision) {
			calls.push(["decideApproval", approvalId, decision]);
		},
		decideApprovals(approvalIds, decision) {
			calls.push(["decideApprovals", approvalIds, decision]);
		},
		dismissApprovalNotice() {
			calls.push(["dismissApprovalNotice"]);
		},
		cancelTurn(turnId) {
			calls.push(["cancelTurn", turnId]);
		},
		changeConversation(change) {
			calls.push(["changeConversation", change]);
		},
		loadEarlier() {
			calls.push(["loadEarlier"]);
		},
		forceDrop() {},
		retry() {
			calls.push(["retry"]);
		},
		close() {
			calls.push(["close"]);
		},
	};
	const set = (patch: Partial<WorkspaceChatSnapshot>) => {
		snapshot = { ...snapshot, ...patch };
		for (const listener of listeners) listener();
	};
	const feed = (events: WorkspaceChatLedgerEvent[]) =>
		set({ state: applyWorkspaceChatEvents(snapshot.state, events) });
	const createClient: typeof createWorkspaceChatClient = () => client;
	return { client, calls, set, feed, createClient };
}
