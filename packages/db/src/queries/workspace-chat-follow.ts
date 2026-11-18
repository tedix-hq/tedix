/**
 * Which workspace chats a person gets notifications for.
 *
 * One small `user_configs` row per person per chat they took part in or made
 * a choice about, never a row per message. A second row per workspace
 * remembers how far the person's own posts were read from the activity feed.
 */

import { and, desc, eq, inArray } from "drizzle-orm";
import type { DbQueryClient } from "../query-client";
import { userConfigs } from "../schema/user-configs";
import { batchNonEmpty, chunkForBoundParams } from "../utils/batch";
import { upsertUserConfig } from "./user-configs";
import type { WorkspaceUnreadScope } from "./workspace-unread";

/**
 * `joined`: the person posted in the chat or was mentioned there.
 * `on` and `off`: the person chose, and taking part later does not change it.
 */
export type WorkspaceChatFollowState = "joined" | "on" | "off";

/** Most chats per workspace one read looks at, newest first. */
export const WORKSPACE_CHAT_FOLLOW_LIMIT = 500;
/** Most people one chat's followers are read for. */
export const WORKSPACE_CHAT_FOLLOWER_LIMIT = 200;

const followNamespace = (organizationId: string, workspaceId: string) =>
	`os.chat-follow:${organizationId}:${workspaceId}`;
const syncNamespace = (organizationId: string) =>
	`os.chat-follow:${organizationId}`;

function followState(value: unknown): WorkspaceChatFollowState | null {
	const state =
		value && typeof value === "object" && !Array.isArray(value)
			? (value as Record<string, unknown>).state
			: null;
	return state === "joined" || state === "on" || state === "off" ? state : null;
}

function buildFollowsStatement(
	db: DbQueryClient,
	scope: WorkspaceUnreadScope,
	workspaceId: string,
) {
	return db
		.select({
			conversationId: userConfigs.key,
			followValue: userConfigs.value,
		})
		.from(userConfigs)
		.where(
			and(
				eq(userConfigs.userId, scope.userId),
				eq(
					userConfigs.namespace,
					followNamespace(scope.organizationId, workspaceId),
				),
			),
		)
		.orderBy(desc(userConfigs.updatedAt), desc(userConfigs.key))
		.limit(WORKSPACE_CHAT_FOLLOW_LIMIT);
}

/** The person's chats per workspace; a workspace with none maps to an empty map. */
export async function listWorkspaceChatFollows(
	db: DbQueryClient,
	scope: WorkspaceUnreadScope,
	workspaceIds: readonly string[],
): Promise<Map<string, Map<string, WorkspaceChatFollowState>>> {
	const ids = [...new Set(workspaceIds)];
	const follows = new Map<string, Map<string, WorkspaceChatFollowState>>();
	if (ids.length === 0) return follows;
	const results = (await db.batch(
		batchNonEmpty(ids.map((id) => buildFollowsStatement(db, scope, id))),
	)) as Array<Array<{ conversationId: string; followValue: unknown }>>;
	for (const [index, id] of ids.entries()) {
		const chats = new Map<string, WorkspaceChatFollowState>();
		for (const row of results[index] ?? []) {
			const state = followState(row.followValue);
			if (state) chats.set(row.conversationId, state);
		}
		follows.set(id, chats);
	}
	return follows;
}

/** Record the person's own choice for one chat. */
export async function setWorkspaceChatFollow(
	db: DbQueryClient,
	scope: WorkspaceUnreadScope,
	workspaceId: string,
	conversationId: string,
	state: "on" | "off",
): Promise<void> {
	await upsertUserConfig(db, {
		userId: scope.userId,
		namespace: followNamespace(scope.organizationId, workspaceId),
		key: conversationId,
		value: { state },
	});
}

/**
 * Record that the person took part in these chats. A chat they already took
 * part in or chose for keeps what it has.
 */
export async function joinWorkspaceChats(
	db: DbQueryClient,
	scope: WorkspaceUnreadScope,
	workspaceId: string,
	conversationIds: readonly string[],
): Promise<void> {
	const now = new Date().toISOString();
	const namespace = followNamespace(scope.organizationId, workspaceId);
	// Seven bound values per row.
	for (const chunk of chunkForBoundParams([...new Set(conversationIds)], 12))
		await db
			.insert(userConfigs)
			.values(
				chunk.map((conversationId) => ({
					id: crypto.randomUUID(),
					userId: scope.userId,
					namespace,
					key: conversationId,
					value: { state: "joined" },
					createdAt: now,
					updatedAt: now,
				})),
			)
			.onConflictDoNothing({
				target: [userConfigs.userId, userConfigs.namespace, userConfigs.key],
			});
}

/** Everyone with a record for one chat, whatever it says. */
export async function listWorkspaceChatFollowers(
	db: DbQueryClient,
	input: {
		organizationId: string;
		workspaceId: string;
		conversationId: string;
	},
): Promise<Array<{ userId: string; state: WorkspaceChatFollowState }>> {
	const rows = await db
		.select({ userId: userConfigs.userId, value: userConfigs.value })
		.from(userConfigs)
		.where(
			and(
				eq(
					userConfigs.namespace,
					followNamespace(input.organizationId, input.workspaceId),
				),
				eq(userConfigs.key, input.conversationId),
			),
		)
		.orderBy(desc(userConfigs.updatedAt), desc(userConfigs.userId))
		.limit(WORKSPACE_CHAT_FOLLOWER_LIMIT);
	return rows.flatMap((row) => {
		const state = followState(row.value);
		return state ? [{ userId: row.userId, state }] : [];
	});
}

/**
 * The feed position up to which the person's own posts were recorded, per
 * workspace. A workspace that is missing was never looked at.
 */
export async function listWorkspaceChatFollowSyncs(
	db: DbQueryClient,
	scope: WorkspaceUnreadScope,
	workspaceIds: readonly string[],
): Promise<Map<string, number>> {
	const synced = new Map<string, number>();
	for (const chunk of chunkForBoundParams([...new Set(workspaceIds)], 50)) {
		const rows = await db
			.select({ key: userConfigs.key, value: userConfigs.value })
			.from(userConfigs)
			.where(
				and(
					eq(userConfigs.userId, scope.userId),
					eq(userConfigs.namespace, syncNamespace(scope.organizationId)),
					// bound-params: chunked by chunkForBoundParams
					inArray(userConfigs.key, chunk),
				),
			);
		for (const row of rows) {
			const seq = row.value.seq;
			synced.set(
				row.key,
				typeof seq === "number" && Number.isInteger(seq) && seq >= 0 ? seq : 0,
			);
		}
	}
	return synced;
}

export async function saveWorkspaceChatFollowSync(
	db: DbQueryClient,
	scope: WorkspaceUnreadScope,
	workspaceId: string,
	seq: number,
): Promise<void> {
	await upsertUserConfig(db, {
		userId: scope.userId,
		namespace: syncNamespace(scope.organizationId),
		key: workspaceId,
		value: { seq },
	});
}
