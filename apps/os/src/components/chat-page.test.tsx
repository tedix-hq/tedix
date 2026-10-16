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
	createFromConversation: vi.fn(),
	conversations: [] as Array<{
		id: string;
		title?: string;
		workspaceId?: string | null;
	}>,
}));

const routing = vi.hoisted(() => ({
	navigate: vi.fn(),
	search: {} as { conversation?: string },
}));

vi.mock("@tanstack/react-router", () => ({
	useNavigate: () => routing.navigate,
	useSearch: () => routing.search,
}));

vi.mock("@/components/chat-sidebar", () => ({
	CHAT_CONVERSATIONS_QUERY_KEY: ["os-chat-conversations"],
	conversationListQueryOptions: () => ({
		queryKey: ["os-chat-conversations", "list"],
		queryFn: async () => ({ conversations: apiHarness.conversations }),
		initialPageParam: undefined,
		getNextPageParam: () => undefined,
		enabled: true,
	}),
	conversationTitle: (conversation: { title?: string }) =>
		conversation.title ?? "New conversation",
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
		osWorkspaces: {
			workspaces: {
				create: apiHarness.createWorkspace,
				createFromConversation: apiHarness.createFromConversation,
			},
		},
	},
}));

vi.mock("@/lib/os-query-options", () => ({
	osQueryKeys: {
		workspaces: () => ["os-workspaces"],
		outputs: () => ["os-outputs"],
	},
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
	apiHarness.createFromConversation.mockReset();
	apiHarness.conversations = [];
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

	it("starts a fresh thread identity when New is chosen from an already new conversation", async () => {
		const host = await mountPage();
		const first = host.querySelector("[data-chat-thread]");
		await act(async () => chatHarness.onSelect?.(null));
		const second = host.querySelector("[data-chat-thread]");
		expect(second).not.toBe(first);
		await act(async () => chatHarness.onSelect?.(null));
		expect(host.querySelector("[data-chat-thread]")).not.toBe(second);
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

	it("creates no workspace when a new chat starts", async () => {
		await mountPage();
		// No preparation hook: the first send is a plain Home conversation.
		expect(chatHarness.prepareNewConversation).toBeNull();
		expect(chatHarness.onConversationPrepared).toBeNull();
		for (const id of ["one", "two", "three"]) {
			await act(async () =>
				chatHarness.onConversationCreated?.(`home:os:${id}`),
			);
		}
		expect(apiHarness.createWorkspace).not.toHaveBeenCalled();
		expect(routing.navigate).toHaveBeenLastCalledWith({
			to: "/chat",
			search: { conversation: "home:os:three" },
			replace: true,
		});
	});

	it("saves a workspace-less chat as a workspace and opens it there", async () => {
		routing.search = { conversation: CONVERSATION_ID };
		apiHarness.conversations = [
			{ id: CONVERSATION_ID, title: "Trip planning", workspaceId: null },
		];
		apiHarness.createFromConversation.mockResolvedValue({
			workspace: { id: WORKSPACE_ID },
			movedOutputIds: [],
		});
		const host = await mountPage();
		await act(async () => {
			await new Promise((resolve) => setTimeout(resolve, 0));
		});
		const button = Array.from(host.querySelectorAll("button")).find(
			(candidate) => candidate.textContent?.includes("Save as workspace"),
		);
		expect(button).toBeDefined();
		await act(async () => button?.click());
		expect(apiHarness.createFromConversation).toHaveBeenCalledWith({
			conversationId: CONVERSATION_ID,
			name: "Trip planning",
		});
		expect(routing.navigate).toHaveBeenLastCalledWith({
			to: "/workspace/$workspaceId",
			params: { workspaceId: WORKSPACE_ID },
			search: { conversation: CONVERSATION_ID },
		});
	});

	it("offers no save for a chat that already has a workspace", async () => {
		routing.search = { conversation: CONVERSATION_ID };
		apiHarness.conversations = [
			{ id: CONVERSATION_ID, title: "Linked", workspaceId: WORKSPACE_ID },
		];
		const host = await mountPage();
		await act(async () => {
			await new Promise((resolve) => setTimeout(resolve, 0));
		});
		expect(host.textContent).not.toContain("Save as workspace");
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
