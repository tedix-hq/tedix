// @vitest-environment happy-dom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot } from "react-dom/client";
import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vite-plus/test";
import {
	workspaceNameFromPrompt,
	workspaceRetryName,
} from "@/components/chat-page";

const chatHarness = vi.hoisted(() => ({
	onSelect: null as null | ((conversationId: string | null) => void),
	onConversationCreated: null as
		| null
		| ((conversationId: string, workspaceId?: string) => void),
	onConversationPrepared: null as
		| null
		| ((conversationId: string, workspaceId: string) => void),
	prepareNewConversation: null as
		| null
		| ((content: string) => Promise<{ workspaceId: string }>),
}));

const apiHarness = vi.hoisted(() => ({
	createWorkspace: vi.fn(),
}));

const routing = vi.hoisted(() => ({
	navigate: vi.fn(),
	search: {} as { conversation?: string },
}));

describe("chat workspace names", () => {
	it("keeps a collision retry unique and within the workspace name limit", () => {
		const base = workspaceNameFromPrompt("x".repeat(100));
		const retry = workspaceRetryName(base, "12345678-rest");
		expect(retry).toHaveLength(72);
		expect(retry.endsWith(" · 12345678")).toBe(true);
	});
});

vi.mock("@tanstack/react-router", () => ({
	useNavigate: () => routing.navigate,
	useSearch: () => routing.search,
}));

vi.mock("@/components/chat-sidebar", () => ({
	CHAT_CONVERSATIONS_QUERY_KEY: ["os-chat-conversations"],
	ChatConversationHeader: ({
		conversationId,
		onBack,
	}: {
		conversationId: string | null;
		onBack: () => void;
	}) => (
		<div data-conversation-header={conversationId ?? "new"}>
			<button aria-label="Back to conversations" onClick={onBack} type="button">
				Back
			</button>
		</div>
	),
	ChatSidebar: ({
		activeConversationId,
		onSelect,
	}: {
		activeConversationId: string | null;
		onSelect: (conversationId: string | null) => void;
	}) => {
		chatHarness.onSelect = onSelect;
		return (
			<nav
				aria-label="Conversations"
				data-active-conversation={activeConversationId ?? "new"}
			>
				<button onClick={() => onSelect("home:os:second")} type="button">
					Second conversation
				</button>
				<button onClick={() => onSelect(null)} type="button">
					New
				</button>
			</nav>
		);
	},
}));

vi.mock("@/components/chat-thread", () => ({
	ChatThread: ({
		conversationId,
		onConversationCreated,
		onConversationPrepared,
		prepareNewConversation,
	}: {
		conversationId: string | null;
		onConversationCreated?: (
			conversationId: string,
			workspaceId?: string,
		) => void;
		onConversationPrepared?: (
			conversationId: string,
			workspaceId: string,
		) => void;
		prepareNewConversation?: (
			content: string,
		) => Promise<{ workspaceId: string }>;
	}) => {
		chatHarness.onConversationCreated = onConversationCreated ?? null;
		chatHarness.onConversationPrepared = onConversationPrepared ?? null;
		chatHarness.prepareNewConversation = prepareNewConversation ?? null;
		return <div data-chat-thread={conversationId ?? "new"}>Chat thread</div>;
	},
}));

vi.mock("@/components/chat-webmcp-tools", () => ({
	useChatWebMcpTools: () => undefined,
}));

vi.mock("@/lib/api", () => ({
	osApi: {
		osWorkspaces: { workspaces: { create: apiHarness.createWorkspace } },
	},
}));

vi.mock("@/lib/os-query-options", () => ({
	activeWorkspacesQueryOptions: () => ({
		queryKey: ["os-workspaces", "active"],
	}),
	osQueryKeys: { workspaces: () => ["os-workspaces"] },
}));

import { ChatPage } from "./chat-page";

(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const WORKSPACE_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CONVERSATION_ID = "home:os:11111111-1111-4111-8111-111111111111";

let cleanup: (() => Promise<void>) | undefined;

beforeEach(() => {
	routing.navigate.mockReset();
	routing.search = {};
});

afterEach(async () => {
	await cleanup?.();
	cleanup = undefined;
	chatHarness.onSelect = null;
	chatHarness.onConversationCreated = null;
	chatHarness.onConversationPrepared = null;
	chatHarness.prepareNewConversation = null;
	apiHarness.createWorkspace.mockReset();
});

async function mountPage(): Promise<HTMLElement> {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false, enabled: false } },
	});
	const host = document.createElement("div");
	document.body.append(host);
	const root = createRoot(host);
	cleanup = async () => {
		await act(async () => root.unmount());
		client.clear();
		host.remove();
	};
	await act(async () => {
		root.render(
			<QueryClientProvider client={client}>
				<ChatPage />
			</QueryClientProvider>,
		);
	});
	return host;
}

function activeThread(host: HTMLElement): string | null | undefined {
	return host
		.querySelector("[data-chat-thread]")
		?.getAttribute("data-chat-thread");
}

describe("ChatPage responsive conversation navigation", () => {
	it("shows one mobile pane at a time while keeping both panes available on desktop", async () => {
		const host = await mountPage();

		const directory = host.querySelector(
			'[data-slot="chat-conversation-directory"]',
		) as HTMLElement;
		const activeConversation = host.querySelector(
			'[data-slot="chat-active-conversation"]',
		) as HTMLElement;

		expect(directory.className).toContain("hidden");
		expect(directory.className).toContain("md:block");
		expect(activeConversation.className).toContain("flex");
		expect(activeConversation.className).toContain("md:flex");

		await act(async () => {
			(
				host.querySelector(
					'[aria-label="Back to conversations"]',
				) as HTMLButtonElement
			).click();
		});

		expect(directory.className).toContain("block");
		expect(activeConversation.className).toContain("hidden");

		await act(async () => {
			(host.querySelector("nav button") as HTMLButtonElement).click();
		});

		expect(directory.className).toContain("hidden");
		expect(activeConversation.className).toContain("flex");
	});
});

describe("ChatPage deep links (/chat?conversation=)", () => {
	it("lands on the new-conversation state when the URL names no thread", async () => {
		const host = await mountPage();
		// Never a stale auto-selected thread: no param means a fresh thread.
		expect(activeThread(host)).toBe("new");
		expect(
			host
				.querySelector('[aria-label="Conversations"]')
				?.getAttribute("data-active-conversation"),
		).toBe("new");
		expect(routing.navigate).not.toHaveBeenCalled();
	});

	it("honours the conversation in the URL on load", async () => {
		routing.search = { conversation: CONVERSATION_ID };
		const host = await mountPage();
		expect(activeThread(host)).toBe(CONVERSATION_ID);
		expect(
			host
				.querySelector("[data-conversation-header]")
				?.getAttribute("data-conversation-header"),
		).toBe(CONVERSATION_ID);
	});

	it("selects from the list with a replace navigation, never a history push", async () => {
		const host = await mountPage();
		await act(async () => {
			(host.querySelector("nav button") as HTMLButtonElement).click();
		});
		expect(routing.navigate).toHaveBeenCalledWith({
			to: "/chat",
			search: { conversation: "home:os:second" },
			replace: true,
		});

		await act(async () => chatHarness.onSelect?.(null));
		expect(routing.navigate).toHaveBeenLastCalledWith({
			to: "/chat",
			search: {},
			replace: true,
		});
	});

	it("opens the first send in its workspace with the conversation and no pane override", async () => {
		await mountPage();
		await act(async () =>
			chatHarness.onConversationCreated?.(CONVERSATION_ID, WORKSPACE_ID),
		);
		expect(routing.navigate).toHaveBeenCalledTimes(1);
		expect(routing.navigate).toHaveBeenCalledWith({
			to: "/workspace/$workspaceId",
			params: { workspaceId: WORKSPACE_ID },
			search: { conversation: CONVERSATION_ID },
		});
		// A client-side push (no `replace`, no reload): Back returns to /chat.
		expect(routing.navigate.mock.calls[0]?.[0]).not.toHaveProperty("replace");
		expect(routing.navigate.mock.calls[0]?.[0].search).not.toHaveProperty(
			"pane",
		);
	});

	it("opens the prepared workspace before enqueue settlement", async () => {
		await mountPage();
		await act(async () =>
			chatHarness.onConversationPrepared?.(CONVERSATION_ID, WORKSPACE_ID),
		);
		expect(routing.navigate).toHaveBeenCalledWith({
			to: "/workspace/$workspaceId",
			params: { workspaceId: WORKSPACE_ID },
			search: { conversation: CONVERSATION_ID },
		});
	});

	it("does not await the background workspace-directory revalidation", async () => {
		apiHarness.createWorkspace.mockResolvedValue({
			workspace: { id: WORKSPACE_ID },
		});
		const invalidation = vi
			.spyOn(QueryClient.prototype, "invalidateQueries")
			.mockReturnValue(new Promise(() => undefined));
		await mountPage();
		const prepared = await Promise.race([
			chatHarness.prepareNewConversation?.("Fast handoff"),
			new Promise<never>((_resolve, reject) =>
				setTimeout(
					() => reject(new Error("workspace preparation stalled")),
					50,
				),
			),
		]);
		expect(prepared).toEqual({ workspaceId: WORKSPACE_ID });
		expect(invalidation).toHaveBeenCalled();
		invalidation.mockRestore();
	});

	it("seeds the created workspace before the workbench handoff", async () => {
		const workspace = { id: WORKSPACE_ID, name: "Fresh workspace" };
		apiHarness.createWorkspace.mockResolvedValue({ workspace });
		const setQueryData = vi.spyOn(QueryClient.prototype, "setQueryData");
		await mountPage();

		await chatHarness.prepareNewConversation?.("Fresh workspace");

		expect(setQueryData).toHaveBeenCalledWith(
			["os-workspaces", "active"],
			expect.any(Function),
		);
		const update = setQueryData.mock.calls[0]?.[1] as (
			current:
				| {
						items: Array<{ id: string; name: string }>;
						truncated: boolean;
				  }
				| undefined,
		) => { items: Array<{ id: string; name: string }>; truncated: boolean };
		const stale = {
			items: [{ id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", name: "Stale" }],
			truncated: false,
		};
		expect(update(stale)).toEqual({
			items: [workspace, ...stale.items],
			truncated: false,
		});
		expect(update(undefined)).toEqual({
			items: [workspace],
			truncated: false,
		});
	});

	it("keeps a workspace-less conversation on /chat", async () => {
		await mountPage();
		await act(async () => chatHarness.onConversationCreated?.(CONVERSATION_ID));
		expect(routing.navigate).toHaveBeenCalledWith({
			to: "/chat",
			search: { conversation: CONVERSATION_ID },
			replace: true,
		});
	});
});
