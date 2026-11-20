// @vitest-environment happy-dom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, type ReactNode } from "react";
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
	onTediConversationCreated: null as null | ((conversationId: string) => void),
}));

const apiHarness = vi.hoisted(() => ({
	createFromConversation: vi.fn(),
	readConversation: vi.fn(),
	personal: { workspace: null, created: false } as {
		workspace: { id: string; organizationId: string } | null;
		created: boolean;
	},
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
		workspaceId,
		detailsActions,
	}: {
		conversationId: string | null;
		workspaceId?: string;
		detailsActions?: ReactNode;
	}) => (
		<div
			data-chat-thread={conversationId ?? "new"}
			data-workspace-id={workspaceId}
		>
			{detailsActions}
			Chat thread
		</div>
	),
}));

vi.mock("@/components/chat-tedi-thread", () => ({
	ChatTediListFeed: () => null,
	ChatTediThread: ({
		workspaceId,
		conversationId,
		onConversationCreated,
	}: {
		workspaceId: string;
		conversationId: string | null;
		onConversationCreated: (conversationId: string) => void;
	}) => {
		chatHarness.onTediConversationCreated = onConversationCreated;
		return (
			<div
				data-tedi-thread={conversationId ?? "new"}
				data-workspace-id={workspaceId}
			/>
		);
	},
}));

vi.mock("@/lib/use-tedi-names", () => ({
	useTediProfiles: () => ({}),
}));

vi.mock("@/components/chat-webmcp-tools", () => ({
	useChatWebMcpTools: () => undefined,
}));

vi.mock("@/lib/api", () => ({
	osApi: {
		osWorkspaces: {
			workspaces: {
				createFromConversation: apiHarness.createFromConversation,
				personal: async () => apiHarness.personal,
			},
		},
	},
}));

vi.mock("@/lib/os-query-options", () => ({
	osQuery: {
		osWorkspaces: {
			workspaces: {
				personal: {
					queryKey: () => ["personal-workspace"],
					queryOptions: () => ({
						queryKey: ["personal-workspace"],
						queryFn: async () => apiHarness.personal,
						enabled: true,
					}),
				},
			},
		},
		kernelRuntime: {
			listConversations: {
				queryOptions: ({ input }: { input: { conversationId: string } }) => ({
					queryKey: ["exact-conversation", input],
					queryFn: () => apiHarness.readConversation(input),
				}),
			},
		},
	},
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
	apiHarness.personal = {
		workspace: { id: WORKSPACE_ID, organizationId: "org-1" },
		created: false,
	};
	apiHarness.readConversation.mockReset();
	apiHarness.readConversation.mockImplementation(
		async ({ conversationId }: { conversationId: string }) => ({
			conversations: [
				apiHarness.conversations.find((row) => row.id === conversationId) ?? {
					id: conversationId,
					workspaceId: null,
				},
			],
		}),
	);
});

afterEach(async () => {
	await cleanup?.();
	cleanup = undefined;
	chatHarness.onSelect = null;
	window.sessionStorage.clear();
	apiHarness.createFromConversation.mockReset();
	apiHarness.conversations = [];
	apiHarness.personal = { workspace: null, created: false };
	chatHarness.onTediConversationCreated = null;
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
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 0));
	});
	return host;
}

function activeThread(host: HTMLElement): string | null | undefined {
	return host
		.querySelector("[data-chat-thread]")
		?.getAttribute("data-chat-thread");
}

function newThread(host: HTMLElement): HTMLElement | null {
	return host.querySelector('[data-tedi-thread="new"]');
}

describe("ChatPage responsive conversation navigation", () => {
	it("shows one mobile pane at a time while keeping both panes available on desktop", async () => {
		routing.search = { conversation: CONVERSATION_ID };
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
	it("lands on a new chat in the private workspace when the URL names no thread", async () => {
		const host = await mountPage();
		// Never a stale auto-selected thread: no param means a fresh thread,
		// and a fresh thread runs in the private workspace, not on Home.
		expect(newThread(host)?.dataset.workspaceId).toBe(WORKSPACE_ID);
		expect(activeThread(host)).toBeUndefined();
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

	it("uses the persisted conversation workspace for the same chat opened on /chat", async () => {
		routing.search = { conversation: CONVERSATION_ID };
		apiHarness.conversations = [
			{ id: CONVERSATION_ID, workspaceId: WORKSPACE_ID },
		];
		const host = await mountPage();
		await vi.waitFor(() =>
			expect(
				host
					.querySelector("[data-chat-thread]")
					?.getAttribute("data-workspace-id"),
			).toBe(WORKSPACE_ID),
		);
		await act(async () => chatHarness.onSelect?.(null));
		expect(activeThread(host)).toBeUndefined();
		expect(newThread(host)).not.toBeNull();
	});

	it.each(["older", "archived"])(
		"resolves a %s deep link outside the visible conversation page",
		async () => {
			routing.search = { conversation: CONVERSATION_ID };
			apiHarness.conversations = Array.from({ length: 50 }, (_, i) => ({
				id: `home:new-${i}`,
				workspaceId: null,
			}));
			apiHarness.readConversation.mockResolvedValue({
				conversations: [{ id: CONVERSATION_ID, workspaceId: WORKSPACE_ID }],
			});
			const host = await mountPage();
			expect(apiHarness.readConversation).toHaveBeenCalledWith({
				conversationId: CONVERSATION_ID,
				includeArchived: true,
				limit: 1,
			});
			expect(
				host
					.querySelector("[data-chat-thread]")
					?.getAttribute("data-workspace-id"),
			).toBe(WORKSPACE_ID);
		},
	);

	it("does not mount a composer until the exact association lookup finishes", async () => {
		routing.search = { conversation: CONVERSATION_ID };
		let resolve!: (value: unknown) => void;
		apiHarness.readConversation.mockReturnValue(
			new Promise((done) => {
				resolve = done;
			}),
		);
		const host = await mountPage();
		expect(
			host.querySelector('[aria-label="Loading conversation"]'),
		).not.toBeNull();
		expect(host.querySelector("[data-chat-thread]")).toBeNull();
		await act(async () =>
			resolve({
				conversations: [{ id: CONVERSATION_ID, workspaceId: WORKSPACE_ID }],
			}),
		);
		await vi.waitFor(() =>
			expect(
				host
					.querySelector("[data-chat-thread]")
					?.getAttribute("data-workspace-id"),
			).toBe(WORKSPACE_ID),
		);
	});

	it.each(["missing", "denied"])(
		"does not mount an unscoped composer for a %s conversation",
		async (state) => {
			routing.search = { conversation: CONVERSATION_ID };
			if (state === "missing")
				apiHarness.readConversation.mockResolvedValue({ conversations: [] });
			else
				apiHarness.readConversation.mockRejectedValue(
					Object.assign(new Error("Access denied"), { code: "FORBIDDEN" }),
				);
			const host = await mountPage();
			expect(host.textContent).toContain(
				"This conversation couldn't be loaded",
			);
			expect(host.querySelector("[data-chat-thread]")).toBeNull();
		},
	);

	it("does not borrow a different conversation's workspace for a global chat", async () => {
		routing.search = { conversation: CONVERSATION_ID };
		apiHarness.conversations = [
			{ id: CONVERSATION_ID, workspaceId: null },
			{ id: "home:other", workspaceId: WORKSPACE_ID },
		];
		const host = await mountPage();
		expect(
			host
				.querySelector("[data-chat-thread]")
				?.hasAttribute("data-workspace-id"),
		).toBe(false);
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
		const first = newThread(host);
		await act(async () => chatHarness.onSelect?.(null));
		const second = newThread(host);
		expect(second).not.toBeNull();
		expect(second).not.toBe(first);
	});

	it("clears the old conversation before New navigation finishes", async () => {
		routing.search = { conversation: CONVERSATION_ID };
		routing.navigate.mockReturnValue(new Promise(() => {}));
		const host = await mountPage();
		await act(async () => chatHarness.onSelect?.(null));
		expect(activeThread(host)).toBeUndefined();
		expect(newThread(host)).not.toBeNull();
		expect(routing.search.conversation).toBe(CONVERSATION_ID);
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
});

describe("ChatPage new chat in the private workspace", () => {
	it("links the first message's conversation as a ws: conversation", async () => {
		const host = await mountPage();
		await act(async () => chatHarness.onTediConversationCreated?.("c1"));
		expect(routing.navigate).toHaveBeenCalledWith({
			to: "/chat",
			search: { conversation: `ws:${WORKSPACE_ID}:c1` },
			replace: true,
		});
		expect(
			host
				.querySelector("[data-tedi-thread]")
				?.getAttribute("data-tedi-thread"),
		).toBe("c1");
	});
});
