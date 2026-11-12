import { implement } from "@orpc/server";
import { workspaceUnreadContract } from "@tedix/api-contract/contracts/workspace-unread";
import type {
	WorkspaceUnreadItem,
	WorkspaceUnreadState,
} from "@tedix/api-contract/schemas/workspace-unread";
import { getWorkspaceOutputIndexCurrent } from "@tedix/db/queries/workspace-feed/read";
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
	advanceReadMarker,
	unreadFromFeed,
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
	const results = await listWorkspaceUnreadFeeds(
		db,
		moved.map(([workspaceId, marker]) => ({
			organizationId: scope.organizationId,
			workspaceId,
			afterSeq: marker.floor,
			readerIds,
		})),
	);
	const unread: Array<{
		workspace: OsWorkspaceRow;
		unread: WorkspaceUnread;
	}> = [];
	for (const [index, [workspaceId, marker]] of moved.entries()) {
		const found = unreadFromFeed(results[index] ?? [], marker);
		if (found.chat.length + found.files.length === 0) continue;
		// Access is checked now, not when the marker was written: a workspace
		// made private or archived since then drops out.
		const workspace = await visibleWorkspace(context, workspaceId);
		if (workspace && workspace.status === "active")
			unread.push({ workspace, unread: found });
	}
	return unread;
}

async function workspaceUnread(
	context: BaseContext,
	workspaceId: string,
	marker: WorkspaceReadMarker | null,
): Promise<WorkspaceUnread> {
	if (!marker) return { chat: [], files: [] };
	const { scope, readerIds } = reader(context);
	return unreadFromFeed(
		await listWorkspaceUnreadFeed(queryDb(context), {
			organizationId: scope.organizationId,
			workspaceId,
			afterSeq: marker.floor,
			readerIds,
		}),
		marker,
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
		return state(
			input.workspaceId,
			await workspaceUnread(context, input.workspaceId, marker),
		);
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
		const { scope } = reader(context);
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
		await saveWorkspaceReadMarker(db, scope, input.workspaceId, marker);
		return state(
			input.workspaceId,
			await workspaceUnread(context, input.workspaceId, marker),
		);
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
