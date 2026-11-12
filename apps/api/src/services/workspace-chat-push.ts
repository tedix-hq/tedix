/**
 * Push for workspace chat: when a person posts, tell the people who are
 * mentioned or who took part in that conversation and do not have the
 * workspace open. A person is never notified about their own post, a muted
 * workspace stays quiet, and the message never carries chat content.
 *
 * The poster's browser asks for this after sending, but nothing it says is
 * trusted beyond who is mentioned: the post is looked up in the workspace
 * activity feed under the caller's own identity, and each post notifies once.
 */

import { WorkspaceChangeSummarySchema } from "@tedix/api-contract/schemas/workspace-feed";
import { WebPushPreferencesSchema } from "@tedix/api-contract/schemas/web-push";
import {
	getMemberByCanonicalUserId,
	getMemberByUserId,
} from "@tedix/db/queries/organization-members";
import { isOsWorkspaceVisibleTo } from "@tedix/db/queries/os-workspaces/workspaces";
import {
	hasVisiblePushConversation,
	listPushConfigs,
	savePushConfig,
} from "@tedix/db/queries/web-push";
import {
	listWorkspaceFeedPositions,
	listWorkspaceUnreadFeed,
	type WorkspaceUnreadFeedRow,
} from "@tedix/db/queries/workspace-unread";
import type { DbQueryClient } from "@tedix/db/query-client";
import type { OsWorkspaceRow } from "@tedix/db/schema/os-workspaces";
import type { BaseContext } from "../rpc/context";
import { sendPushToDevices, webPushKeys } from "./web-push";

/** How far back in the feed a conversation's participants are looked for. */
const PARTICIPANT_WINDOW = 300;
const RECIPIENT_LIMIT = 20;

/** The key a tab with this workspace open holds its "I am looking" lease under. */
export function workspacePushVisibilityKey(workspaceId: string): string {
	return `workspace:${workspaceId}`;
}

/** The conversation a chat post row belongs to; null for any other row. */
function postedIn(row: WorkspaceUnreadFeedRow): string | null {
	if (row.kind !== "run" || row.actorKind !== "user" || !row.runSummary)
		return null;
	try {
		const summary = WorkspaceChangeSummarySchema.safeParse(
			JSON.parse(row.runSummary),
		);
		if (
			!summary.success ||
			summary.data.action?.resource !== "conversation" ||
			summary.data.action.operation !== "turn.started"
		)
			return null;
		return summary.data.conversationId ?? null;
	} catch {
		return null;
	}
}

export async function notifyWorkspaceChat(
	context: BaseContext,
	db: DbQueryClient,
	input: {
		caller: { organizationId: string; userId: string };
		callerIds: readonly string[];
		workspace: OsWorkspaceRow;
		conversationId: string;
		mentionedUserIds: readonly string[];
	},
): Promise<{ status: "sent" | "pending" | "none"; notified: number }> {
	const keys = webPushKeys(context.env);
	if (!keys) return { status: "none", notified: 0 };
	const { caller, workspace } = input;
	const organizationId = caller.organizationId;
	const notifiedKey = `sent:${workspace.id}`;
	const [positions, [notifiedRow]] = await Promise.all([
		listWorkspaceFeedPositions(db, organizationId, [workspace.id]),
		listPushConfigs(db, caller, notifiedKey),
	]);
	const position = positions.get(workspace.id) ?? 0;
	const notifiedSeq =
		typeof notifiedRow?.value.seq === "number" ? notifiedRow.value.seq : 0;
	const post = (
		await listWorkspaceUnreadFeed(db, {
			organizationId,
			workspaceId: workspace.id,
			afterSeq: Math.max(notifiedSeq, position - PARTICIPANT_WINDOW),
			readerIds: input.callerIds,
			own: true,
		})
	).find((row) => postedIn(row) === input.conversationId);
	if (!post) return { status: "pending", notified: 0 };
	// Claim the post before sending so a repeated call cannot notify twice.
	await savePushConfig(db, caller, notifiedKey, { seq: post.seq });

	const mentioned = new Set(input.mentionedUserIds);
	const others = await listWorkspaceUnreadFeed(db, {
		organizationId,
		workspaceId: workspace.id,
		afterSeq: Math.max(0, post.seq - PARTICIPANT_WINDOW),
		readerIds: input.callerIds,
	});
	const candidates = new Set<string>(mentioned);
	for (const row of others)
		if (postedIn(row) === input.conversationId) candidates.add(row.actorId);

	const sender =
		(
			await getMemberByCanonicalUserId(
				context.db,
				organizationId,
				caller.userId,
			)
		)?.name ?? "Someone";
	const seen = new Set<string>();
	let notified = 0;
	for (const id of [...candidates].slice(0, RECIPIENT_LIMIT)) {
		const member =
			(await getMemberByUserId(context.db, organizationId, id)) ??
			(await getMemberByCanonicalUserId(context.db, organizationId, id));
		if (
			!member ||
			member.status !== "active" ||
			!member.userId ||
			seen.has(member.id) ||
			member.userId === caller.userId ||
			input.callerIds.includes(member.descopeUserId)
		)
			continue;
		seen.add(member.id);
		if (
			!isOsWorkspaceVisibleTo(workspace, {
				userIds: [member.descopeUserId, member.userId],
			})
		)
			continue;
		const scope = { organizationId, userId: member.userId };
		const preferences = WebPushPreferencesSchema.safeParse(
			(await listPushConfigs(db, scope, "preferences"))[0]?.value,
		);
		if (
			preferences.success &&
			preferences.data.mutedWorkspaceIds?.includes(workspace.id)
		)
			continue;
		if (
			await hasVisiblePushConversation(
				db,
				scope,
				workspacePushVisibilityKey(workspace.id),
				Date.now(),
			)
		)
			continue;
		const wasMentioned =
			mentioned.has(member.descopeUserId) || mentioned.has(member.userId);
		await sendPushToDevices(context, scope, keys, {
			title: workspace.name,
			body: wasMentioned
				? `${sender} mentioned you in the chat.`
				: `${sender} replied in a chat you took part in.`,
			url: `/workspace/${workspace.id}?conversation=${encodeURIComponent(input.conversationId)}&pane=chat`,
			conversationId: workspacePushVisibilityKey(workspace.id),
			tag: `chat:${workspace.id}:${post.seq}`,
		});
		notified += 1;
	}
	return { status: notified > 0 ? "sent" : "none", notified };
}
