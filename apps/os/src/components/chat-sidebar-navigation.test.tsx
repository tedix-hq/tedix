// @vitest-environment happy-dom

import type { HomeConversation } from "@tedix/api-contract/schemas/kernel-runtime";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

const listConversations = vi.hoisted(() => vi.fn());

vi.mock("@/lib/api", () => ({
	osApi: { kernelRuntime: { listConversations } },
}));

import {
	ChatConversationHeader,
	ChatSidebar,
	conversationListQueryOptions,
} from "./chat-sidebar";

(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";
const CONVERSATION_ID = "home:os:cache-safe";
const CONVERSATION: HomeConversation = {
	id: CONVERSATION_ID,
	organizationId: "33333333-3333-4333-8333-333333333333",
	title: "Cache-safe navigation",
	status: "active",
	channel: "home",
	lastMessageAt: "2026-08-30T20:00:00.000Z",
	messageCount: 2,
	createdAt: "2026-08-30T19:00:00.000Z",
	updatedAt: "2026-08-30T20:00:00.000Z",
	pinnedAt: null,
	origin: "human",
};

let cleanup: (() => Promise<void>) | undefined;

afterEach(async () => {
	await cleanup?.();
	cleanup = undefined;
	listConversations.mockReset();
});

function BackNavigationHarness() {
	const [showList, setShowList] = useState(false);
	return showList ? (
		<ChatSidebar
			activeConversationId={CONVERSATION_ID}
			workspaceId={WORKSPACE_ID}
			onSelect={() => {}}
		/>
	) : (
		<ChatConversationHeader
			conversationId={CONVERSATION_ID}
			workspaceId={WORKSPACE_ID}
			onBack={() => setShowList(true)}
			onDeleted={() => {}}
		/>
	);
}

describe("workspace conversation back-navigation", () => {
	it("keeps one infinite cache shape while switching from the header to the list", async () => {
		listConversations.mockResolvedValue({
			conversations: [CONVERSATION],
			nextCursor: null,
		});
		const client = new QueryClient({
			defaultOptions: { queries: { retry: false } },
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
					<BackNavigationHarness />
				</QueryClientProvider>,
			);
			await new Promise((resolve) => setTimeout(resolve, 20));
		});
		expect(listConversations).toHaveBeenCalledTimes(1);
		await act(async () => {
			await vi.waitFor(() => {
				expect(host.textContent).toContain("Cache-safe navigation");
			});
		});
		expect(
			client.getQueryData(conversationListQueryOptions(WORKSPACE_ID).queryKey),
		).toMatchObject({ pages: [{ conversations: [CONVERSATION] }] });

		await act(async () => {
			(
				host.querySelector(
					'[aria-label="Back to conversations"]',
				) as HTMLButtonElement
			).click();
		});

		expect(host.textContent).toContain("Conversations");
		expect(host.textContent).toContain("Cache-safe navigation");
		expect(
			client.getQueryData(conversationListQueryOptions(WORKSPACE_ID).queryKey),
		).toMatchObject({ pages: [{ conversations: [CONVERSATION] }] });
		expect(listConversations).toHaveBeenCalledWith({
			limit: 50,
			workspaceId: WORKSPACE_ID,
			includeArchived: false,
		});
	});
});
