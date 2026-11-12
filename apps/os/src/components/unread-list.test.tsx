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

import { UnreadList, unreadItemHref, unreadItemLabel } from "./unread-list";

(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
const cleanups: (() => void)[] = [];
afterEach(() => {
	for (const cleanup of cleanups.splice(0)) cleanup();
	for (const mock of Object.values(unreadApi)) mock.mockReset();
});

const message = {
	id: "9",
	kind: "message" as const,
	byAgent: false,
	actorId: "person-b",
	occurredAt: "2026-11-12T10:00:00.000Z",
	conversationId: "00000000-0000-4000-8000-0000000000c1",
	turnId: "turn-9",
};
const file = {
	id: "8",
	kind: "file" as const,
	byAgent: true,
	actorId: "tedi-1",
	occurredAt: "2026-11-12T09:00:00.000Z",
	outputId: "00000000-0000-4000-8000-0000000000f1",
	title: "Launch plan",
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
				<UnreadList />
			</QueryClientProvider>,
		);
	});
	await settle();
	return host;
}

describe("unread list", () => {
	it("opens a chat row in its conversation and a file row on the file", () => {
		expect(unreadItemHref("ws-1", message)).toBe(
			"/workspace/ws-1?conversation=00000000-0000-4000-8000-0000000000c1&pane=chat",
		);
		expect(unreadItemHref("ws-1", file)).toBe(
			"/workspace/ws-1?workpiece=output%3A00000000-0000-4000-8000-0000000000f1&pane=workpiece",
		);
		expect(unreadItemLabel(file)).toBe("Launch plan was changed");
		expect(unreadItemLabel({ ...message, kind: "needs_decision" })).toBe(
			"An agent is waiting for your decision",
		);
	});

	it("groups rows by workspace, labels agent work, and marks everything read", async () => {
		unreadApi.list.mockResolvedValue({
			total: 2,
			groups: [
				{
					workspaceId: "ws-1",
					workspaceName: "Launch",
					latestAt: message.occurredAt,
					items: [message, file],
				},
			],
		});
		unreadApi.markAllRead.mockResolvedValue({ ok: true });
		const host = await render();
		const section = host.querySelector("section");
		expect(section?.getAttribute("aria-label")).toBe("Launch: 2 unread");
		const rows = [...host.querySelectorAll("li")];
		expect(rows.map((row) => row.textContent)).toEqual([
			expect.stringContaining("New chat message"),
			expect.stringMatching(/Launch plan was changed.*Agent/),
		]);
		expect(rows[0]?.textContent).not.toContain("Agent");
		unreadApi.list.mockResolvedValue({ total: 0, groups: [] });
		const button = [...host.querySelectorAll("button")].find(
			(element) => element.textContent === "Mark all read",
		);
		await act(async () => {
			button?.click();
		});
		await settle();
		expect(unreadApi.markAllRead).toHaveBeenCalledTimes(1);
		expect(host.textContent).toContain("You're all caught up");
	});

	it("says so when the list cannot be loaded instead of showing it as empty", async () => {
		unreadApi.list.mockRejectedValue(new Error("offline"));
		const host = await render();
		expect(host.textContent).toContain("Unread items could not be loaded.");
		expect(host.textContent).not.toContain("caught up");
	});
});
