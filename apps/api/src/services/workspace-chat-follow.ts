/**
 * Which workspace chats a person gets notifications for.
 *
 * Notifications for a chat start when the person first takes part in it:
 * they post there or are mentioned there. Posts are read from the workspace
 * activity feed the first time a workspace is looked at and each time the
 * person opens it, and kept in `@tedix/db/queries/workspace-chat-follow`. A
 * person can also turn one chat on or off; that choice outlasts taking part.
 */

import {
	joinWorkspaceChats,
	listWorkspaceChatFollowSyncs,
	listWorkspaceChatFollows,
	saveWorkspaceChatFollowSync,
} from "@tedix/db/queries/workspace-chat-follow";
import {
	listWorkspaceFeedPositions,
	listWorkspaceUnreadFeed,
	type WorkspaceUnreadScope,
} from "@tedix/db/queries/workspace-unread";
import type { DbQueryClient } from "@tedix/db/query-client";
import {
	chatsTakenPartIn,
	type WorkspaceChatFollows,
} from "./workspace-unread";

/** How far back in a workspace's feed a person's own posts are looked for. */
export const CHAT_FOLLOW_FEED_WINDOW = 10_000;

export interface ChatFollowReader {
	scope: WorkspaceUnreadScope;
	/** Every id the person is recorded under in the feed. */
	readerIds: readonly string[];
}

/**
 * Record the chats the person posted in since the last time this ran for
 * the workspace. `syncedSeq` is where that was, or null when it never ran.
 */
export async function recordChatsTakenPartIn(
	db: DbQueryClient,
	reader: ChatFollowReader,
	workspaceId: string,
	input: { position: number; syncedSeq: number | null },
): Promise<void> {
	const { scope } = reader;
	const { syncedSeq } = input;
	if (syncedSeq !== null && syncedSeq >= input.position) return;
	const chats = chatsTakenPartIn(
		await listWorkspaceUnreadFeed(db, {
			organizationId: scope.organizationId,
			workspaceId,
			afterSeq: Math.max(
				syncedSeq ?? 0,
				input.position - CHAT_FOLLOW_FEED_WINDOW,
			),
			readerIds: reader.readerIds,
			own: true,
			runsOnly: true,
		}),
	);
	if (chats.length > 0) await joinWorkspaceChats(db, scope, workspaceId, chats);
	await saveWorkspaceChatFollowSync(db, scope, workspaceId, input.position);
}

/**
 * The person's chats in each workspace. A workspace looked at for the first
 * time has the person's earlier posts recorded first, so chats they already
 * took part in keep notifying them.
 */
export async function chatFollowsByWorkspace(
	db: DbQueryClient,
	reader: ChatFollowReader,
	workspaceIds: readonly string[],
): Promise<Map<string, WorkspaceChatFollows>> {
	const { scope } = reader;
	const synced = await listWorkspaceChatFollowSyncs(db, scope, workspaceIds);
	const fresh = workspaceIds.filter((id) => !synced.has(id));
	if (fresh.length > 0) {
		const positions = await listWorkspaceFeedPositions(
			db,
			scope.organizationId,
			fresh,
		);
		for (const workspaceId of fresh)
			await recordChatsTakenPartIn(db, reader, workspaceId, {
				position: positions.get(workspaceId) ?? 0,
				syncedSeq: null,
			});
	}
	return listWorkspaceChatFollows(db, scope, workspaceIds);
}
