/**
 * Chats with a picked tedi run on the person's private workspace, over the
 * workspace chat connection, instead of the Home queue. In the /chat list and
 * URL such a conversation is `ws:{workspaceId}:{conversationId}`; Home
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

/**
 * The private workspace's conversations with a tedi as rows of the /chat
 * list. Runs an agent started are left out: they are not the person's chats.
 */
export function tediChatListRows(
	workspaceId: string,
	organizationId: string,
	conversations: readonly ConversationSummary[],
): HomeConversation[] {
	return conversations
		.filter(
			(conversation) =>
				conversation.tediId &&
				!conversation.startedBy &&
				!conversation.archivedAt,
		)
		.map((conversation) => ({
			id: tediChatConversationId(workspaceId, conversation.id),
			organizationId,
			title: conversation.title,
			status: "active" as const,
			createdAt: conversation.updatedAt,
			updatedAt: conversation.lastTurnAt ?? conversation.updatedAt,
			lastMessageAt: conversation.lastTurnAt,
		}));
}
