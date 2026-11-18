import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

const unreadApi = vi.hoisted(() => ({ summary: vi.fn(), list: vi.fn() }));
const push = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", () => ({ osApi: { workspaceUnread: unreadApi } }));
vi.mock("@tanstack/react-router", async (original) => ({
	...(await original<typeof import("@tanstack/react-router")>()),
	useRouter: () => ({ history: { push } }),
	useRouterState: () => "/work",
}));

import { osToastManager, Toaster } from "@/components/kumo/toast";
import { osQuery } from "@/lib/os-query-options";
import {
	noteChatAsked,
	resetWorkspaceToasts,
	showConversationOnScreen,
} from "@/lib/workspace-toasts";
import { WorkspaceToasts } from "./workspace-toasts";

(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
const WS = "00000000-0000-4000-8000-0000000000a1";
const CHAT = "00000000-0000-4000-8000-0000000000c1";
const cleanups: (() => void)[] = [];
afterEach(() => {
	osToastManager.close();
	for (const cleanup of cleanups.splice(0)) cleanup();
	for (const mock of [unreadApi.summary, unreadApi.list, push])
		mock.mockReset();
	resetWorkspaceToasts();
});

async function settle() {
	await act(async () => {
		await new Promise((done) => setTimeout(done, 20));
	});
}

type Kind = "agent_reply" | "needs_decision";
/** What the server reports as unread: one chat event per entry. */
function unread(...events: Array<[id: string, kind: Kind]>) {
	const some = events.length > 0;
	unreadApi.summary.mockResolvedValue({
		total: events.length,
		workspaces: some
			? [
					{
						workspaceId: WS,
						chat: events.length,
						files: 0,
						total: events.length,
					},
				]
			: [],
	});
	unreadApi.list.mockResolvedValue({
		total: events.length,
		groups: some
			? [
					{
						workspaceId: WS,
						workspaceName: "Launch plan",
						latestAt: "2026-11-18T10:00:00.000Z",
						items: events.map(([id, kind]) => ({
							id,
							kind,
							byAgent: true,
							actorId: "tedi-1",
							occurredAt: "2026-11-18T10:00:00.000Z",
							conversationId: CHAT,
						})),
					},
				]
			: [],
	});
}

async function mount() {
	const host = document.createElement("div");
	document.body.append(host);
	const root = createRoot(host);
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	cleanups.push(() => {
		act(() => root.unmount());
		host.remove();
	});
	await act(async () => {
		root.render(
			<QueryClientProvider client={client}>
				<Toaster />
				<WorkspaceToasts />
			</QueryClientProvider>,
		);
	});
	await settle();
	/** The shell's next look at the unread counts. */
	const recheck = async () => {
		await act(async () => {
			await client.invalidateQueries({
				queryKey: osQuery.workspaceUnread.summary.key(),
			});
		});
		await settle();
	};
	return { recheck };
}

const titles = () =>
	[...document.querySelectorAll("[data-toast-title]")].map(
		(title) => title.textContent,
	);
const button = (name: string) =>
	[...document.querySelectorAll("button")].find(
		(candidate) => candidate.textContent === name,
	);

describe("WorkspaceToasts", () => {
	it("announces the reply the person asked for, with a button that opens the conversation", async () => {
		unread();
		const { recheck } = await mount();
		expect(titles()).toEqual([]);

		noteChatAsked(WS, CHAT);
		unread(["7", "agent_reply"]);
		await recheck();
		expect(titles()).toEqual(["Launch plan: reply ready"]);

		const open = button("Open");
		expect(open).toBeDefined();
		await act(async () => {
			open?.click();
		});
		expect(push).toHaveBeenCalledWith(
			`/workspace/${WS}?conversation=${CHAT}&pane=chat`,
		);
	});

	it("announces an approval request with a Review button, once", async () => {
		unread();
		const { recheck } = await mount();
		unread(["9", "needs_decision"]);
		await recheck();
		expect(titles()).toEqual(["Launch plan: needs your approval"]);
		expect(button("Review")).toBeDefined();

		// Another event arrives; the first one is not announced again.
		unread(["9", "needs_decision"], ["7", "agent_reply"]);
		await recheck();
		expect(titles()).toEqual(["Launch plan: needs your approval"]);
		expect(unreadApi.list).toHaveBeenCalledTimes(2);
	});

	it("does not announce what was already unread when the page loaded", async () => {
		noteChatAsked(WS, CHAT);
		unread(["7", "agent_reply"], ["9", "needs_decision"]);
		const { recheck } = await mount();
		await recheck();
		expect(titles()).toEqual([]);
	});

	it("stays quiet about the conversation on screen", async () => {
		unread();
		const { recheck } = await mount();
		noteChatAsked(WS, CHAT);
		showConversationOnScreen({ workspaceId: WS, conversationId: CHAT });
		unread(["7", "agent_reply"], ["9", "needs_decision"]);
		await recheck();
		expect(titles()).toEqual([]);
	});
});
