import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

const unreadApi = vi.hoisted(() => ({
	summary: vi.fn(),
	list: vi.fn(),
	workspace: vi.fn(),
	markRead: vi.fn(),
	markAllRead: vi.fn(),
}));
vi.mock("@/lib/api", () => ({ osApi: { workspaceUnread: unreadApi } }));

import { unreadRowPreview, unreadRows } from "./unread-list";
import { UnreadPage } from "./unread-page";

(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
const cleanups: (() => void)[] = [];
afterEach(() => {
	for (const cleanup of cleanups.splice(0)) cleanup();
	for (const mock of Object.values(unreadApi)) mock.mockReset();
});

const LAUNCH = "00000000-0000-4000-8000-0000000000a1";
const OPS = "00000000-0000-4000-8000-0000000000a2";
const CONVERSATION = "00000000-0000-4000-8000-0000000000c1";
const reply = {
	id: "12",
	kind: "agent_reply" as const,
	byAgent: true,
	actorId: "tedi-1",
	occurredAt: "2026-11-12T10:00:00.000Z",
	conversationId: CONVERSATION,
};
const message = {
	id: "11",
	kind: "message" as const,
	byAgent: false,
	actorId: "person-b",
	occurredAt: "2026-11-12T09:30:00.000Z",
	conversationId: CONVERSATION,
};
const file = {
	id: "8",
	kind: "file" as const,
	byAgent: false,
	actorId: "person-b",
	occurredAt: "2026-11-12T09:00:00.000Z",
	outputId: "00000000-0000-4000-8000-0000000000f1",
	title: "Launch plan",
};
const opsFile = { ...file, id: "3", byAgent: true, title: "Runbook" };
const twoWorkspaces = {
	total: 4,
	groups: [
		{
			workspaceId: LAUNCH,
			workspaceName: "Launch",
			latestAt: reply.occurredAt,
			items: [reply, message, file],
		},
		{
			workspaceId: OPS,
			workspaceName: "Ops",
			latestAt: opsFile.occurredAt,
			items: [opsFile],
		},
	],
};

async function settle() {
	await act(async () => {
		await new Promise((done) => setTimeout(done, 20));
	});
}

async function render() {
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
				<UnreadPage />
			</QueryClientProvider>,
		);
	});
	await settle();
	return host;
}

function button(host: HTMLElement, name: string) {
	const found = [...host.querySelectorAll("button")].find(
		(element) =>
			element.textContent === name ||
			element.getAttribute("aria-label") === name,
	);
	expect(found, name).toBeDefined();
	return found!;
}

describe("unread rows", () => {
	it("shows one row per conversation and per file, newest first", () => {
		const rows = unreadRows([reply, message, file]);
		expect(rows).toEqual([
			{ item: reply, count: 2 },
			{ item: file, count: 1 },
		]);
		expect(rows.map(unreadRowPreview)).toEqual([
			"Conversation · 2 new",
			"File · changed by a teammate",
		]);
		expect(unreadRowPreview({ item: opsFile, count: 1 })).toBe(
			"File · changed by an agent",
		);
	});

	it("keeps chat items apart when they name no conversation", () => {
		const loose = { ...message, conversationId: undefined };
		expect(unreadRows([loose, { ...loose, id: "10" }])).toHaveLength(2);
	});
});

describe("Inbox page", () => {
	it("lists unread conversations and changed files per workspace with a second line", async () => {
		unreadApi.list.mockResolvedValue(twoWorkspaces);
		const host = await render();
		expect(host.querySelector("h1")?.textContent).toBe("Inbox");
		const sections = [...host.querySelectorAll("section[aria-label]")];
		expect(sections.map((node) => node.getAttribute("aria-label"))).toEqual([
			"Launch: 3 unread",
			"Ops: 1 unread",
		]);
		const rows = [...sections[0]!.querySelectorAll("li")];
		expect(rows).toHaveLength(2);
		expect(rows[0]!.textContent).toContain("An agent replied in chat");
		expect(rows[0]!.textContent).toContain("Conversation · 2 new");
		expect(rows[0]!.querySelector("a")?.getAttribute("href")).toBe(
			`/workspace/${LAUNCH}?conversation=${CONVERSATION}&pane=chat`,
		);
		expect(rows[1]!.textContent).toContain("Launch plan was changed");
		expect(rows[1]!.textContent).toContain("File · changed by a teammate");
		expect(sections[1]!.textContent).toContain("Runbook was changed");
	});

	it("marks one workspace as read and keeps the others", async () => {
		unreadApi.list.mockResolvedValue(twoWorkspaces);
		unreadApi.markRead.mockResolvedValue({
			workspaceId: LAUNCH,
			chat: 0,
			files: 0,
			total: 0,
			fileIds: [],
			notifyingConversationIds: [],
			conversations: [],
		});
		const host = await render();
		unreadApi.list.mockResolvedValue({
			total: 1,
			groups: [twoWorkspaces.groups[1]],
		});
		await act(async () => button(host, "Mark Launch as read").click());
		await settle();
		expect(unreadApi.markRead.mock.calls[0]![0]).toEqual({
			workspaceId: LAUNCH,
			target: { type: "all" },
		});
		expect(unreadApi.markAllRead).not.toHaveBeenCalled();
		expect(
			[...host.querySelectorAll("section[aria-label]")].map((node) =>
				node.getAttribute("aria-label"),
			),
		).toEqual(["Ops: 1 unread"]);
	});

	it("marks everything as read and then says All caught up", async () => {
		unreadApi.list.mockResolvedValue(twoWorkspaces);
		unreadApi.markAllRead.mockResolvedValue({ ok: true });
		const host = await render();
		expect(host.textContent).toContain("4 unread");
		unreadApi.list.mockResolvedValue({ total: 0, groups: [] });
		await act(async () => button(host, "Mark all as read").click());
		await settle();
		expect(unreadApi.markAllRead).toHaveBeenCalledTimes(1);
		expect(host.textContent).toContain("All caught up");
		expect(host.querySelector("section[aria-label]")).toBeNull();
	});

	it("says All caught up when nothing is unread", async () => {
		unreadApi.list.mockResolvedValue({ total: 0, groups: [] });
		const host = await render();
		expect(host.textContent).toContain("All caught up");
		expect(
			[...host.querySelectorAll("button")].map((node) => node.textContent),
		).not.toContain("Mark all as read");
	});

	it("offers another try when the list cannot be loaded", async () => {
		unreadApi.list.mockRejectedValue(new Error("offline"));
		const host = await render();
		expect(host.textContent).toContain("Unread items could not be loaded.");
		unreadApi.list.mockResolvedValue({ total: 0, groups: [] });
		await act(async () => button(host, "Try again").click());
		await settle();
		expect(host.textContent).toContain("All caught up");
	});
});
