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
	waitingForDecision,
	initialWorkspaceChatState,
} from "@/lib/workspace-chat-state";
const notifyChatPosted = vi.hoisted(() => vi.fn());
const uploadWorkspaceFile = vi.hoisted(() => vi.fn());
vi.mock("@/lib/workspace-file-upload", async (original) => ({
	...(await original<typeof import("@/lib/workspace-file-upload")>()),
	uploadWorkspaceFile,
}));
vi.mock("@/lib/workspace-chat-notify", async (original) => ({
	...(await original<typeof import("@/lib/workspace-chat-notify")>()),
	notifyChatPosted,
}));
vi.mock("@/lib/use-chat-model-preference", async (original) => ({
	...(await original<typeof import("@/lib/use-chat-model-preference")>()),
	// Covered in workspace-chat-model.test.tsx; these tests make no request.
	useChatModelPreference: () => ({
		modelRef: null,
		settled: true,
		save: () => {},
	}),
}));
import { WorkspaceChat } from "./workspace-chat";
import {
	osQuery,
	osQueryKeys,
	billingOverviewQueryOptions,
	canvasOutputsQueryOptions,
	operationalContextQueryOptions,
	workspaceConversationChargesQueryOptions,
	SKILL_CATALOG_LIMIT,
	skillCatalogQueryOptions,
	tediDetailQueryOptions,
	tediNamesQueryOptions,
	tediRosterQueryOptions,
	workspaceDetailQueryOptions,
} from "@/lib/os-query-options";

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
		dismissApprovalNotice() {},
		setApprovalMode() {},
		decideApprovals(approvalIds, decision) {
			calls.push(["decideApprovals", approvalIds, decision]);
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
		defaultOptions: { queries: { retry: false, staleTime: Infinity } },
	});
	queryClient.setQueryData<unknown>(operationalContextQueryOptions().queryKey, {
		authority: { permissions: [] },
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
	onBrowseResources?: () => void,
) {
	act(() => {
		root.render(
			<QueryClientProvider client={queryClient}>
				<WorkspaceChat
					conversationId={conversationId}
					createClient={fake.createClient}
					listOpen={listOpen}
					onBrowseResources={onBrowseResources}
					onOpenList={() => {}}
					onSelectConversation={() => {}}
					workspaceId="ws-1"
				/>
			</QueryClientProvider>,
		);
	});
}

describe("WorkspaceChat", () => {
	it.each(["Enter", "Tab"])(
		"picks a highlighted tedi with %s without sending",
		async (key) => {
			queryClient.setQueryData<unknown>(
				tediRosterQueryOptions(100, { status: "active" }).queryKey,
				{
					data: ["CEO", "CFO"].map((name) => ({
						id: `tedi-${name.toLowerCase()}`,
						name,
						scope: "organization",
						status: "active",
					})),
				},
			);
			const fake = fakeClient("c1");
			mount(fake);
			const textarea = host.querySelector("textarea")!;
			const type = async (value: string) =>
				act(async () => {
					Object.getOwnPropertyDescriptor(
						HTMLTextAreaElement.prototype,
						"value",
					)!.set!.call(textarea, value);
					textarea.dispatchEvent(new Event("input", { bubbles: true }));
				});
			const press = async (key: string, extra: KeyboardEventInit = {}) => {
				const event = new KeyboardEvent("keydown", {
					key,
					bubbles: true,
					cancelable: true,
					...extra,
				});
				await act(async () => {
					textarea.dispatchEvent(event);
				});
				return event;
			};
			const highlighted = () =>
				host.querySelector(
					'[aria-label="Mention a tedi"] [aria-pressed="true"]',
				)?.textContent;
			await type("Ask @C");
			expect(highlighted()).toBe("CEO");
			await press("ArrowUp");
			expect(highlighted()).toBe("CFO");
			await press("ArrowDown");
			expect(highlighted()).toBe("CEO");
			await press("ArrowRight");
			expect(highlighted()).toBe("CFO");
			await press("ArrowLeft");
			expect(highlighted()).toBe("CEO");
			await press("ArrowDown");
			expect((await press(key)).defaultPrevented).toBe(true);
			expect(textarea.value).toBe("Ask @CFO ");
			expect(fake.calls).not.toContainEqual(["sendTurn", expect.anything()]);
			await type("Ask @CF");
			expect(highlighted()).toBe("CFO");
			expect(
				(await press("Enter", { isComposing: true })).defaultPrevented,
			).toBe(false);
			expect((await press("Enter", { shiftKey: true })).defaultPrevented).toBe(
				false,
			);
			expect(textarea.value).toBe("Ask @CF");
			expect((await press(key)).defaultPrevented).toBe(true);
			expect(textarea.value).toBe("Ask @CFO ");
			expect(
				host.querySelector('[aria-label="Replying agent"]')?.textContent,
			).toBe("CFO");
			expect(fake.calls).not.toContainEqual(["sendTurn", expect.anything()]);
			await press("Enter");
			expect(fake.calls).toContainEqual([
				"sendTurn",
				{ text: "Ask @CFO", tediId: "tedi-cfo" },
			]);
		},
	);

	it("offers organization skills for a slash and sends the picked reference", async () => {
		queryClient.setQueryData<unknown>(
			skillCatalogQueryOptions({
				limit: SKILL_CATALOG_LIMIT,
				excludeArchived: true,
				excludeImprovements: true,
			}).queryKey,
			{
				entries: [
					{
						id: "s1",
						slug: "weekly-report",
						title: "Weekly report",
						summary: "Write the weekly report",
						description: "",
						visibility: "organization",
						tediId: null,
						lifecycleState: "active",
					},
				],
			},
		);
		const fake = fakeClient("c1");
		mount(fake);
		const textarea = host.querySelector("textarea")!;
		const type = async (value: string) =>
			act(async () => {
				Object.getOwnPropertyDescriptor(
					HTMLTextAreaElement.prototype,
					"value",
				)!.set!.call(textarea, value);
				textarea.dispatchEvent(new Event("input", { bubbles: true }));
			});
		await type("/week");
		const picker = host.querySelector('[data-slot="skill-picker"]');
		expect(picker?.textContent).toContain("Weekly report");
		await act(async () =>
			[...picker!.querySelectorAll("[role=option]")]
				.find((option) => option.textContent?.includes("Weekly report"))
				?.dispatchEvent(new MouseEvent("click", { bubbles: true })),
		);
		expect(
			host.querySelector('[data-slot="skill-pills"]')?.textContent,
		).toContain("Weekly report");
		await type(`${textarea.value}Summarize last week`);
		await act(async () =>
			host
				.querySelector("form")
				?.dispatchEvent(
					new Event("submit", { bubbles: true, cancelable: true }),
				),
		);
		const sent = (fake.calls as unknown[][]).find(
			(call) => call[0] === "sendTurn",
		)?.[1] as { text: string };
		expect(sent.text).toContain("/skill weekly-report");
		expect(sent.text).toContain("Summarize last week");
	});

	it.each([false, true])(
		"sends selected native files from the composer (list=%s)",
		async (listOpen) => {
			queryClient.setQueryData<unknown>(
				canvasOutputsQueryOptions("ws-1").queryKey,
				{
					items: [{ id: "doc-1", title: "Budget notes", status: "active" }],
					truncated: false,
				},
			);
			const fake = fakeClient("c1");
			mount(fake, "c1", listOpen, () => {});
			await act(async () =>
				host
					.querySelector<HTMLButtonElement>('[aria-label="Add files"]')
					?.click(),
			);
			const file = [...document.querySelectorAll("button")].find(
				(button) => button.textContent === "Budget notes",
			);
			expect(file).toBeDefined();
			await act(async () => file?.click());
			expect(
				host.querySelector('[aria-label="Files added to this message"]')
					?.textContent,
			).toContain("Budget notes");
			await act(async () =>
				host
					.querySelector<HTMLButtonElement>(
						'[aria-label="Remove Budget notes"]',
					)
					?.click(),
			);
			expect(
				host.querySelector('[aria-label="Files added to this message"]'),
			).toBeNull();
			await act(async () =>
				host
					.querySelector<HTMLButtonElement>('[aria-label="Add files"]')
					?.click(),
			);
			await act(async () =>
				[...document.querySelectorAll("button")]
					.find((button) => button.textContent === "Budget notes")
					?.click(),
			);
			const textarea = host.querySelector("textarea")!;
			await act(async () => {
				Object.getOwnPropertyDescriptor(
					HTMLTextAreaElement.prototype,
					"value",
				)!.set!.call(textarea, "Summarize this");
				textarea.dispatchEvent(new Event("input", { bubbles: true }));
			});
			await act(async () =>
				host
					.querySelector("form")
					?.dispatchEvent(
						new Event("submit", { bubbles: true, cancelable: true }),
					),
			);
			expect(fake.calls).toContainEqual([
				"sendTurn",
				{
					text: "Summarize this",
					attachments: [{ outputId: "doc-1" }],
					...(listOpen ? { newConversation: true } : {}),
				},
			]);
			expect(
				host.querySelector<HTMLButtonElement>('[aria-label="Send"]')!.disabled,
			).toBe(true);
			if (listOpen) mount(fake, "c1", false, () => {});
			expect(textarea.value).toBe("Summarize this");
			act(() =>
				fake.set({
					state: {
						...fake.client.getSnapshot().state,
						lastError: {
							code: "failed",
							message: "Remove the unavailable file",
							clientTurnId: "client-turn",
						},
					},
				}),
			);
			// The button is rendered anew when it becomes available again.
			expect(
				host.querySelector<HTMLButtonElement>('[aria-label="Send"]')?.disabled,
			).toBe(false);
			expect(textarea.value).toBe("Summarize this");
			expect(
				host.querySelector('[aria-label="Remove Budget notes"]'),
			).not.toBeNull();
			// A newer draft must survive acceptance of the previous submission.
			act(() =>
				fake.set({
					state: { ...fake.client.getSnapshot().state, lastError: null },
				}),
			);
			await act(async () =>
				host
					.querySelector("form")
					?.dispatchEvent(
						new Event("submit", { bubbles: true, cancelable: true }),
					),
			);
			await act(async () => {
				Object.getOwnPropertyDescriptor(
					HTMLTextAreaElement.prototype,
					"value",
				)!.set!.call(textarea, "My next question");
				textarea.dispatchEvent(new Event("input", { bubbles: true }));
			});
			act(() => fake.feed([{ ...started, turnId: "client-turn" }]));
			expect(textarea.value).toBe("My next question");
			expect(
				host.querySelector('[aria-label="Files added to this message"]'),
			).toBeNull();
			expect(
				host.querySelector<HTMLButtonElement>('[aria-label="Send"]')!.disabled,
			).toBe(false);
		},
	);

	it("returns typing to the message box after a file is picked or uploaded", async () => {
		queryClient.setQueryData<unknown>(
			canvasOutputsQueryOptions("ws-1").queryKey,
			{
				items: [{ id: "doc-1", title: "Budget notes", status: "active" }],
				truncated: false,
			},
		);
		uploadWorkspaceFile.mockResolvedValue({
			outputId: "upload-1",
			resource: { name: "sales.csv" },
		});
		mount(fakeClient("c1"), "c1", false, () => {});
		const textarea = host.querySelector("textarea")!;
		const settle = () =>
			act(async () => new Promise((resolve) => setTimeout(resolve, 50)));
		const openPanel = () =>
			act(async () =>
				host
					.querySelector<HTMLButtonElement>('[aria-label="Add files"]')
					?.click(),
			);
		const panelOpen = () =>
			document.body.textContent?.includes("Add to your message") ?? false;

		await openPanel();
		await act(async () =>
			[...document.querySelectorAll("button")]
				.find((button) => button.textContent === "Budget notes")
				?.click(),
		);
		await settle();
		expect(panelOpen()).toBe(false);
		expect(document.activeElement).toBe(textarea);

		await openPanel();
		const picker = document.querySelector<HTMLInputElement>(
			'input[aria-label="Choose files from your computer"]',
		)!;
		Object.defineProperty(picker, "files", {
			configurable: true,
			value: [new File(["Item,Amount\nPaper,345\n"], "sales.csv")],
		});
		await act(async () =>
			picker.dispatchEvent(new Event("change", { bubbles: true })),
		);
		await settle();
		expect(panelOpen()).toBe(false);
		expect(
			host.querySelector('[aria-label="Files added to this message"]')
				?.textContent,
		).toContain("sales.csv");
		expect(document.activeElement).toBe(textarea);
	});

	it("replays attachment titles and revision links beside the original message", () => {
		const fake = fakeClient("c1");
		mount(fake);
		act(() =>
			fake.feed([
				{
					...started,
					attachments: [
						{
							outputId: "doc-1",
							title: "Budget notes",
							revision: 3,
							revisionId: "r3",
						},
					],
				},
			]),
		);
		expect(
			host.querySelector('[aria-label="Message files"]')?.textContent,
		).toContain("Budget notes · Revision 3");
		expect(host.querySelector('a[href="/outputs/doc-1"]')).not.toBeNull();
	});
	it("previews an uploaded picture beside the message and leaves documents as links", () => {
		for (const [id, mimeType] of [
			["photo-1", "image/jpeg"],
			["doc-1", "application/pdf"],
		] as const)
			queryClient.setQueryData<unknown>(
				osQuery.osWorkspaces.resources.get.queryOptions({
					input: { workspaceId: "ws-1", resourceId: id },
				}).queryKey,
				{ resource: { id, resourceType: "file", metadata: { mimeType } } },
			);
		queryClient.setQueryData<unknown>(
			osQuery.osWorkspaces.resources.getFile.queryOptions({
				input: { workspaceId: "ws-1", resourceId: "photo-1" },
			}).queryKey,
			{
				filename: "photo.jpg",
				mimeType: "image/jpeg",
				size: 834,
				url: "/api/workspace-files/org/ws-1/photo-1/media?sig=s",
				expiresAt: "2026-11-15T00:05:00.000Z",
			},
		);
		const fake = fakeClient("c1");
		mount(fake);
		act(() =>
			fake.feed([
				{
					...started,
					attachments: [
						{
							outputId: "photo-1",
							title: "photo.jpg",
							revision: 1,
							revisionId: "p1",
						},
						{
							outputId: "doc-1",
							title: "Budget notes",
							revision: 3,
							revisionId: "r3",
						},
					],
				},
			]),
		);
		const previews = host.querySelectorAll<HTMLImageElement>(
			'[aria-label="Message files"] [data-testid="chat-image-preview"]',
		);
		expect(previews).toHaveLength(1);
		expect(previews[0]!.alt).toBe("photo.jpg");
		expect(previews[0]!.getAttribute("src")).toBe(
			"/api/workspace-files/org/ws-1/photo-1/media?sig=s",
		);
		expect(host.querySelector('a[href="/outputs/photo-1"]')).not.toBeNull();
	});
	it("opens workspace resources from both the thread and conversation list", async () => {
		const browse = vi.fn();
		const fake = fakeClient("c1");
		mount(fake, "c1", false, browse);
		const trigger = host.querySelector<HTMLButtonElement>(
			'[aria-label="Add files"]',
		);
		expect(trigger).not.toBeNull();
		await act(async () => trigger?.click());
		expect(document.body.textContent).toContain("Add to your message");
		const browseButton = [...document.querySelectorAll("button")].find(
			(button) => button.textContent === "Browse all files",
		);
		await act(async () => browseButton?.click());
		expect(browse).toHaveBeenCalledOnce();
		mount(fake, "c1", true, browse);
		expect(host.querySelector('[aria-label="Add files"]')).not.toBeNull();
	});
	it("shows one working sign the moment a turn starts, then streams prose", () => {
		const fake = fakeClient("c1");
		mount(fake);
		act(() => fake.feed([started]));
		const working = () =>
			host.querySelector('[data-testid="workspace-chat-working"]')?.textContent;
		expect(working()).toMatch(/^Working · (\d+m )?\d+s$/);
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
		expect(host.querySelector(".workspace-chat-prose")?.textContent).toContain(
			"Twelve",
		);
		expect(
			host.querySelectorAll('[data-testid="workspace-chat-working"]'),
		).toHaveLength(1);
		expect(working()).toMatch(/^Working · (\d+m )?\d+s$/);
	});

	it("shows Stop beside Send while a turn runs, and takes it away when it ends", () => {
		const fake = fakeClient("c1");
		mount(fake);
		expect(host.querySelector('[aria-label="Stop"]')).toBeNull();
		act(() => fake.feed([started]));
		expect(host.querySelector('[aria-label="Send"]')).not.toBeNull();
		expect(host.querySelectorAll('[aria-label="Stop"]').length).toBe(1);
		expect(host.querySelector(".workspace-chat-turn-footer button")).toBeNull();
		act(() =>
			host.querySelector<HTMLButtonElement>('[aria-label="Stop"]')!.click(),
		);
		expect(fake.calls).toContainEqual(["cancelTurn", "t1"]);
		expect(
			fake.calls.some((call) => (call as unknown[])[0] === "sendTurn"),
		).toBe(false);

		// Text typed while the turn runs can still be sent with the button.
		const textarea = host.querySelector("textarea")!;
		act(() => {
			Object.getOwnPropertyDescriptor(
				HTMLTextAreaElement.prototype,
				"value",
			)!.set!.call(textarea, "Also count closed ones");
			textarea.dispatchEvent(new Event("input", { bubbles: true }));
		});
		expect(host.querySelector('[aria-label="Stop"]')).not.toBeNull();
		expect(host.querySelector('[aria-label="Send"]')).not.toBeNull();
		act(() => {
			Object.getOwnPropertyDescriptor(
				HTMLTextAreaElement.prototype,
				"value",
			)!.set!.call(textarea, "");
			textarea.dispatchEvent(new Event("input", { bubbles: true }));
		});

		act(() =>
			fake.feed([
				{
					seq: 2,
					at,
					conversationId: "c1",
					type: "turn.finished",
					turnId: "t1",
					status: "cancelled",
					durationMs: 1000,
				},
			]),
		);
		expect(host.querySelector('[aria-label="Stop"]')).toBeNull();
		expect(host.querySelector('[aria-label="Send"]')).not.toBeNull();
	});

	it.each([
		["cancelled", undefined],
		["error", "interrupted"],
	] as const)(
		"offers Continue after a %s turn and sends it as the next turn",
		(status, error) => {
			const fake = fakeClient("c1");
			mount(fake);
			const continueButton = () =>
				[...host.querySelectorAll("button")].find(
					(button) => button.textContent === "Continue",
				);
			act(() => fake.feed([started]));
			expect(continueButton()).toBeUndefined();
			act(() =>
				fake.feed([
					{
						seq: 2,
						at,
						conversationId: "c1",
						type: "turn.finished",
						turnId: "t1",
						status,
						...(error ? { error } : {}),
						durationMs: 1000,
					},
				]),
			);
			act(() => continueButton()?.click());
			expect(fake.calls).toContainEqual([
				"sendTurn",
				expect.objectContaining({
					text: expect.stringContaining("Continue where you stopped"),
				}),
			]);
		},
	);

	it("says in plain words that the model could not answer", () => {
		const fake = fakeClient("c1");
		mount(fake);
		const raw =
			'410: {"name":"AiError","internalCode":3028,"httpCode":410,"message":"AiError: Model has been deprecated"}';
		act(() =>
			fake.feed([
				started,
				{
					seq: 2,
					at,
					conversationId: "c1",
					type: "turn.finished",
					turnId: "t1",
					status: "error",
					error: raw,
					durationMs: 1000,
				},
			]),
		);
		expect(host.querySelector('[role="alert"]')?.textContent).toBe(
			"This model is not available right now. Pick another model and try again.",
		);
		expect(host.textContent).toContain("Technical details");
	});

	it("retries a failed turn by sending its own message again", () => {
		const fake = fakeClient("c1");
		mount(fake);
		act(() =>
			fake.feed([
				started,
				{
					seq: 2,
					at,
					conversationId: "c1",
					type: "turn.finished",
					turnId: "t1",
					status: "error",
					error: "boom",
					durationMs: 1000,
				},
			]),
		);
		const retry = [...host.querySelectorAll("button")].find(
			(button) => button.textContent === "Retry",
		);
		expect(retry).toBeDefined();
		act(() => retry?.click());
		expect(fake.calls).toContainEqual([
			"sendTurn",
			expect.objectContaining({ text: "How many challenges are open?" }),
		]);
	});

	it("calls a step the agent recovered from a retry, and only an unrecovered last step a failure", () => {
		const step = (seq: number, stepId: string, status: "ok" | "error") =>
			[
				{
					type: "step.started" as const,
					seq,
					at,
					conversationId: "c1",
					turnId: "t1",
					stepId,
					kind: "read" as const,
					label: "Reading a sheet",
				},
				{
					type: "step.finished" as const,
					seq: seq + 1,
					at,
					conversationId: "c1",
					turnId: "t1",
					stepId,
					status,
					durationMs: 1,
					...(status === "error" ? { error: "Sheet not found" } : {}),
				},
			] as const;
		const fake = fakeClient("c1");
		mount(fake);
		act(() =>
			fake.feed([started, ...step(2, "a", "error"), ...step(4, "b", "ok")]),
		);
		const summary = () =>
			host.querySelector(".workspace-chat-activity-summary")?.textContent ?? "";
		expect(summary()).toContain("1 retried");
		expect(summary()).not.toContain("Failed");
		act(() => fake.feed([...step(6, "c", "error")]));
		expect(summary()).toContain("Failed");
	});

	it("does not offer Continue after a turn that finished", () => {
		const fake = fakeClient("c1");
		mount(fake);
		act(() =>
			fake.feed([
				started,
				{
					seq: 2,
					at,
					conversationId: "c1",
					type: "turn.finished",
					turnId: "t1",
					status: "done",
					durationMs: 1000,
				},
			]),
		);
		expect(
			[...host.querySelectorAll("button")].some(
				(button) => button.textContent === "Continue",
			),
		).toBe(false);
	});

	it("keeps the thread at its end before paint and again after a conversation change", () => {
		const fake = fakeClient("c1");
		mount(fake);
		const thread = host.querySelector<HTMLElement>(".workspace-chat-thread")!;
		let height = 900;
		Object.defineProperty(thread, "scrollHeight", {
			configurable: true,
			get: () => height,
		});
		Object.defineProperty(thread, "clientHeight", {
			configurable: true,
			value: 300,
		});
		const scrolls: ScrollToOptions[] = [];
		thread.scrollTo = ((options: ScrollToOptions) => {
			scrolls.push(options);
			thread.scrollTop = options.top ?? 0;
		}) as typeof thread.scrollTo;
		act(() => fake.feed([started]));
		expect(scrolls.at(-1)).toEqual({ top: 900, behavior: "auto" });

		// Reading further up stops the thread from following new text.
		act(() => {
			thread.scrollTop = 0;
			thread.dispatchEvent(new Event("scroll", { bubbles: true }));
		});
		const before = scrolls.length;
		height = 1_400;
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
		expect(scrolls.length).toBe(before);

		// Another conversation opens at its end again.
		mount(fakeClient("c2"), "c2");
		expect(host.querySelector<HTMLElement>(".workspace-chat-thread")).toBe(
			thread,
		);
		expect(scrolls.at(-1)).toEqual({ top: 1_400, behavior: "auto" });
	});

	it("folds the steps into one line naming the current step, and lists them on request", async () => {
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
		const line = host.querySelector<HTMLButtonElement>(
			".workspace-chat-activity-summary",
		);
		expect(line?.textContent).toBe("Listing Work");
		expect(
			host.querySelector('[data-testid="workspace-chat-step"]'),
		).toBeNull();
		await act(async () => line?.click());
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

	it("says nothing about the connection until it drops, then only Reconnecting", () => {
		vi.useFakeTimers();
		try {
			const fake = fakeClient("c1");
			const chip = () =>
				host.querySelector('[data-testid="workspace-chat-connection"]');
			// First connect: silent, however long it takes.
			fake.set({ connection: { phase: "connecting", attempt: 0 } });
			mount(fake);
			act(() => void vi.advanceTimersByTime(5_000));
			expect(chip()).toBeNull();
			act(() => fake.set({ connection: { phase: "open", since: 0 } }));
			act(() => fake.feed([started]));

			// A blip shorter than the delay stays silent.
			act(() =>
				fake.set({
					connection: { phase: "reconnecting", attempt: 1, nextTryAt: 0 },
				}),
			);
			act(() => void vi.advanceTimersByTime(1_000));
			expect(chip()).toBeNull();
			act(() => fake.set({ connection: { phase: "open", since: 0 } }));
			act(() => void vi.advanceTimersByTime(5_000));
			expect(chip()).toBeNull();

			// A real drop names itself once, with no count and no clock.
			act(() =>
				fake.set({
					connection: { phase: "reconnecting", attempt: 2, nextTryAt: 0 },
				}),
			);
			act(() => void vi.advanceTimersByTime(1_600));
			expect(chip()?.textContent).toBe("Reconnecting…");
			expect(
				host.querySelector('[data-testid="workspace-chat-working"]')
					?.textContent,
			).toMatch(/^Working · (\d+m )?\d+s$/);
			expect(host.textContent).not.toContain("last update");
			expect(host.textContent).not.toContain("Live updates paused");

			// Moving to another conversation is not a drop.
			const next = fakeClient("c2");
			next.set({ connection: { phase: "connecting", attempt: 0 } });
			mount(next, "c2");
			act(() => void vi.advanceTimersByTime(5_000));
			expect(chip()).toBeNull();
		} finally {
			vi.useRealTimers();
		}
	});

	it("says plainly when this origin has no object lane yet, with a retry", () => {
		const fake = fakeClient("c1");
		mount(fake);
		act(() => fake.set({ connection: { phase: "unavailable" } }));
		const notice = host.querySelector(
			'[data-testid="workspace-chat-unavailable"]',
		);
		expect(notice?.textContent).toContain(
			"Workspace chat is unavailable on this origin. Home chat still works.",
		);
		expect(host.querySelector("textarea")?.disabled).toBe(true);
		expect(
			host.querySelector('[data-testid="workspace-chat-working"]'),
		).toBeNull();
		const retry = [...(notice?.querySelectorAll("button") ?? [])].find(
			(button) => button.textContent === "Retry",
		);
		act(() => retry?.click());
		expect(fake.calls).toContainEqual(["retry"]);
	});

	it("shows an imported approval hold with its Home link and no running clock", () => {
		const fake = fakeClient("c1");
		mount(fake);
		act(() =>
			fake.feed([
				started,
				{
					seq: 2,
					at,
					conversationId: "c1",
					type: "turn.finished",
					turnId: "t1",
					status: "waiting",
					durationMs: 0,
					approvalUrl: "/work/executions/t1",
				},
			]),
		);
		const footer = host.querySelector('[data-testid="workspace-chat-timer"]');
		expect(footer?.textContent).toBe("Waiting for approval");
		expect(footer?.querySelector("a")?.getAttribute("href")).toBe(
			"/work/executions/t1",
		);
		expect(host.querySelector('button[aria-label="Stop"]')).toBeNull();
		expect(host.textContent).not.toContain("Working");
	});

	it("renders an approval inline, keeps the composer open and posts the decision", () => {
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
		expect(card?.id).toBe("approval-a1");
		const timer = host.querySelector('[data-testid="workspace-chat-timer"]');
		expect(timer?.textContent).toBe("Waiting for approval");
		expect(timer?.querySelector("a")?.getAttribute("href")).toBe(
			"#approval-a1",
		);
		// A waiting proposal never blocks the composer; it waits in the tray.
		const textarea = host.querySelector("textarea");
		expect(textarea?.disabled).toBe(false);
		expect(textarea?.placeholder).not.toContain("Approve or deny");
		expect(
			host.querySelector('[data-testid="workspace-chat-tray"]')?.textContent,
		).toContain("Waiting for you (1)");
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
		expect(
			host.querySelector('[data-testid="workspace-chat-tray"]'),
		).toBeNull();
	});

	it("names the tedi that answers and who asked for a change", () => {
		queryClient.setQueryData<unknown>(tediNamesQueryOptions().queryKey, {
			data: [{ id: "tedi-support", name: "support", displayName: "Support" }],
		});
		const fake = fakeClient("c1");
		mount(fake);
		act(() =>
			fake.feed(
				heldChange({}).map((event) =>
					event.type === "turn.started"
						? { ...event, respondingTediId: "tedi-support" }
						: event.type === "approval.requested"
							? {
									...event,
									requester: { id: "aaron", kind: "person" },
									actingTediId: "tedi-support",
								}
							: event,
				),
			),
		);
		expect(
			host.querySelector(".workspace-chat-reply .workspace-chat-author")
				?.textContent,
		).toBe("Support");
		expect(host.textContent).toContain(
			"Asked by Workspace member. Support will apply it.",
		);
	});

	it("names the workspace's default tedi in the picker also when it is not on the roster page", () => {
		queryClient.setQueryData<unknown>(
			tediRosterQueryOptions(100, { status: "active" }).queryKey,
			{
				data: [
					{
						id: "tedi-support",
						name: "support",
						displayName: "Support",
						scope: "organization",
						status: "active",
					},
				],
			},
		);
		queryClient.setQueryData<unknown>(
			workspaceDetailQueryOptions("ws-1").queryKey,
			{ workspace: { id: "ws-1", defaultTediId: "tedi-ceo" } },
		);
		queryClient.setQueryData<unknown>(
			tediDetailQueryOptions("tedi-ceo").queryKey,
			{
				id: "tedi-ceo",
				name: "ceo",
				displayName: "CEO",
				scope: "organization",
				status: "active",
			},
		);
		mount(fakeClient("c1"));
		expect(
			host.querySelector('[aria-label="Replying agent"]')?.textContent,
		).toBe("CEO");
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
			input: {
				ops: Array.from({ length: 7 }, (_, index) => ({
					op: "delete",
					index,
					slide: { title: `Slide ${index}` },
				})),
			},
			text: "… and 1 more operation not shown",
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

	it("invalidates output and app queries after a successful write notification", () => {
		const fake = fakeClient("c1");
		const invalidate = vi.spyOn(queryClient, "invalidateQueries");
		mount(fake);
		act(() => fake.notifyOutputs());
		expect(invalidate).toHaveBeenCalledWith({
			queryKey: osQueryKeys.outputs(),
		});
		expect(invalidate).toHaveBeenCalledWith({
			queryKey: osQueryKeys.gadgets(),
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

	it("shows no line under a finished answer; the details sit behind its time", async () => {
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
					usage: { inputTokens: 2000, outputTokens: 500 },
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
		expect(host.querySelector(".workspace-chat-turn-footer")).toBeNull();
		expect(host.textContent).not.toMatch(/unavailable|tokens|mock/);
		const time = host.querySelector<HTMLButtonElement>(
			'[data-testid="workspace-chat-turn-time"]',
		)!;
		expect(time.tagName).toBe("BUTTON");
		expect(time.textContent).toMatch(/\d{1,2}[:.]\d{2}/);
		await act(async () => {
			time.focus();
			await new Promise((resolve) => setTimeout(resolve, 50));
		});
		const tip = document.querySelector('[role="tooltip"]');
		expect(
			[...(tip?.querySelectorAll("span") ?? [])].map(
				(part) => part.textContent,
			),
		).toEqual(["Took 4s", "mock"]);
	});

	it.each([true, false])(
		"shows the conversation credit share only with billing read (%s)",
		(canRead) => {
			const periodStart = "2026-11-01T00:00:00.000Z";
			queryClient.setQueryData<unknown>(
				operationalContextQueryOptions().queryKey,
				{
					authority: { permissions: canRead ? ["billing:read"] : ["os:read"] },
				},
			);
			queryClient.setQueryData<unknown>(
				billingOverviewQueryOptions().queryKey,
				{
					credits: {
						periodStart,
						includedCredits: 1_000,
						topUpCredits: 0,
						usedCredits: 400,
						payAsYouGo: { spentMicros: 0 },
					},
				},
			);
			queryClient.setQueryData(
				workspaceConversationChargesQueryOptions("ws-1", "c1").queryKey,
				{ periodStart, credits: 125, chargeCount: 2 },
			);
			mount(fakeClient("c1"));
			const ring = host.querySelector(".chat-usage-ring");
			if (canRead)
				expect(ring?.getAttribute("aria-label")).toBe(
					"Usage: 12% of this month's credits used in this conversation",
				);
			else expect(ring).toBeNull();
		},
	);

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
		// Someone else's turn alone asks for nothing; this tab's own post asks once.
		expect(notifyChatPosted).not.toHaveBeenCalled();
		act(() => fake.feed([started]));
		expect(notifyChatPosted).toHaveBeenCalledTimes(1);
		expect(notifyChatPosted).toHaveBeenCalledWith({
			workspaceId: "ws-1",
			conversationId: "c1",
			mentionedUserIds: [],
		});
	});

	it("puts a starter prompt in the message box without sending it", () => {
		const fake = fakeClient("c1");
		mount(fake);
		const starter = Array.from(host.querySelectorAll("button")).find(
			(button) => button.textContent === "What changed here this week?",
		);
		act(() => starter?.click());
		expect(host.querySelector("textarea")?.value).toBe(
			"What changed here this week?",
		);
		expect(fake.calls).toEqual([]);
	});

	it("does not ask to notify anyone for activity this tab did not post", () => {
		notifyChatPosted.mockClear();
		const fake = fakeClient("c1");
		mount(fake);
		act(() => fake.feed([started]));
		expect(notifyChatPosted).not.toHaveBeenCalled();
	});
	describe("a reply with several proposals", () => {
		const proposal = (
			seq: number,
			approvalId: string,
			title: string,
			target: string,
		): WorkspaceChatLedgerEvent => ({
			seq,
			at,
			conversationId: "c1",
			type: "approval.requested",
			turnId: "t1",
			stepId: `s-${approvalId}`,
			approvalId,
			title,
			reason: "Policy requires a person.",
			input: { title: target },
		});
		const three = [
			started,
			proposal(2, "a1", "Creating a new output", "Budget"),
			proposal(3, "a2", "Creating a new output", "Forecast"),
			proposal(4, "a3", "Creating a new output", "Board deck"),
		];
		const buttons = () => [...host.querySelectorAll("button")];
		const named = (name: string) =>
			buttons().find((button) => button.getAttribute("aria-label") === name);

		it("names each Approve and Deny button after its item", () => {
			const fake = fakeClient("c1");
			mount(fake);
			act(() => fake.feed(three));
			expect(named("Approve creating Budget")?.textContent).toBe("Approve");
			expect(named("Deny creating Budget")?.textContent).toBe("Deny");
			expect(named("Approve creating Board deck")).toBeDefined();
			act(() => named("Deny creating Forecast")?.click());
			expect(fake.calls).toContainEqual(["decideApproval", "a2", "deny"]);
		});

		it("approves every waiting proposal of the reply with one button", () => {
			const fake = fakeClient("c1");
			mount(fake);
			act(() => fake.feed(three));
			const all = buttons().find(
				(button) => button.textContent === "Approve all (3)",
			);
			expect(all).toBeDefined();
			act(() => all?.click());
			expect(fake.calls).toContainEqual([
				"decideApprovals",
				["a1", "a2", "a3"],
				"approve",
			]);
			expect(all?.disabled).toBe(true);
			expect(named("Approve creating Budget")?.disabled).toBe(true);
			expect(named("Deny creating Forecast")?.disabled).toBe(true);
		});

		it("counts only proposals still waiting and hides the button for one", () => {
			const fake = fakeClient("c1");
			mount(fake);
			act(() =>
				fake.feed([
					...three,
					{
						seq: 5,
						at,
						conversationId: "c1",
						type: "approval.decided",
						approvalId: "a1",
						decision: "deny",
						by: "person:aaron",
					},
				]),
			);
			expect(
				buttons().some((button) => button.textContent === "Approve all (2)"),
			).toBe(true);
			act(() =>
				fake.feed([
					{
						seq: 6,
						at,
						conversationId: "c1",
						type: "approval.decided",
						approvalId: "a2",
						decision: "approve",
						by: "person:aaron",
					},
				]),
			);
			expect(
				buttons().some((button) =>
					button.textContent?.startsWith("Approve all"),
				),
			).toBe(false);
		});

		it("offers one undo after the reply's changes are applied", () => {
			const fake = fakeClient("c1");
			mount(fake);
			const applied = (
				seq: number,
				approvalId: string,
				outputId: string,
			): WorkspaceChatLedgerEvent[] => [
				{
					seq,
					at,
					conversationId: "c1",
					type: "approval.decided",
					approvalId,
					decision: "approve",
					by: "person:aaron",
				},
				{
					seq: seq + 1,
					at,
					conversationId: "c1",
					type: "approval.executed",
					approvalId,
					status: "applied",
					output: { outputId, revision: 1 },
				},
			];
			act(() =>
				fake.feed([
					...three.slice(0, 3),
					...applied(10, "a1", "o1"),
					...applied(12, "a2", "o2"),
				]),
			);
			expect(
				buttons().some(
					(button) => button.textContent === "Undo all from this reply",
				),
			).toBe(true);
			expect(
				buttons().some((button) =>
					button.textContent?.startsWith("Approve all"),
				),
			).toBe(false);
		});
	});

	describe("changes that apply at once", () => {
		const applying: WorkspaceChatLedgerEvent = {
			seq: 2,
			at,
			conversationId: "c1",
			type: "approval.requested",
			turnId: "t1",
			stepId: "s1",
			approvalId: "a1",
			title: "Creating a new output",
			reason: "applies_at_once",
			input: { title: "Budget" },
			automatic: true,
		};
		const buttons = () =>
			[...host.querySelectorAll("button")].map((button) => button.textContent);

		it("never waits for a person, even before the decision arrives", () => {
			const fake = fakeClient("c1");
			mount(fake);
			act(() => fake.feed([started, applying]));
			expect(waitingForDecision(fake.client.getSnapshot().state)).toEqual([]);
			expect(
				host.querySelector('[data-testid="workspace-chat-tray"]'),
			).toBeNull();
			expect(buttons()).not.toContain("Approve");
			expect(buttons()).not.toContain("Deny");
			expect(host.textContent).not.toContain("Waiting for approval");
		});

		it("shows the change as applied once it ran", () => {
			const fake = fakeClient("c1");
			mount(fake);
			act(() =>
				fake.feed([
					started,
					applying,
					{
						seq: 3,
						at,
						conversationId: "c1",
						type: "approval.decided",
						approvalId: "a1",
						decision: "approve",
						by: "u1",
						automatic: true,
					},
					{
						seq: 4,
						at,
						conversationId: "c1",
						type: "approval.executed",
						approvalId: "a1",
						status: "applied",
						output: { outputId: "o1", revision: 1 },
					},
				]),
			);
			expect(
				host.querySelector('[data-testid="workspace-chat-approval-status"]')
					?.textContent,
			).toBe("Applied");
			expect(
				host.querySelector('[data-testid="workspace-chat-tray"]'),
			).toBeNull();
		});
	});
});
