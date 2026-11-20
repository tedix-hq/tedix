/**
 * New /chat conversations run on the person's private workspace, over the
 * workspace chat connection, instead of the Home queue. In the /chat list and
 * URL such a conversation is `ws:{workspaceId}:{conversationId}`; older Home
 * conversations keep their `home:os:…` ids and their own path.
 */
import type { HomeConversation } from "@tedix/api-contract/schemas/kernel-runtime";
import type { ConversationSummary } from "./workspace-chat-protocol";

const TEDI_CHAT_ID = /^ws:([0-9a-f-]{36}):([A-Za-z0-9_-]{1,48})$/i;

export function tediChatConversationId(
	workspaceId: string,
	conversationId: string,
): string {
	return `ws:${workspaceId}:${conversationId}`;
}

export function parseTediChatConversationId(
	value: string | null | undefined,
): { workspaceId: string; conversationId: string } | null {
	const match = value ? TEDI_CHAT_ID.exec(value) : null;
	return match?.[1] && match[2]
		? { workspaceId: match[1], conversationId: match[2] }
		: null;
}

/** Who a /chat list row names as answering: a tedi, or the workspace agent (id null). */
export interface TediChatRowTedi {
	id: string | null;
	name: string;
	avatar: string | null;
}

export type TediChatListRow = HomeConversation & { tedi: TediChatRowTedi };

/**
 * The private workspace's conversations as rows of the /chat list, each
 * naming the tedi that answered last, or the workspace agent. Runs an agent
 * started are left out: they are not the person's chats.
 */
export function tediChatListRows(
	workspaceId: string,
	organizationId: string,
	conversations: readonly ConversationSummary[],
	tedis: Readonly<Record<string, { name: string; avatar: string | null }>>,
): TediChatListRow[] {
	return conversations.flatMap((conversation) =>
		!conversation.startedBy && !conversation.archivedAt
			? [
					{
						id: tediChatConversationId(workspaceId, conversation.id),
						organizationId,
						title: conversation.title,
						status: "active" as const,
						createdAt: conversation.updatedAt,
						updatedAt: conversation.lastTurnAt ?? conversation.updatedAt,
						lastMessageAt: conversation.lastTurnAt,
						tedi: conversation.tediId
							? {
									id: conversation.tediId,
									name: tedis[conversation.tediId]?.name ?? "Agent",
									avatar: tedis[conversation.tediId]?.avatar ?? null,
								}
							: { id: null, name: "Workspace agent", avatar: null },
					},
				]
			: [],
	);
}
