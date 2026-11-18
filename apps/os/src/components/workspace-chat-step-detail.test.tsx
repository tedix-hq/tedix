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
import { ChatOutputLinkContext } from "@/components/chat-markdown";
import type { WorkspaceChatLedgerEvent } from "@/lib/workspace-chat-protocol";
vi.mock("@/lib/use-chat-model-preference", async (original) => ({
	...(await original<typeof import("@/lib/use-chat-model-preference")>()),
	useChatModelPreference: () => ({
		modelRef: null,
		settled: true,
		save: () => {},
	}),
}));
import { WorkspaceChat } from "./workspace-chat";
import { fakeWorkspaceChatClient } from "./workspace-chat-test-client";

(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const at = "2026-11-07T12:00:00.000Z";
const base = { at, conversationId: "c1", turnId: "t1" };
const CODE =
	"export default async (env) => env.sheets.read({ outputId: 'o1' })";

function turn(...rest: WorkspaceChatLedgerEvent[]): WorkspaceChatLedgerEvent[] {
	return [
		{
			...base,
			seq: 1,
			type: "turn.started",
			text: "How many rows?",
			authorId: "p",
			authorKind: "person",
		},
		...rest,
	];
}

const codeStep: WorkspaceChatLedgerEvent[] = [
	{
		...base,
		seq: 2,
		type: "step.started",
		stepId: "code",
		label: "Running code against the workspace",
		kind: "code",
		tool: "run_code",
		input: { code: CODE },
	},
	{
		...base,
		seq: 3,
		type: "step.started",
		stepId: "read",
		label: "Reading a sheet",
		kind: "read",
		tool: "sheets.read",
		input: { outputId: "o1" },
	},
	{
		...base,
		seq: 4,
		type: "step.finished",
		stepId: "read",
		status: "ok",
		durationMs: 3,
		result: '{"rows":[["Name"],["Ada"]]}',
	},
	{
		...base,
		seq: 5,
		type: "step.finished",
		stepId: "code",
		status: "ok",
		durationMs: 9,
		result: "return value:\n2",
	},
	{
		...base,
		seq: 6,
		type: "assistant.done",
		messageId: "t1",
		text: "There are **2** rows.",
	},
	{ ...base, seq: 7, type: "turn.finished", status: "done", durationMs: 12 },
];

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
});

afterEach(() => {
	act(() => root.unmount());
	host.remove();
	vi.restoreAllMocks();
});

function mount(
	fake: ReturnType<typeof fakeWorkspaceChatClient>,
	openOutput?: (outputId: string) => void,
) {
	const queryClient = new QueryClient({
		defaultOptions: { queries: { retry: false, staleTime: Infinity } },
	});
	act(() => {
		root.render(
			<QueryClientProvider client={queryClient}>
				<ChatOutputLinkContext.Provider
					value={openOutput ? { openOutput } : {}}
				>
					<WorkspaceChat
						conversationId="c1"
						createClient={fake.createClient}
						listOpen={false}
						onOpenList={() => {}}
						onSelectConversation={() => {}}
						workspaceId="ws-1"
					/>
				</ChatOutputLinkContext.Provider>
			</QueryClientProvider>,
		);
	});
}

const button = (name: string) =>
	[...host.querySelectorAll("button")].find(
		(el) =>
			el.textContent?.trim() === name || el.getAttribute("aria-label") === name,
	);
const click = (el: Element | undefined | null) =>
	act(async () => {
		el?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
	});
const details = () =>
	[...host.querySelectorAll('[data-testid="workspace-chat-step-detail"]')].map(
		(el) => el.textContent,
	);

describe("what the agent did", () => {
	it("opens a step to show the code it ran and what came back", async () => {
		const fake = fakeWorkspaceChatClient("c1");
		mount(fake);
		act(() => fake.feed(turn(...codeStep)));
		await click(button("2 steps"));
		expect(details()).toEqual([]);

		await click(button("Running code against the workspace"));
		expect(details()).toHaveLength(1);
		expect(details()[0]).toContain("Code");
		expect(details()[0]).toContain(CODE);
		expect(details()[0]).toContain("Result");
		expect(details()[0]).toContain("return value:");

		await click(button("Reading a sheet"));
		expect(details()[1]).toContain("Request");
		expect(details()[1]).toContain('"outputId": "o1"');
		expect(details()[1]).toContain("Ada");

		await click(button("Running code against the workspace"));
		expect(details()).toHaveLength(1);
	});

	it("keeps a step with nothing recorded as plain text", async () => {
		const fake = fakeWorkspaceChatClient("c1");
		mount(fake);
		act(() =>
			fake.feed(
				turn(
					{
						...base,
						seq: 2,
						type: "step.started",
						stepId: "old",
						label: "Listing resources",
						kind: "read",
					},
					{
						...base,
						seq: 3,
						type: "step.finished",
						stepId: "old",
						status: "ok",
						durationMs: 1,
					},
					{
						...base,
						seq: 4,
						type: "turn.finished",
						status: "done",
						durationMs: 2,
					},
				),
			),
		);
		await click(button("Listing resources"));
		expect(
			host.querySelector('[data-testid="workspace-chat-step"] button'),
		).toBeNull();
		expect(details()).toEqual([]);
	});

	it("copies a finished reply as it was written", async () => {
		const writeText = vi.fn(async () => {});
		Object.defineProperty(navigator, "clipboard", {
			configurable: true,
			value: { writeText },
		});
		const fake = fakeWorkspaceChatClient("c1");
		mount(fake);
		act(() => fake.feed(turn(...codeStep.slice(0, 4))));
		expect(
			host.querySelector('[data-testid="workspace-chat-reply-copy"]'),
		).toBeNull();
		act(() => fake.feed(codeStep.slice(4)));
		await click(button("Copy"));
		expect(writeText).toHaveBeenCalledExactlyOnceWith("There are **2** rows.");
	});

	const applied: WorkspaceChatLedgerEvent[] = [
		{
			...base,
			seq: 2,
			type: "approval.requested",
			stepId: "write",
			approvalId: "a1",
			title: "Saving a document revision",
			reason: "approval_pending",
			input: { outputId: "o1" },
			target: { id: "o1", title: "Meeting notes" },
		},
		{
			at,
			conversationId: "c1",
			seq: 3,
			type: "approval.decided",
			approvalId: "a1",
			decision: "approve",
			by: "u1",
		},
	];

	it("opens the changed file in the workspace once the change is applied", async () => {
		const openOutput = vi.fn();
		const fake = fakeWorkspaceChatClient("c1");
		mount(fake, openOutput);
		act(() => fake.feed(turn(...applied)));
		expect(button("Open Meeting notes")).toBeUndefined();
		act(() =>
			fake.feed([
				{
					at,
					conversationId: "c1",
					seq: 4,
					type: "approval.executed",
					approvalId: "a1",
					status: "applied",
					output: { outputId: "o1", revision: 3 },
				},
			]),
		);
		expect(button("Open Meeting notes")?.textContent).toBe("Open");
		await click(button("Open Meeting notes"));
		expect(openOutput).toHaveBeenCalledExactlyOnceWith("o1");
	});

	it("offers no Open for a change that failed", () => {
		const fake = fakeWorkspaceChatClient("c1");
		mount(fake);
		act(() =>
			fake.feed(
				turn(...applied, {
					at,
					conversationId: "c1",
					seq: 4,
					type: "approval.executed",
					approvalId: "a1",
					status: "failed",
					error: "The file changed",
				}),
			),
		);
		expect(button("Open Meeting notes")).toBeUndefined();
	});

	it("marks the turn before which earlier messages were summarised", () => {
		const fake = fakeWorkspaceChatClient("c1");
		mount(fake);
		act(() => fake.feed(turn(...codeStep)));
		expect(
			host.querySelector('[data-testid="workspace-chat-summarised"]'),
		).toBeNull();
		act(() =>
			fake.feed([
				{
					at: "2026-11-07T12:05:00.000Z",
					conversationId: "c1",
					turnId: "t2",
					seq: 8,
					type: "turn.started",
					text: "And now?",
					authorId: "p",
					authorKind: "person",
				},
				{
					at: "2026-11-07T12:05:01.000Z",
					conversationId: "c1",
					turnId: "t2",
					seq: 9,
					type: "conversation.summarized",
				},
			]),
		);
		const turns = [
			...host.querySelectorAll('[data-testid="workspace-chat-turn"]'),
		];
		expect(turns).toHaveLength(2);
		expect(
			turns[0]?.querySelector('[data-testid="workspace-chat-summarised"]'),
		).toBeNull();
		expect(
			turns[1]?.querySelector('[data-testid="workspace-chat-summarised"]')
				?.textContent,
		).toBe("Earlier messages were summarised");
	});
});
