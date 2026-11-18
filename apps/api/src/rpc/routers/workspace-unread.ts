import { implement } from "@orpc/server";
import { workspaceUnreadContract } from "@tedix/api-contract/contracts/workspace-unread";
import type {
	WorkspaceUnreadItem,
	WorkspaceUnreadState,
} from "@tedix/api-contract/schemas/workspace-unread";
import {
	activeWorkspaceMutes,
	WebPushPreferencesSchema,
} from "@tedix/api-contract/schemas/web-push";
import { listPushConfigs } from "@tedix/db/queries/web-push";
import { getWorkspaceOutputIndexCurrent } from "@tedix/db/queries/workspace-feed/read";
import {
	joinWorkspaceChats,
	listWorkspaceChatFollowSyncs,
	setWorkspaceChatFollow,
} from "@tedix/db/queries/workspace-chat-follow";
import {
	getWorkspaceReadMarker,
	listWorkspaceFeedPositions,
	listWorkspaceReadMarkers,
	listWorkspaceUnreadFeed,
	listWorkspaceUnreadFeeds,
	saveWorkspaceReadMarker,
	type WorkspaceReadMarker,
} from "@tedix/db/queries/workspace-unread";
import type { OsWorkspaceRow } from "@tedix/db/schema/os-workspaces";
import {
	authorizeDerivedOutputSources,
	parseDerivedAccessEnvelope,
} from "../../services/os-derived-resource-access";
import {
	chatFollowsByWorkspace,
	recordChatsTakenPartIn,
} from "../../services/workspace-chat-follow";
import { notifyWorkspaceChat } from "../../services/workspace-chat-push";
import {
	advanceReadMarker,
	chatNotificationsOn,
	unreadFromFeed,
	unreadWhileMuted,
	type WorkspaceChatFollows,
	type WorkspaceUnread,
} from "../../services/workspace-unread";
import {
	AUTHZ,
	type BaseContext,
	createError,
	ErrorCodes,
	withAuth,
} from "../orpc";
import { requireOrgId } from "../org-scope";
import { queryDb, requireWorkspace } from "./os-workspaces-shared";

const os = implement(workspaceUnreadContract)
	.$context<BaseContext>()
	.use(withAuth)
	.use(AUTHZ.osRead);

/** Most workspaces one summary reads feed rows for. */
const SUMMARY_WORKSPACE_LIMIT = 20;
/** Most file titles one Unread list checks access for. */
const LIST_FILE_LIMIT = 30;

/** Unread state belongs to a person signed in to Tedix OS, never to an agent or key. */
function reader(context: BaseContext) {
	if (
		context.authType !== "user" ||
		!context.userId ||
		context.externalAgentPrincipalId
	)
		throw createError(
			ErrorCodes.FORBIDDEN,
			"Unread state requires a person signed in to Tedix OS",
		);
	return {
		scope: { organizationId: requireOrgId(context), userId: context.userId },
		readerIds: [context.userId, context.user?.sub].filter(
			(id): id is string => !!id,
		),
	};
}

function counts(workspaceId: string, unread: WorkspaceUnread) {
	return {
		workspaceId,
		chat: unread.chat.length,
		files: unread.files.length,
		total: unread.chat.length + unread.files.length,
	};
}

function state(
	workspaceId: string,
	unread: WorkspaceUnread,
	follows: WorkspaceChatFollows,
): WorkspaceUnreadState {
	const conversations = new Map<string, number>();
	for (const item of unread.chat) {
		const id = item.conversationId ?? "";
		conversations.set(id, (conversations.get(id) ?? 0) + 1);
	}
	return {
		...counts(workspaceId, unread),
		fileIds: unread.files.flatMap((item) => item.outputId ?? []),
		conversations: [...conversations].map(([conversationId, count]) => ({
			conversationId,
			count,
		})),
		notifyingConversationIds: [...follows.keys()].filter((id) =>
			chatNotificationsOn(follows, id),
		),
	};
}

async function visibleWorkspace(
	context: BaseContext,
	workspaceId: string,
): Promise<OsWorkspaceRow | null> {
	try {
		return await requireWorkspace(context, workspaceId);
	} catch {
		return null;
	}
}

/**
 * Unread rows of every workspace the person has a marker for and that has
 * moved past it. One marker read, one position read, then one batch.
 */
async function unreadByWorkspace(context: BaseContext) {
	const { scope, readerIds } = reader(context);
	const db = queryDb(context);
	const markers = await listWorkspaceReadMarkers(db, scope);
	if (markers.size === 0) return [];
	const positions = await listWorkspaceFeedPositions(db, scope.organizationId, [
		...markers.keys(),
	]);
	const moved = [...markers]
		.filter(([id, marker]) => (positions.get(id) ?? 0) > marker.floor)
		.sort((a, b) => (positions.get(b[0]) ?? 0) - (positions.get(a[0]) ?? 0))
		.slice(0, SUMMARY_WORKSPACE_LIMIT);
	if (moved.length === 0) return [];
	const [results, [saved], follows] = await Promise.all([
		listWorkspaceUnreadFeeds(
			db,
			moved.map(([workspaceId, marker]) => ({
				organizationId: scope.organizationId,
				workspaceId,
				afterSeq: marker.floor,
				readerIds,
			})),
		),
		listPushConfigs(db, scope, "preferences"),
		chatFollowsByWorkspace(
			db,
			{ scope, readerIds },
			moved.map(([workspaceId]) => workspaceId),
		),
	]);
	const preferences = WebPushPreferencesSchema.safeParse(saved?.value);
	// Read markers do not move while a workspace is muted, so what arrived in
	// the meantime is counted again as soon as the mute ends.
	const muted = new Set(
		preferences.success
			? activeWorkspaceMutes(preferences.data, Date.now()).mutedWorkspaceIds
			: [],
	);
	const unread: Array<{
		workspace: OsWorkspaceRow;
		unread: WorkspaceUnread;
	}> = [];
	for (const [index, [workspaceId, marker]] of moved.entries()) {
		const all = unreadFromFeed(
			results[index] ?? [],
			marker,
			follows.get(workspaceId) ?? new Map(),
		);
		const found = muted.has(workspaceId) ? unreadWhileMuted(all) : all;
		if (found.chat.length + found.files.length === 0) continue;
		// Access is checked now, not when the marker was written: a workspace
		// made private or archived since then drops out.
		const workspace = await visibleWorkspace(context, workspaceId);
		if (workspace && workspace.status === "active")
			unread.push({ workspace, unread: found });
	}
	return unread;
}

/** One workspace's unread counts and the chats the person is notified about. */
async function workspaceState(
	context: BaseContext,
	workspaceId: string,
	marker: WorkspaceReadMarker | null,
): Promise<WorkspaceUnreadState> {
	const { scope, readerIds } = reader(context);
	const db = queryDb(context);
	const follows =
		(await chatFollowsByWorkspace(db, { scope, readerIds }, [workspaceId])).get(
			workspaceId,
		) ?? new Map();
	if (!marker) return state(workspaceId, { chat: [], files: [] }, follows);
	return state(
		workspaceId,
		unreadFromFeed(
			await listWorkspaceUnreadFeed(db, {
				organizationId: scope.organizationId,
				workspaceId,
				afterSeq: marker.floor,
				readerIds,
			}),
			marker,
			follows,
		),
		follows,
	);
}

/** A file's title is shown only to someone who may open the file. */
async function readableFile(
	context: BaseContext,
	workspaceId: string,
	item: WorkspaceUnreadItem,
): Promise<WorkspaceUnreadItem | null> {
	if (!item.outputId) return null;
	const organizationId = requireOrgId(context);
	const current = await getWorkspaceOutputIndexCurrent(queryDb(context), {
		organizationId,
		outputId: item.outputId,
	});
	if (
		!current ||
		current.workspaceId !== workspaceId ||
		current.status !== "active"
	)
		return null;
	const envelope = parseDerivedAccessEnvelope(current.accessEnvelope);
	if (
		!envelope ||
		!(await authorizeDerivedOutputSources(context, {
			organizationId,
			accessEnvelope: envelope,
		}))
	)
		return null;
	return { ...item, title: current.title };
}

export const workspaceUnreadRouter = os.router({
	summary: os.summary.handler(async ({ context }) => {
		const workspaces = (await unreadByWorkspace(context)).map((entry) =>
			counts(entry.workspace.id, entry.unread),
		);
		return {
			total: workspaces.reduce((sum, entry) => sum + entry.total, 0),
			workspaces,
		};
	}),
	workspace: os.workspace.handler(async ({ context, input }) => {
		const { scope } = reader(context);
		await requireWorkspace(context, input.workspaceId);
		const marker = await getWorkspaceReadMarker(
			queryDb(context),
			scope,
			input.workspaceId,
		);
		return workspaceState(context, input.workspaceId, marker);
	}),
	list: os.list.handler(async ({ context }) => {
		let fileBudget = LIST_FILE_LIMIT;
		const groups = [];
		for (const entry of await unreadByWorkspace(context)) {
			const files: WorkspaceUnreadItem[] = [];
			for (const item of entry.unread.files) {
				if (fileBudget <= 0) break;
				fileBudget -= 1;
				const file = await readableFile(context, entry.workspace.id, item);
				if (file) files.push(file);
			}
			const items = [...entry.unread.chat, ...files].sort(
				(a, b) => Number(b.id) - Number(a.id),
			);
			const newest = items[0];
			if (!newest) continue;
			groups.push({
				workspaceId: entry.workspace.id,
				workspaceName: entry.workspace.name,
				latestAt: newest.occurredAt,
				items,
			});
		}
		groups.sort((a, b) => b.latestAt.localeCompare(a.latestAt));
		return {
			total: groups.reduce((sum, group) => sum + group.items.length, 0),
			groups,
		};
	}),
	markRead: os.markRead.handler(async ({ context, input }) => {
		const { scope, readerIds } = reader(context);
		await requireWorkspace(context, input.workspaceId);
		const db = queryDb(context);
		const [current, positions] = await Promise.all([
			getWorkspaceReadMarker(db, scope, input.workspaceId),
			listWorkspaceFeedPositions(db, scope.organizationId, [input.workspaceId]),
		]);
		const marker = advanceReadMarker(
			current,
			input.target,
			positions.get(input.workspaceId) ?? 0,
		);
		if (marker !== current)
			await saveWorkspaceReadMarker(db, scope, input.workspaceId, marker);
		// Opening the workspace picks up the chats the person posted in since
		// the last time, so those notify them from here on.
		if (input.target.type === "visit") {
			const synced = await listWorkspaceChatFollowSyncs(db, scope, [
				input.workspaceId,
			]);
			await recordChatsTakenPartIn(
				db,
				{ scope, readerIds },
				input.workspaceId,
				{
					position: positions.get(input.workspaceId) ?? 0,
					syncedSeq: synced.get(input.workspaceId) ?? null,
				},
			);
		}
		return workspaceState(context, input.workspaceId, marker);
	}),
	setChatNotifications: os.setChatNotifications.handler(
		async ({ context, input }) => {
			const { scope } = reader(context);
			await requireWorkspace(context, input.workspaceId);
			const db = queryDb(context);
			await setWorkspaceChatFollow(
				db,
				scope,
				input.workspaceId,
				input.conversationId,
				input.on ? "on" : "off",
			);
			return workspaceState(
				context,
				input.workspaceId,
				await getWorkspaceReadMarker(db, scope, input.workspaceId),
			);
		},
	),
	notifyChat: os.notifyChat.handler(async ({ context, input }) => {
		const { scope, readerIds } = reader(context);
		const workspace = await requireWorkspace(context, input.workspaceId);
		// Posting is taking part: replies in this chat notify the poster from
		// now on, unless they chose otherwise for it.
		await joinWorkspaceChats(queryDb(context), scope, workspace.id, [
			input.conversationId,
		]);
		return notifyWorkspaceChat(context, queryDb(context), {
			caller: scope,
			callerIds: readerIds,
			workspace,
			conversationId: input.conversationId,
			mentionedUserIds: input.mentionedUserIds,
		});
	}),
	markAllRead: os.markAllRead.handler(async ({ context }) => {
		const { scope } = reader(context);
		const db = queryDb(context);
		const markers = await listWorkspaceReadMarkers(db, scope);
		const positions = await listWorkspaceFeedPositions(
			db,
			scope.organizationId,
			[...markers.keys()],
		);
		for (const [workspaceId, marker] of markers) {
			const position = positions.get(workspaceId) ?? 0;
			if (position <= marker.floor) continue;
			await saveWorkspaceReadMarker(
				db,
				scope,
				workspaceId,
				advanceReadMarker(marker, { type: "all" }, position),
			);
		}
		return { ok: true as const };
	}),
});
