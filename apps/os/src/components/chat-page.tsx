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

const WORKSPACE_NAME_MAX_WORDS = 5;
const WORKSPACE_NAME_MAX_CHARS = 40;
const LEADING_FILLER =
	/^(?:please|pls|hey|hi|hello|ok(?:ay)?|so|tedi|can you|could you|would you|will you|i want to|i'd like to|i would like to|i need to|i need|help me(?: to)?|let's|lets)\b[\s,:]*/i;

/** Where an unquoted "titled X" stops: the rest describes the content. */
const TITLE_END =
	/\s+(?:with|for|that|which|and|about|containing|including)\b|[,.;:!?]/i;

/**
 * A short workspace name for the first send of a new chat. The whole prompt
 * made a sentence-long workspace title; this keeps an explicit title
 * ("titled X", "called X", or quoted text) or else the first few words, with
 * polite lead-ins dropped. Deterministic, so no model call sits on the send.
 */
export function workspaceNameFromPrompt(prompt: string): string {
	const normalized = prompt.replace(/\s+/g, " ").trim();
	const quoted = normalized.match(/["“]([^"”]{2,})["”]/)?.[1];
	const titled = normalized
		.match(/\b(?:titled|called|named)\s+(.+)$/i)?.[1]
		?.split(TITLE_END)[0];
	let text = (quoted ?? titled ?? normalized).trim();
	for (let previous = ""; previous !== text;) {
		previous = text;
		text = text.replace(LEADING_FILLER, "");
	}
	const words = text.split(" ").filter(Boolean);
	let name = words.slice(0, WORKSPACE_NAME_MAX_WORDS).join(" ");
	if (name.length > WORKSPACE_NAME_MAX_CHARS) {
		const cut = name.slice(0, WORKSPACE_NAME_MAX_CHARS);
		const space = cut.lastIndexOf(" ");
		name = space > 10 ? cut.slice(0, space) : cut;
	}
	name = name.replace(/[\s.,;:!?…-]+$/u, "");
	if (!name) return "New conversation";
	return name.charAt(0).toUpperCase() + name.slice(1);
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
	const [newConversationKey, setNewConversationKey] = useState(0);

	const selectConversation = (conversationId: string | null) => {
		if (conversationId === null) setNewConversationKey((key) => key + 1);
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
					key={newConversationKey}
					conversationId={activeConversationId}
					prepareNewConversation={async (content) => {
						const name = workspaceNameFromPrompt(content);
						const description =
							"Started from chat. Documents, sheets and decks from this conversation appear here.";
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
