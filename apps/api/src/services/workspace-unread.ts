/**
 * Unread state for workspaces: what other people and agents did in a
 * workspace since the person last looked. The feed rows come from
 * `@tedix/db/queries/workspace-unread`; this module decides which of them
 * count and how a read marker moves.
 */

import type {
	WorkspaceUnreadItem,
	WorkspaceUnreadKind,
} from "@tedix/api-contract/schemas/workspace-unread";
import { WorkspaceChangeSummarySchema } from "@tedix/api-contract/schemas/workspace-feed";
import type {
	WorkspaceReadMarker,
	WorkspaceUnreadFeedRow,
} from "@tedix/db/queries/workspace-unread";

export interface WorkspaceUnread {
	/** Chat messages and agent results, newest first. */
	chat: WorkspaceUnreadItem[];
	/** One entry per changed file, newest first. */
	files: WorkspaceUnreadItem[];
}

function chatKind(
	row: WorkspaceUnreadFeedRow,
	operation: string,
	outcome: string,
): WorkspaceUnreadKind | null {
	if (operation === "turn.started")
		return row.actorKind === "user" ? "message" : null;
	if (operation === "turn.finished")
		return outcome === "applied" ? "agent_reply" : "agent_stopped";
	if (operation === "approval.requested") return "needs_decision";
	return null;
}

/**
 * Pick the unread rows out of a workspace's recent feed. `rows` are newest
 * first and already exclude the reader's own actions.
 */
export function unreadFromFeed(
	rows: readonly WorkspaceUnreadFeedRow[],
	marker: WorkspaceReadMarker,
): WorkspaceUnread {
	const chat: WorkspaceUnreadItem[] = [];
	const files = new Map<string, WorkspaceUnreadItem>();
	for (const row of rows) {
		if (row.seq <= marker.floor) continue;
		const byAgent = row.actorKind !== "user";
		if (row.kind === "output") {
			if (row.seq <= (marker.files[row.entityId] ?? marker.floor)) continue;
			if (files.has(row.entityId)) continue;
			files.set(row.entityId, {
				id: String(row.seq),
				kind: "file",
				byAgent,
				actorId: row.actorId,
				occurredAt: row.occurredAt,
				outputId: row.entityId,
				title: row.title,
			});
			continue;
		}
		if (row.seq <= marker.chat || !row.runSummary) continue;
		let summary;
		try {
			summary = WorkspaceChangeSummarySchema.safeParse(
				JSON.parse(row.runSummary),
			);
		} catch {
			continue;
		}
		const action = summary.success ? summary.data.action : undefined;
		if (!summary.success || action?.resource !== "conversation") continue;
		const conversationId = summary.data.conversationId;
		if (row.seq <= (marker.chats[conversationId ?? ""] ?? 0)) continue;
		const kind = chatKind(row, action.operation, action.outcome);
		if (!kind) continue;
		chat.push({
			id: String(row.seq),
			kind,
			byAgent: kind !== "message",
			actorId: row.actorId,
			occurredAt: row.occurredAt,
			...(conversationId ? { conversationId } : {}),
			...(action.traceId ? { turnId: action.traceId } : {}),
		});
	}
	return { chat, files: [...files.values()] };
}

export type WorkspaceReadTarget =
	| { type: "chat"; conversationId?: string }
	| { type: "file"; outputId: string }
	| { type: "all" }
	| { type: "visit" };

/**
 * Move a marker after the person looked at something. `position` is the
 * workspace's newest feed sequence number. A first visit starts the marker at
 * that position, so history from before the person ever opened the workspace
 * is never unread.
 */
export function advanceReadMarker(
	marker: WorkspaceReadMarker | null,
	target: WorkspaceReadTarget,
	position: number,
): WorkspaceReadMarker {
	if (!marker || target.type === "all")
		return { floor: position, chat: position, chats: {}, files: {} };
	if (target.type === "visit") return marker;
	if (target.type === "chat") {
		if (!target.conversationId)
			return { ...marker, chat: Math.max(marker.chat, position), chats: {} };
		const chats = { ...marker.chats };
		// Rows written before conversations were recorded have no id; seeing
		// any conversation clears them too.
		for (const id of [target.conversationId, ""])
			chats[id] = Math.max(chats[id] ?? 0, position);
		return { ...marker, chats };
	}
	return {
		...marker,
		files: {
			...marker.files,
			[target.outputId]: Math.max(marker.files[target.outputId] ?? 0, position),
		},
	};
}
