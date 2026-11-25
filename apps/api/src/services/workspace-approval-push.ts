/**
 * Push for a change that waits for approval in a workspace: when the
 * workspace agent holds a change for a person, tell the people who can decide
 * it and do not have the workspace open.
 *
 * A change the agent applied at once does not notify, and neither does a
 * request someone already decided. A muted workspace stays quiet. The choice a
 * person made for one chat does not matter here: the workspace owes the
 * answer, whichever chat asked. Several requests that wait together are one
 * notification, and each request notifies a person once.
 *
 * The message names the workspace and the kind of change in fixed words. It
 * never carries a title, an argument or content.
 *
 * The owning workspace's alarm calls this after publishing its activity.
 */

import { operationAllowed } from "@tedix/api-contract/schemas/os-collaborators";
import {
	WebPushPreferencesSchema,
	workspaceMuteState,
} from "@tedix/api-contract/schemas/web-push";
import { WorkspaceChangeSummarySchema } from "@tedix/api-contract/schemas/workspace-feed";
import {
	getMemberByCanonicalUserId,
	getMemberByUserId,
} from "@tedix/db/queries/organization-members";
import { loadOsWorkspacePermissionRows } from "@tedix/db/queries/os-collaborators";
import { readWorkspaceSessionRole } from "@tedix/db/queries/os-workspace-access";
import { getOsWorkspace } from "@tedix/db/queries/os-workspaces/workspaces";
import { getTediByIdForOrganization } from "@tedix/db/queries/tedis";
import {
	hasVisiblePushConversation,
	listPushConfigs,
	savePushConfig,
} from "@tedix/db/queries/web-push";
import {
	listWorkspaceUnreadFeed,
	type WorkspaceUnreadFeedRow,
} from "@tedix/db/queries/workspace-unread";
import type { DbQueryClient } from "@tedix/db/query-client";
import type { OsWorkspaceRow } from "@tedix/db/schema/os-workspaces";
import type { BaseContext } from "../rpc/context";
import { sendPushToDevices, webPushKeys } from "./web-push";
import {
	notifyWorkspaceTediChats,
	workspacePushVisibilityKey,
} from "./workspace-chat-push";

/** A request older than this no longer notifies; the in-app notice remains. */
export const APPROVAL_PUSH_REQUEST_AGE_MS = 10 * 60_000;
/** How far back a chat post can notify. */
const MOVED_WINDOW_MS = 5 * 60_000;
const RECIPIENT_LIMIT = 20;
/** Longest kind-of-change wording a message repeats. */
const KIND_MAX = 80;

export interface WaitingApprovalRequests {
	/** Feed position of the newest request still waiting. */
	seq: number;
	/** The chat that newest request was asked in. */
	conversationId: string | null;
	/** How many recent requests still wait. */
	count: number;
	/** The kind of change the newest one is, in the workspace's fixed words. */
	kind: string | null;
}

/**
 * The recent requests in a workspace's feed that still wait for a person.
 * `rows` are the workspace's run rows, newest first. A turn's requests are
 * answered oldest first as far as the feed can tell, so the ones left over
 * are its newest.
 */
export function waitingApprovalRequests(
	rows: readonly WorkspaceUnreadFeedRow[],
	since: string,
): WaitingApprovalRequests | null {
	const turns = new Map<
		string,
		{
			requests: Array<{
				seq: number;
				occurredAt: string;
				conversationId: string | null;
				kind: string | null;
			}>;
			settled: number;
		}
	>();
	for (const row of rows) {
		if (row.kind !== "run" || !row.runSummary) continue;
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
		const turn = turns.get(row.entityId) ?? { requests: [], settled: 0 };
		turns.set(row.entityId, turn);
		if (action.operation === "approval.requested")
			turn.requests.push({
				seq: row.seq,
				occurredAt: row.occurredAt,
				conversationId: summary.data.conversationId ?? null,
				kind: summary.data.description?.trim().slice(0, KIND_MAX) || null,
			});
		// A change applied at once records its own decision; the two cancel out.
		else if (action.operation === "approval.decided") turn.settled += 1;
		else if (action.operation === "approval.automatic") turn.settled -= 1;
	}
	const waiting = [...turns.values()]
		.flatMap((turn) =>
			// Newest first, so the first ones are the ones still waiting.
			turn.requests.slice(
				0,
				Math.max(0, turn.requests.length - Math.max(0, turn.settled)),
			),
		)
		.filter((request) => request.occurredAt >= since)
		.sort((a, b) => b.seq - a.seq);
	const newest = waiting[0];
	if (!newest) return null;
	return {
		seq: newest.seq,
		conversationId: newest.conversationId,
		count: waiting.length,
		kind: newest.kind,
	};
}

function messageBody(waiting: WaitingApprovalRequests): string {
	if (waiting.count > 1)
		return `${waiting.count} changes are waiting for your approval.`;
	return waiting.kind
		? `A change is waiting for your approval: ${waiting.kind}.`
		: "A change is waiting for your approval.";
}

/**
 * Tell the people who can decide. They are looked for among the people who
 * acted in the workspace lately, their tedis' owners, its owner and the people
 * it was shared with;
 * each one's role is read now, so someone who lost access is not told.
 */
async function notifyWaitingApprovals(
	context: Pick<BaseContext, "db" | "env">,
	db: DbQueryClient,
	keys: NonNullable<ReturnType<typeof webPushKeys>>,
	input: {
		workspace: OsWorkspaceRow;
		waiting: WaitingApprovalRequests;
		rows: readonly WorkspaceUnreadFeedRow[];
		now: number;
	},
): Promise<{ notified: number; retryAt?: number }> {
	const { workspace, waiting, now } = input;
	const organizationId = workspace.organizationId;
	const candidates = new Set<string>();
	// Whoever the agent was working for comes first.
	const tediIds = new Set<string>();
	for (const row of input.rows) {
		if (row.actorKind === "user") candidates.add(row.actorId);
		else if (row.actorKind === "tedi") tediIds.add(row.actorId);
	}
	for (const tediId of tediIds) {
		const tedi = await getTediByIdForOrganization(
			context.db,
			tediId,
			organizationId,
		);
		if (tedi?.ownerUserId) candidates.add(tedi.ownerUserId);
	}
	if (workspace.ownerUserId) candidates.add(workspace.ownerUserId);
	const shares = await loadOsWorkspacePermissionRows(db, {
		organizationId,
		workspaceId: workspace.id,
	});
	for (const edge of shares.edges) {
		candidates.add(edge.targetUserId);
		if (edge.sharerUserId) candidates.add(edge.sharerUserId);
	}

	const claimKey = `approval:${workspace.id}`;
	const seen = new Set<string>();
	let notified = 0;
	let retryAt: number | undefined;
	for (const id of [...candidates].slice(0, RECIPIENT_LIMIT)) {
		const member =
			(await getMemberByUserId(context.db, organizationId, id)) ??
			(await getMemberByCanonicalUserId(context.db, organizationId, id));
		if (
			!member ||
			member.status !== "active" ||
			!member.userId ||
			seen.has(member.id)
		)
			continue;
		seen.add(member.id);
		// The same rule the workspace applies to a decision sent to it.
		if (
			!operationAllowed(
				await readWorkspaceSessionRole(db, workspace.id, member.descopeUserId),
				"app.chat",
			)
		)
			continue;
		const scope = { organizationId, userId: member.userId };
		const [claim] = await listPushConfigs(db, scope, claimKey);
		if (typeof claim?.value.seq === "number" && claim.value.seq >= waiting.seq)
			continue;
		const preferences = WebPushPreferencesSchema.safeParse(
			(await listPushConfigs(db, scope, "preferences"))[0]?.value,
		);
		if (
			preferences.success &&
			workspaceMuteState(preferences.data, workspace.id, now).muted
		) {
			retryAt = now + 60_000;
			continue;
		}
		if (
			await hasVisiblePushConversation(
				db,
				scope,
				workspacePushVisibilityKey(workspace.id),
				now,
			)
		) {
			retryAt = now + 60_000;
			continue;
		}
		// Claim the request before sending so an alarm retry does not repeat it.
		await savePushConfig(db, scope, claimKey, { seq: waiting.seq });
		await sendPushToDevices(context, scope, keys, {
			title: workspace.name,
			body: messageBody(waiting),
			url: `/workspace/${workspace.id}${
				waiting.conversationId
					? `?conversation=${encodeURIComponent(waiting.conversationId)}&pane=chat`
					: ""
			}`,
			conversationId: workspacePushVisibilityKey(workspace.id),
			// One notification per workspace: a later request replaces it.
			tag: `approval:${workspace.id}`,
		});
		notified += 1;
	}
	return { notified, ...(retryAt ? { retryAt } : {}) };
}

/** Notify one workspace after its object publishes approval or chat activity. */
export async function pushWaitingWorkspaceApprovals(
	context: Pick<BaseContext, "db" | "env">,
	db: DbQueryClient,
	now: number,
	scope: { organizationId: string; workspaceId: string },
): Promise<{ workspaces: number; notified: number; retryAt?: number }> {
	const keys = webPushKeys(context.env);
	if (!keys) return { workspaces: 0, notified: 0 };
	const workspace = await getOsWorkspace(db, scope);
	if (!workspace || workspace.status !== "active")
		return { workspaces: 0, notified: 0 };
	const rows = await listWorkspaceUnreadFeed(db, {
		...scope,
		afterSeq: 0,
		readerIds: [],
		runsOnly: true,
	});
	let notified = await notifyWorkspaceTediChats(
		context,
		db,
		workspace,
		rows,
		new Date(now - MOVED_WINDOW_MS).toISOString(),
	);
	const since = new Date(now - APPROVAL_PUSH_REQUEST_AGE_MS).toISOString();
	const waiting = waitingApprovalRequests(rows, since);
	let retryAt: number | undefined;
	if (waiting) {
		const result = await notifyWaitingApprovals(context, db, keys, {
			workspace,
			waiting,
			rows,
			now,
		});
		notified += result.notified;
		retryAt = result.retryAt;
	}
	return {
		workspaces: waiting ? 1 : 0,
		notified,
		...(retryAt ? { retryAt } : {}),
	};
}
