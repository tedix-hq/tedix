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
import type { WorkspaceChatLedgerEvent } from "@/lib/workspace-chat-protocol";
import {
	approvalTitle,
	webPageRequest,
} from "@/lib/workspace-chat-web-approval";
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
const URL_ASKED = "https://www.example.com/pricing/teams?plan=annual";

function asked(title: string): WorkspaceChatLedgerEvent[] {
	return [
		{
			seq: 1,
			at,
			conversationId: "c1",
			turnId: "t1",
			type: "turn.started",
			text: "What does the team plan cost?",
			authorId: "p",
			authorKind: "person",
		},
		{
			seq: 2,
			at,
			conversationId: "c1",
			turnId: "t1",
			type: "approval.requested",
			stepId: "s1",
			approvalId: "a1",
			title,
			reason: "approval_pending",
			input: URL_ASKED,
		},
	];
}

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
});

function mount(fake: ReturnType<typeof fakeWorkspaceChatClient>) {
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

describe("a web page the agent asks to read", () => {
	it("is recognised by its https address only", () => {
		expect(webPageRequest({ input: URL_ASKED })).toEqual({
			site: "example.com",
			url: URL_ASKED,
		});
		expect(webPageRequest({ input: "http://example.com/" })).toBeNull();
		expect(webPageRequest({ input: "Budget" })).toBeNull();
		expect(webPageRequest({ input: { title: "https://example.com" } })).toBe(
			null,
		);
		expect(
			approvalTitle({ input: { outputId: "o1" }, title: "Editing slides" }),
		).toBe("Editing slides");
	});

	// Cards recorded before the site was in the title read the same way.
	it.each(["Reading a web page", "Read example.com"])(
		"names the site and shows the full address on the card and in the tray (%s)",
		(title) => {
			const fake = fakeWorkspaceChatClient("c1");
			mount(fake);
			act(() => fake.feed(asked(title)));
			const card = host.querySelector(
				'[data-testid="workspace-chat-approval"]',
			);
			expect(
				card?.querySelector(".workspace-chat-card-title")?.textContent,
			).toBe("Read example.com");
			expect(
				card?.querySelector('[data-testid="workspace-chat-approval-url"]')
					?.textContent,
			).toBe(URL_ASKED);
			expect(card?.textContent).toContain(
				"If you approve, it can read pages on example.com for the rest of this conversation.",
			);
			expect(
				card?.querySelector('button[aria-label="Approve reading example.com"]'),
			).not.toBeNull();

			const row = host.querySelector(
				'[data-testid="workspace-chat-tray"] .workspace-chat-tray-item',
			);
			expect(row?.textContent).toContain("Read example.com");
			expect(row?.textContent).toContain(URL_ASKED);
		},
	);

	it("says the page was read once it is", () => {
		const fake = fakeWorkspaceChatClient("c1");
		mount(fake);
		act(() =>
			fake.feed([
				...asked("Read example.com"),
				{
					seq: 3,
					at,
					conversationId: "c1",
					type: "approval.decided",
					approvalId: "a1",
					decision: "approve",
					by: "u1",
				},
				{
					seq: 4,
					at,
					conversationId: "c1",
					type: "approval.executed",
					approvalId: "a1",
					status: "applied",
				},
			]),
		);
		const card = host.querySelector('[data-testid="workspace-chat-approval"]');
		expect(card?.textContent).toContain("The agent read this page.");
		expect(card?.textContent).toContain(URL_ASKED);
	});
});
