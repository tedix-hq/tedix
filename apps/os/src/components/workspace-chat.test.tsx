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
import { WorkspaceChat } from "./workspace-chat";
import { osQueryKeys } from "@/lib/os-query-options";

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
	let onOutputChanged: (() => void) | undefined;
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
	const createClient: typeof createWorkspaceChatClient = (options) => {
		onOutputChanged = options.onOutputChanged;
		return client;
	};
	return {
		client,
		calls,
		set,
		feed,
		createClient,
		notifyOutputs: () => onOutputChanged?.(),
	};
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

function heldChange(input: unknown): WorkspaceChatLedgerEvent[] {
	return [
		started,
		{
			type: "step.started",
			seq: 2,
			at,
			conversationId: "c1",
			turnId: "t1",
			stepId: "code",
			label: "Running code",
			kind: "code",
			tool: "run_code",
		},
		{
			type: "step.started",
			seq: 3,
			at,
			conversationId: "c1",
			turnId: "t1",
			stepId: "write",
			label: "Edit document",
			kind: "write",
			tool: "documents.edit",
		},
		{
			type: "approval.requested",
			seq: 4,
			at,
			conversationId: "c1",
			turnId: "t1",
			stepId: "write",
			approvalId: "approval",
			title: "Edit document",
			reason: "approval_pending",
			policy: "writes_need_approval",
			input,
			target: { id: "opaque-document-id", title: "Meeting notes" },
		},
		{
			type: "step.finished",
			seq: 5,
			at,
			conversationId: "c1",
			turnId: "t1",
			stepId: "write",
			status: "error",
			durationMs: 1,
			error: "Approval required: approval_pending",
		},
		{
			type: "step.finished",
			seq: 6,
			at,
			conversationId: "c1",
			turnId: "t1",
			stepId: "code",
			status: "error",
			durationMs: 1,
			error: "Approval required: approval_pending",
		},
		{
			type: "turn.finished",
			seq: 7,
			at,
			conversationId: "c1",
			turnId: "t1",
			status: "done",
			durationMs: 1,
		},
	];
}

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

function mount(
	fake: ReturnType<typeof fakeClient>,
	conversationId = "c1",
	listOpen = false,
) {
	act(() => {
		root.render(
			<QueryClientProvider client={queryClient}>
				<WorkspaceChat
					conversationId={conversationId}
					createClient={fake.createClient}
					listOpen={listOpen}
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
		expect(
			card?.querySelector('[data-testid="workspace-chat-approval-status"]')
				?.textContent,
		).toBe("Approved");
		expect(card?.textContent).not.toContain("person:aaron");
		expect(card?.textContent).not.toContain("Applied");
		expect(host.querySelector("textarea")?.disabled).toBe(false);
	});

	it("labels a paged approval hold plainly before its request arrives", () => {
		const fake = fakeClient("c1");
		mount(fake);
		act(() =>
			fake.feed(
				heldChange({}).filter((event) => event.type !== "approval.requested"),
			),
		);
		act(() =>
			host
				.querySelector<HTMLButtonElement>(".workspace-chat-activity-summary")
				?.click(),
		);
		expect(
			host.querySelector(".workspace-chat-activity")?.textContent,
		).toContain("Waiting for approval");
		expect(
			host.querySelector(".workspace-chat-activity")?.textContent,
		).not.toContain("approval_pending");
		expect(
			host.querySelector(".workspace-chat-activity")?.textContent,
		).not.toContain("Failed");
	});

	it.each([
		{
			input: {
				ops: [
					{
						op: "replace",
						index: 0,
						slide: {
							title: "Pilot launch",
							bullets: ["Review costs"],
							notes: "Speaker note",
						},
					},
				],
			},
			text: "Replace a slide at position 1: Pilot launch\nReview costs\nSpeaker note",
		},
		{
			input: { ops: [{ op: "move", from: 2, to: 0 }] },
			text: "Move slide 3 to position 1",
		},
		{
			input: { startRow: 2, startColumn: 1, cells: [["Marker", 42]] },
			text: "Edit cells at row 3, column 2:\nMarker · 42",
		},
	])(
		"previews office edits before a person decides: $text",
		({ input, text }) => {
			const fake = fakeClient("c1");
			mount(fake);
			act(() => fake.feed(heldChange(input)));
			expect(
				host.querySelector('[data-testid="workspace-chat-approval"]')
					?.textContent,
			).toContain(text);
			expect(fake.calls).not.toContainEqual([
				"decideApproval",
				"approval",
				"approve",
			]);
		},
	);

	it("previews the document change and hides exact input and policy behind Technical details", () => {
		const fake = fakeClient("c1");
		mount(fake);
		act(() =>
			fake.feed(
				heldChange({
					outputId: "opaque-document-id",
					expectedRevision: 3,
					ops: [
						{
							op: "insert",
							index: 1,
							block: { type: "paragraph", text: "Discuss the launch" },
						},
						{ op: "delete", index: 2 },
					],
				}),
			),
		);
		const card = host.querySelector('[data-testid="workspace-chat-approval"]');
		expect(card?.textContent).toContain("Meeting notes");
		expect(card?.textContent).toContain(
			"Insert a block at position 2: Discuss the launch",
		);
		expect(card?.textContent).toContain("Delete a block at position 3");
		expect(card?.textContent).not.toContain("opaque-document-id");
		expect(card?.textContent).not.toContain("writes_need_approval");
		expect(
			host.querySelector(".workspace-chat-activity")?.textContent,
		).toContain("Waiting for approval");
		expect(
			host.querySelector(".workspace-chat-activity")?.textContent,
		).not.toContain("Error");
		act(() =>
			host
				.querySelector<HTMLButtonElement>(".workspace-chat-activity-summary")
				?.click(),
		);
		expect(
			host.querySelector(".workspace-chat-steps")?.textContent,
		).not.toContain("approval_pending");
		const details = [...(card?.querySelectorAll("button") ?? [])].find(
			(button) => button.textContent === "Technical details",
		);
		expect(details?.getAttribute("aria-expanded")).toBe("false");
		act(() => details?.click());
		expect(card?.textContent).toContain("opaque-document-id");
		expect(card?.textContent).toContain('"expectedRevision": 3');
		expect(card?.textContent).toContain("writes_need_approval");
	});

	it.each(["applied", "failed"] as const)(
		"shows the actual %s outcome separately from human approval",
		(status) => {
			const fake = fakeClient("c1");
			mount(fake);
			act(() =>
				fake.feed([
					...heldChange({
						outputId: "opaque-document-id",
						content: {
							kind: "document",
							blocks: [{ type: "paragraph", text: "Updated notes" }],
						},
					}),
					{
						type: "approval.decided",
						seq: 8,
						at,
						conversationId: "c1",
						approvalId: "approval",
						decision: "approve",
						by: "user-private-id",
					},
				]),
			);
			const card = host.querySelector(
				'[data-testid="workspace-chat-approval"]',
			);
			expect(card?.textContent).toContain("Updated notes");
			expect(
				card?.querySelector('[data-testid="workspace-chat-approval-status"]')
					?.textContent,
			).toBe("Approved");
			expect(card?.textContent).not.toContain("Applied");
			act(() =>
				fake.feed([
					{
						type: "approval.executed",
						seq: 9,
						at,
						conversationId: "c1",
						approvalId: "approval",
						status,
						...(status === "failed" ? { error: "revision_conflict" } : {}),
					},
				]),
			);
			expect(
				card?.querySelector('[data-testid="workspace-chat-approval-status"]')
					?.textContent,
			).toBe(status === "applied" ? "Applied" : "Failed");
			expect(card?.textContent).not.toContain("user-private-id");
			expect(
				host.querySelector(".workspace-chat-activity")?.textContent,
			).toContain(status === "applied" ? "Applied" : "Failed");
			if (status === "failed")
				expect(card?.textContent).not.toContain(
					"The workspace applied this change.",
				);
		},
	);

	it("does not offer another decision when replay supplies an execution outcome first", () => {
		const fake = fakeClient("c1");
		mount(fake);
		act(() =>
			fake.feed([
				...heldChange({ outputId: "opaque-document-id" }),
				{
					type: "approval.executed",
					seq: 9,
					at,
					conversationId: "c1",
					approvalId: "approval",
					status: "applied",
				},
			]),
		);
		const card = host.querySelector('[data-testid="workspace-chat-approval"]');
		expect(
			card?.querySelector('[data-testid="workspace-chat-approval-status"]')
				?.textContent,
		).toBe("Applied");
		expect(
			[...(card?.querySelectorAll("button") ?? [])].some(
				(button) =>
					button.textContent === "Approve" || button.textContent === "Deny",
			),
		).toBe(false);
	});

	it("posts a denial without presenting the held action as applied", () => {
		const fake = fakeClient("c1");
		mount(fake);
		act(() => fake.feed(heldChange({ outputId: "opaque-document-id" })));
		const card = host.querySelector('[data-testid="workspace-chat-approval"]');
		const deny = [...(card?.querySelectorAll("button") ?? [])].find(
			(button) => button.textContent === "Deny",
		);
		act(() => deny?.click());
		expect(fake.calls).toContainEqual(["decideApproval", "approval", "deny"]);
		act(() =>
			fake.feed([
				{
					type: "approval.decided",
					seq: 8,
					at,
					conversationId: "c1",
					approvalId: "approval",
					decision: "deny",
					by: "person",
				},
			]),
		);
		expect(
			card?.querySelector('[data-testid="workspace-chat-approval-status"]')
				?.textContent,
		).toBe("Denied");
		expect(card?.textContent).not.toContain("Applied");
	});

	it("invalidates the generated output query family after a successful write notification", () => {
		const fake = fakeClient("c1");
		const invalidate = vi.spyOn(queryClient, "invalidateQueries");
		mount(fake);
		act(() => fake.notifyOutputs());
		expect(invalidate).toHaveBeenCalledWith({
			queryKey: osQueryKeys.outputs(),
		});
	});

	it("sends from the conversation list as a new conversation", () => {
		const fake = fakeClient("c1");
		mount(fake, "c1", true);
		const textarea = host.querySelector("textarea");
		act(() => {
			Object.getOwnPropertyDescriptor(
				HTMLTextAreaElement.prototype,
				"value",
			)?.set?.call(textarea, "New topic");
			textarea?.dispatchEvent(new Event("input", { bubbles: true }));
		});
		act(() =>
			host
				.querySelector("form")
				?.dispatchEvent(
					new Event("submit", { bubbles: true, cancelable: true }),
				),
		);
		expect(fake.calls).toContainEqual([
			"sendTurn",
			{ text: "New topic", newConversation: true },
		]);
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
