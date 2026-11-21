/**
 * One person's recent workspace chats, so Home can list them next to its own.
 *
 * Each workspace store sends the chats a person took part in as a whole
 * snapshot for that workspace. The index replaces that workspace's entries
 * only when the snapshot is newer than the last one it kept, so a retried or
 * late push cannot bring back a chat that was deleted or archived since.
 * Chat contents never leave the workspace; an entry is a title and a time.
 * Readers check access again before they show an entry.
 */
import type { WorkspaceStorage } from "./runtime";

/** Most chats one workspace sends for one person. */
export const PERSON_CHATS_PER_WORKSPACE = 50;

export interface PersonChatsOwner {
	organizationId: string;
	userId: string;
}

export interface PersonChatEntry {
	conversationId: string;
	title: string | null;
	lastMessageAt: string;
}

export interface PersonChatsSnapshot {
	workspaceId: string;
	/** Grows with every snapshot the workspace sends; older ones are ignored. */
	seq: number;
	chats: PersonChatEntry[];
}

export interface PersonChat extends PersonChatEntry {
	workspaceId: string;
}

export const PERSON_CHATS_SCHEMA = `
CREATE TABLE IF NOT EXISTS person_chat_workspaces (
	workspace_id TEXT PRIMARY KEY,
	seq INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS person_chats (
	workspace_id TEXT NOT NULL,
	conversation_id TEXT NOT NULL,
	title TEXT,
	last_message_at TEXT NOT NULL,
	PRIMARY KEY (workspace_id, conversation_id)
);
CREATE INDEX IF NOT EXISTS person_chats_recent ON person_chats(last_message_at);
`;

/** The index object's name in the workspace namespace; never a workspace store's. */
export function personChatsName(owner: PersonChatsOwner): string {
	return `person-chats:${encodeURIComponent(owner.organizationId)}:${encodeURIComponent(owner.userId)}`;
}

/** Applies a snapshot unless a newer one for that workspace is already kept. */
export function applyPersonChats(
	store: WorkspaceStorage,
	snapshot: PersonChatsSnapshot,
): boolean {
	const [kept] = store.exec<{ seq: number }>(
		"SELECT seq FROM person_chat_workspaces WHERE workspace_id = ?",
		snapshot.workspaceId,
	);
	if (kept && kept.seq >= snapshot.seq) return false;
	store.run(
		"DELETE FROM person_chats WHERE workspace_id = ?",
		snapshot.workspaceId,
	);
	for (const chat of snapshot.chats.slice(0, PERSON_CHATS_PER_WORKSPACE))
		store.run(
			"INSERT OR REPLACE INTO person_chats (workspace_id, conversation_id, title, last_message_at) VALUES (?, ?, ?, ?)",
			snapshot.workspaceId,
			chat.conversationId,
			chat.title,
			chat.lastMessageAt,
		);
	store.run(
		"INSERT OR REPLACE INTO person_chat_workspaces (workspace_id, seq) VALUES (?, ?)",
		snapshot.workspaceId,
		snapshot.seq,
	);
	return true;
}

/** Newest first, across every workspace that sent entries. */
export function listPersonChats(
	store: WorkspaceStorage,
	limit: number,
): PersonChat[] {
	return store
		.exec<{
			workspace_id: string;
			conversation_id: string;
			title: string | null;
			last_message_at: string;
		}>(
			"SELECT workspace_id, conversation_id, title, last_message_at FROM person_chats ORDER BY last_message_at DESC, conversation_id DESC LIMIT ?",
			limit,
		)
		.map((row) => ({
			workspaceId: row.workspace_id,
			conversationId: row.conversation_id,
			title: row.title,
			lastMessageAt: row.last_message_at,
		}));
}

/**
 * Drops a workspace's entries, for a person who can no longer open it. The
 * kept sequence stays, so an older snapshot still in flight cannot restore
 * them; a newer one after access comes back does.
 */
export function forgetPersonChatWorkspace(
	store: WorkspaceStorage,
	workspaceId: string,
): void {
	store.run("DELETE FROM person_chats WHERE workspace_id = ?", workspaceId);
}

/** The chats one person took part in, as the workspace sends them. */
export function personChatsIn(
	store: WorkspaceStorage,
	userId: string,
): PersonChatEntry[] {
	return store
		.exec<{ id: string; title: string | null; last_message_at: string }>(
			`SELECT c.id, c.title, coalesce(c.last_turn_at, c.updated_at) AS last_message_at
			FROM conversations c
			WHERE c.archived_at IS NULL AND EXISTS (
				SELECT 1 FROM turns t WHERE t.conversation_id = c.id AND t.actor_kind = 'user' AND t.actor_id = ?
			)
			ORDER BY last_message_at DESC, c.id DESC LIMIT ?`,
			userId,
			PERSON_CHATS_PER_WORKSPACE,
		)
		.map((row) => ({
			conversationId: row.id,
			title: row.title,
			lastMessageAt: row.last_message_at,
		}));
}

/** People who posted in a conversation; they get its entry. */
export function conversationParticipants(
	store: WorkspaceStorage,
	conversationId: string,
): string[] {
	return store
		.exec<{ actor_id: string }>(
			"SELECT DISTINCT actor_id FROM turns WHERE conversation_id = ? AND actor_kind = 'user'",
			conversationId,
		)
		.map((row) => row.actor_id);
}
