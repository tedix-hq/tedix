import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import type {
	WorkspaceChatClient,
	WorkspaceChatSnapshot,
} from "@/lib/workspace-chat-client";
import type { WorkspaceChatLedgerEvent } from "@/lib/workspace-chat-protocol";
import {
	applyWorkspaceChatEvents,
	initialWorkspaceChatState,
} from "@/lib/workspace-chat-state";
import { WorkspaceChat } from "./workspace-chat";

(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

/** A client whose snapshot the test drives by hand. */
function fakeClient(conversationId: string | null) {
	let snapshot: WorkspaceChatSnapshot = {
		state: initialWorkspaceChatState(conversationId),
		connection: { phase: "open", since: 0 },
		catchingUp: false,
	};
	const listeners = new Set<() => void>();
	const calls: unknown[] = [];
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
		cancelTurn(turnId) {
			calls.push(["cancelTurn", turnId]);
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
	return { client, calls, set, feed };
}

const at = "2026-11-07T12:00:00.000Z";
const started: WorkspaceChatLedgerEvent = {
	seq: 1,
	at,
	conversationId: "c1",
	type: "turn.started",
	turnId: "t1",
	text: "How many challenges are open?",
	authorId: "p",
	authorKind: "person",
};

let host: HTMLDivElement;
let root: Root;
let queryClient: QueryClient;

beforeEach(() => {
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
	queryClient = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
});

afterEach(() => {
	act(() => root.unmount());
	host.remove();
});

function mount(fake: ReturnType<typeof fakeClient>, conversationId = "c1") {
	act(() => {
		root.render(
			<QueryClientProvider client={queryClient}>
				<WorkspaceChat
					conversationId={conversationId}
					createClient={() => fake.client}
					listOpen={false}
					onOpenList={() => {}}
					onSelectConversation={() => {}}
					workspaceId="ws-1"
				/>
			</QueryClientProvider>,
		);
	});
}

describe("WorkspaceChat", () => {
	it("shows the thinking state the moment a turn starts, then streams prose", () => {
		const fake = fakeClient("c1");
		mount(fake);
		act(() => fake.feed([started]));
		expect(
			host.querySelector('[data-testid="workspace-chat-thinking"]'),
		).not.toBeNull();
		expect(host.textContent).toContain("How many challenges are open?");
		act(() =>
			fake.feed([
				{
					seq: 2,
					at,
					conversationId: "c1",
					type: "assistant.delta",
					turnId: "t1",
					messageId: "m1",
					text: "Twelve",
				},
			]),
		);
		expect(
			host.querySelector('[data-testid="workspace-chat-thinking"]'),
		).toBeNull();
		expect(host.querySelector(".workspace-chat-prose")?.textContent).toContain(
			"Twelve",
		);
		expect(
			host.querySelector('[data-testid="workspace-chat-timer"]')?.textContent,
		).toMatch(/Working · \d+/);
	});

	it("lists steps with their plain labels", () => {
		const fake = fakeClient("c1");
		mount(fake);
		act(() =>
			fake.feed([
				started,
				{
					seq: 2,
					at,
					conversationId: "c1",
					type: "step.started",
					turnId: "t1",
					stepId: "s1",
					label: "Reading Challenges sheet",
					kind: "read",
				},
				{
					seq: 3,
					at,
					conversationId: "c1",
					type: "step.finished",
					turnId: "t1",
					stepId: "s1",
					status: "ok",
					summary: "12 rows",
					durationMs: 400,
				},
				{
					seq: 4,
					at,
					conversationId: "c1",
					type: "step.started",
					turnId: "t1",
					stepId: "s2",
					label: "Listing Work",
					kind: "read",
				},
			]),
		);
		const steps = [
			...host.querySelectorAll('[data-testid="workspace-chat-step"]'),
		];
		expect(steps.map((step) => step.getAttribute("data-status"))).toEqual([
			"ok",
			"running",
		]);
		expect(steps[0]?.textContent).toContain("Reading Challenges sheet");
		expect(steps[1]?.textContent).toContain("Listing Work");
	});

	it("keeps the timer running and names the reconnect while the socket is away", () => {
		const fake = fakeClient("c1");
		mount(fake);
		act(() => fake.feed([started]));
		act(() =>
			fake.set({
				connection: { phase: "reconnecting", attempt: 2, nextTryAt: 0 },
			}),
		);
		expect(
			host.querySelector('[data-testid="workspace-chat-connection"]')
				?.textContent,
		).toContain("Reconnecting (2)");
		expect(
			host.querySelector('[data-testid="workspace-chat-timer"]')?.textContent,
		).toContain("reconnecting");
		expect(host.textContent).not.toContain("Live updates paused");
		expect(host.textContent).not.toContain("still being prepared");
	});

	it("says plainly when this origin has no object lane yet, with a retry", () => {
		const fake = fakeClient("c1");
		mount(fake);
		act(() => fake.set({ connection: { phase: "unavailable" } }));
		const notice = host.querySelector(
			'[data-testid="workspace-chat-unavailable"]',
		);
		expect(notice?.textContent).toContain(
			"Workspace chat is being upgraded. Home chat still works.",
		);
		expect(host.querySelector("textarea")?.disabled).toBe(true);
		expect(host.querySelector(".workspace-chat-thinking")).toBeNull();
		const retry = [...(notice?.querySelectorAll("button") ?? [])].find(
			(button) => button.textContent === "Retry",
		);
		act(() => retry?.click());
		expect(fake.calls).toContainEqual(["retry"]);
	});

	it("renders an approval inline, blocks the composer and posts the decision", () => {
		const fake = fakeClient("c1");
		mount(fake);
		act(() =>
			fake.feed([
				started,
				{
					seq: 2,
					at,
					conversationId: "c1",
					type: "approval.requested",
					turnId: "t1",
					stepId: "s1",
					approvalId: "a1",
					title: "Write to the Challenges sheet",
					reason: "Policy requires a person.",
					policy: "compliance:needs_approval",
				},
			]),
		);
		const card = host.querySelector('[data-testid="workspace-chat-approval"]');
		expect(card?.textContent).toContain("Write to the Challenges sheet");
		const textarea = host.querySelector("textarea");
		expect(textarea?.disabled).toBe(true);
		expect(textarea?.placeholder).toContain("Approve or deny");
		const approve = [...(card?.querySelectorAll("button") ?? [])].find(
			(button) => button.textContent === "Approve",
		);
		act(() => approve?.click());
		expect(fake.calls).toContainEqual(["decideApproval", "a1", "approve"]);
		act(() =>
			fake.feed([
				{
					seq: 3,
					at,
					conversationId: "c1",
					type: "approval.decided",
					approvalId: "a1",
					decision: "approve",
					by: "person:aaron",
				},
			]),
		);
		expect(card?.textContent).toContain("Approved by person:aaron");
		expect(host.querySelector("textarea")?.disabled).toBe(false);
	});

	it("shows the settled footer with duration and usage", () => {
		const fake = fakeClient("c1");
		mount(fake);
		act(() =>
			fake.feed([
				started,
				{
					seq: 2,
					at,
					conversationId: "c1",
					type: "assistant.done",
					turnId: "t1",
					messageId: "m1",
					text: "Twelve.",
					usage: { inputTokens: 2000, outputTokens: 500, costCents: 2 },
					model: "mock",
				},
				{
					seq: 3,
					at,
					conversationId: "c1",
					type: "turn.finished",
					turnId: "t1",
					status: "done",
					durationMs: 4200,
				},
			]),
		);
		const footer = host.querySelector(".workspace-chat-turn-footer");
		expect(footer?.textContent).toBe("4s · 2,500 tokens · €0.020 · mock");
	});

	it("sends the composer's text to the object", () => {
		const fake = fakeClient("c1");
		mount(fake);
		const form = host.querySelector("form");
		const textarea = host.querySelector("textarea");
		act(() => {
			const setter = Object.getOwnPropertyDescriptor(
				HTMLTextAreaElement.prototype,
				"value",
			)?.set;
			setter?.call(textarea, "Count them");
			textarea?.dispatchEvent(new Event("input", { bubbles: true }));
		});
		act(() => {
			form?.dispatchEvent(
				new Event("submit", { bubbles: true, cancelable: true }),
			);
		});
		expect(fake.calls).toContainEqual(["sendTurn", { text: "Count them" }]);
	});
});
