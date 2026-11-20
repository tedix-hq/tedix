import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vite-plus/test";
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

vi.mock("@/lib/workspace-chat-notify", async (original) => ({
	...(await original<typeof import("@/lib/workspace-chat-notify")>()),
	notifyChatPosted: vi.fn(),
}));
vi.mock("@/lib/use-chat-model-preference", async (original) => ({
	...(await original<typeof import("@/lib/use-chat-model-preference")>()),
	useChatModelPreference: () => ({
		modelRef: null,
		settled: true,
		save: () => {},
	}),
}));
import { WorkspaceChat } from "./workspace-chat";

(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

/** A client whose snapshot the test drives by hand. */
function fakeClient(conversationId: string) {
	let snapshot: WorkspaceChatSnapshot = {
		state: initialWorkspaceChatState(conversationId),
		connection: { phase: "open", since: 0 },
		catchingUp: false,
	};
	const listeners = new Set<() => void>();
	const calls: unknown[][] = [];
	let sends = 0;
	const client: WorkspaceChatClient = {
		getSnapshot: () => snapshot,
		getConversationId: () => snapshot.state.conversationId,
		subscribe(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		sendTurn(input) {
			sends += 1;
			calls.push(["sendTurn", input.text]);
			return `sent-${sends}`;
		},
		decideApproval() {},
		setApprovalMode() {},
		dismissApprovalNotice() {},
		decideApprovals() {},
		cancelTurn(turnId) {
			calls.push(["cancelTurn", turnId]);
		},
		changeConversation(change) {
			calls.push(["changeConversation", change]);
		},
		loadEarlier() {},
		forceDrop() {},
		retry() {},
		close() {},
	};
	const feed = (events: WorkspaceChatLedgerEvent[]) => {
		snapshot = {
			...snapshot,
			state: applyWorkspaceChatEvents(snapshot.state, events),
		};
		for (const listener of listeners) listener();
	};
	const createClient: typeof createWorkspaceChatClient = () => client;
	return { calls, feed, createClient };
}

const at = (seconds: number) =>
	new Date(Date.UTC(2026, 10, 18, 12, 0, seconds)).toISOString();
const started: WorkspaceChatLedgerEvent = {
	seq: 1,
	at: at(0),
	conversationId: "c1",
	type: "turn.started",
	turnId: "t1",
	text: "Total the invoices",
	authorId: "p",
	authorKind: "person",
};
const message = (
	type: "message.queued" | "message.read" | "message.returned",
	seq: number,
	messageId: string,
	text: string,
): WorkspaceChatLedgerEvent => ({
	seq,
	at: at(seq),
	conversationId: "c1",
	type,
	turnId: "t1",
	messageId,
	text,
	authorId: "p",
	authorKind: "person",
});
const stoppedTurn: WorkspaceChatLedgerEvent = {
	seq: 90,
	at: at(50),
	conversationId: "c1",
	type: "turn.finished",
	turnId: "t1",
	status: "cancelled",
	durationMs: 1000,
};

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
	window.sessionStorage.clear();
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
});

afterEach(() => {
	act(() => root.unmount());
	host.remove();
});

function mount(fake: ReturnType<typeof fakeClient>) {
	const queryClient = new QueryClient({
		defaultOptions: { queries: { retry: false, staleTime: Infinity } },
	});
	act(() => {
		root.render(
			<QueryClientProvider client={queryClient}>
				<WorkspaceChat
					conversationId="c1"
					createClient={fake.createClient}
					listOpen={false}
					onOpenList={() => {}}
					onSelectConversation={() => {}}
					workspaceId="ws-1"
				/>
			</QueryClientProvider>,
		);
	});
}

const textarea = () => host.querySelector("textarea")!;
function type(text: string) {
	act(() => {
		Object.getOwnPropertyDescriptor(
			HTMLTextAreaElement.prototype,
			"value",
		)!.set!.call(textarea(), text);
		textarea().dispatchEvent(new Event("input", { bubbles: true }));
	});
}
const button = (name: string) =>
	host.querySelector<HTMLButtonElement>(`button[aria-label="${name}"]`);
const queuedRows = () =>
	[
		...host.querySelectorAll('[data-testid="workspace-chat-queued-message"]'),
	].map((row) => row.textContent);

describe("messages sent while the agent works", () => {
	it("shows a sent message dimmed with Not read yet until the agent reads it", () => {
		const fake = fakeClient("c1");
		mount(fake);
		act(() => fake.feed([started]));
		type("Use euros, not dollars");
		act(() => button("Send")!.click());
		expect(fake.calls).toEqual([["sendTurn", "Use euros, not dollars"]]);

		act(() =>
			fake.feed([
				message("message.queued", 2, "sent-1", "Use euros, not dollars"),
			]),
		);
		expect(queuedRows()).toEqual([
			"WMWorkspace memberUse euros, not dollarsNot read yet",
		]);
		expect(
			host
				.querySelector(".workspace-chat-queued-text")
				?.textContent?.includes("Use euros"),
		).toBe(true);
		// It is with the agent now, so the composer is free for the next one.
		expect(textarea().value).toBe("");
		// One turn: the message did not start a second one.
		expect(
			host.querySelectorAll('[data-testid="workspace-chat-turn"]'),
		).toHaveLength(1);

		act(() =>
			fake.feed([
				message("message.read", 3, "sent-1", "Use euros, not dollars"),
			]),
		);
		expect(queuedRows()).toEqual([]);
		expect(host.textContent).not.toContain("Not read yet");
		const turn = host.querySelector('[data-testid="workspace-chat-turn"]')!;
		expect(
			turn.querySelector('[data-testid="workspace-chat-added-message"]')
				?.textContent,
		).toBe("WMWorkspace memberUse euros, not dollars");
	});

	it("keeps Stop next to Send while a turn runs, also with text typed", () => {
		const fake = fakeClient("c1");
		mount(fake);
		expect(button("Stop")).toBeNull();
		expect(button("Send")).not.toBeNull();

		act(() => fake.feed([started]));
		expect(button("Stop")).not.toBeNull();
		expect(button("Send")!.disabled).toBe(true);

		type("Also count the closed ones");
		expect(button("Stop")).not.toBeNull();
		expect(button("Send")!.disabled).toBe(false);
		expect(button("Stop")!.parentElement).toBe(button("Send")!.parentElement);

		act(() => button("Stop")!.click());
		expect(fake.calls).toEqual([["cancelTurn", "t1"]]);
		act(() => fake.feed([stoppedTurn]));
		expect(button("Stop")).toBeNull();
		// Nothing was waiting unread, so the draft is as the person left it.
		expect(textarea().value).toBe("Also count the closed ones");
	});

	it("Stop puts unread messages back into the composer, ahead of the draft", () => {
		const fake = fakeClient("c1");
		mount(fake);
		act(() => fake.feed([started]));
		type("Use euros");
		act(() => button("Send")!.click());
		act(() => fake.feed([message("message.queued", 2, "sent-1", "Use euros")]));
		type("And round to cents");
		act(() => button("Send")!.click());
		act(() =>
			fake.feed([message("message.queued", 3, "sent-2", "And round to cents")]),
		);
		// The agent read the first one before Stop; only the second comes back.
		act(() => fake.feed([message("message.read", 4, "sent-1", "Use euros")]));
		type("One more thing");

		act(() => button("Stop")!.click());
		expect(fake.calls.at(-1)).toEqual(["cancelTurn", "t1"]);
		act(() =>
			fake.feed([
				message("message.returned", 5, "sent-2", "And round to cents"),
				stoppedTurn,
			]),
		);
		expect(textarea().value).toBe("And round to cents\n\nOne more thing");
		expect(queuedRows()).toEqual([]);
		expect(host.textContent).not.toContain("Not read yet");
		expect(
			window.sessionStorage.getItem("tedix.workspace-chat.draft.ws-1.c1"),
		).toBe("And round to cents\n\nOne more thing");
	});

	it("leaves a message handed back earlier or elsewhere out of the composer", () => {
		const fake = fakeClient("c1");
		mount(fake);
		// History: someone else's Stop, in another tab, before this one opened.
		act(() =>
			fake.feed([
				started,
				message("message.queued", 2, "elsewhere", "Sent from the phone"),
				message("message.returned", 3, "elsewhere", "Sent from the phone"),
				stoppedTurn,
			]),
		);
		expect(textarea().value).toBe("");
		expect(queuedRows()).toEqual([]);
	});
});
