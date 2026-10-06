import { useQueryClient } from "@tanstack/react-query";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { useState } from "react";
import {
	CHAT_CONVERSATIONS_QUERY_KEY,
	ChatConversationHeader,
	ChatSidebar,
} from "@/components/chat-sidebar";
import { ChatThread } from "@/components/chat-thread";
import { useChatWebMcpTools } from "@/components/chat-webmcp-tools";
import { Page } from "@/components/kumo/page";
import { osApi } from "@/lib/api";
import type { ChatSearch } from "@/lib/canvas-search";
import {
	activeWorkspacesQueryOptions,
	osQueryKeys,
} from "@/lib/os-query-options";

export function workspaceNameFromPrompt(prompt: string): string {
	const normalized = prompt.replace(/\s+/g, " ").trim();
	if (!normalized) return "New conversation";
	if (normalized.length <= 72) return normalized;
	return `${normalized.slice(0, 69).trimEnd()}…`;
}

export function workspaceRetryName(name: string, suffix: string): string {
	return `${name.slice(0, 61).trimEnd()} · ${suffix.slice(0, 8)}`;
}

/**
 * The Chat surface: kernel Home conversations with tedis as the agents.
 *
 * Selection is the URL — `/chat?conversation=<id>` — so a thread is a
 * shareable, reloadable link (the embedded widget deep-links here) and
 * picking one from the list is a `replace`, never a history entry per click.
 * No param is the synthetic fresh-thread state: landing on `/chat` lands on a
 * new conversation, not on whichever thread happened to be most recent. The
 * first substantive send creates its durable Workspace, the conversation
 * comes to exist server-side on the first enqueued turn, and the accepted
 * pair is opened in the Workspace workbench so Chat, Outputs, and Gadgets
 * share one context from the beginning.
 */
export function ChatPage() {
	const queryClient = useQueryClient();
	const navigate = useNavigate();
	const search: ChatSearch = useSearch({ from: "/_session/_tenant/chat" });
	const activeConversationId = search.conversation ?? null;
	useChatWebMcpTools();
	const [mobileListOpen, setMobileListOpen] = useState(false);

	const selectConversation = (conversationId: string | null) => {
		setMobileListOpen(false);
		void navigate({
			to: "/chat",
			search: conversationId ? { conversation: conversationId } : {},
			replace: true,
		});
	};

	return (
		<Page
			fullHeight
			width="bleed"
			className="flex min-h-0 flex-1 flex-col gap-0 md:flex-row md:gap-4"
		>
			<aside
				data-slot="chat-conversation-directory"
				className={`${mobileListOpen ? "block" : "hidden"} min-h-0 flex-1 overflow-y-auto md:block md:max-h-none md:w-72 md:flex-none md:border-r md:border-kumo-line md:pr-3`}
			>
				<ChatSidebar
					activeConversationId={activeConversationId}
					onSelect={selectConversation}
				/>
			</aside>
			<div
				data-slot="chat-active-conversation"
				className={`${mobileListOpen ? "hidden" : "flex"} min-h-0 min-w-0 flex-1 flex-col md:flex`}
			>
				<div className="flex h-12 shrink-0 items-center border-kumo-line border-b md:hidden">
					<ChatConversationHeader
						conversationId={activeConversationId}
						onBack={() => setMobileListOpen(true)}
						onDeleted={() => {
							selectConversation(null);
							setMobileListOpen(true);
						}}
					/>
				</div>
				<ChatThread
					conversationId={activeConversationId}
					prepareNewConversation={async (content) => {
						const name = workspaceNameFromPrompt(content);
						const description =
							"Created from a Tedix OS conversation. Gadgets and outputs appear here as the work develops.";
						let workspace;
						try {
							({ workspace } = await osApi.osWorkspaces.workspaces.create({
								name,
								description,
							}));
						} catch (error) {
							if (
								!(error instanceof Error) ||
								!error.message.includes(
									"workspace with this name already exists",
								)
							) {
								throw error;
							}
							({ workspace } = await osApi.osWorkspaces.workspaces.create({
								name: workspaceRetryName(name, crypto.randomUUID()),
								description,
							}));
						}
						// Canvas resolves the route workspace from this cached directory.
						// Seed the authoritative create response before navigating so a
						// warm, stale list cannot briefly select and canonicalize the first
						// unrelated workspace while its background refresh catches up.
						queryClient.setQueryData(
							activeWorkspacesQueryOptions().queryKey,
							(current) =>
								current
									? {
											...current,
											items: [
												workspace,
												...current.items.filter(
													(item) => item.id !== workspace.id,
												),
											],
										}
									: { items: [workspace], truncated: false },
						);
						// The create response is already authoritative for this workspace.
						// Revalidating the directory is useful, but it must not sit on the
						// first-send critical path: a cold list read used to delay the
						// workspace handoff until the answer was nearly complete.
						void queryClient.invalidateQueries({
							queryKey: osQueryKeys.workspaces(),
						});
						return { workspaceId: workspace.id };
					}}
					onConversationPrepared={(conversationId, workspaceId) => {
						void navigate({
							to: "/workspace/$workspaceId",
							params: { workspaceId },
							search: { conversation: conversationId },
						});
					}}
					onConversationCreated={(conversationId, workspaceId) => {
						queryClient.invalidateQueries({
							queryKey: CHAT_CONVERSATIONS_QUERY_KEY,
						});
						// The workspace opens chat-only (`simpleMode`) until its first
						// document arrives. `pane` is a mobile/override param and must
						// not travel here: carrying it would pin the URL to an explicit
						// pane and defeat the chat-first layout.
						if (workspaceId) {
							void navigate({
								to: "/workspace/$workspaceId",
								params: { workspaceId },
								search: { conversation: conversationId },
							});
							return;
						}
						selectConversation(conversationId);
					}}
				/>
			</div>
		</Page>
	);
}
