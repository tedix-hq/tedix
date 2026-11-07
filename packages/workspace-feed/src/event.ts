/**
 * The workspace change event, as every side of the feed sees it. The zod
 * contract lives in `@tedix/api-contract/schemas/workspace-feed`; this module
 * re-exports it and adds the small helpers producers and consumers share.
 */

export {
	WORKSPACE_CHANGE_EXCERPT_MAX,
	WORKSPACE_CHANGE_MESSAGE_KIND,
	WorkspaceChangeEventSchema,
	WorkspaceChangeQueueMessageSchema,
	WorkspaceChangeSummarySchema,
	WorkspaceFeedSnapshotSchema,
	workspaceChangeIdempotencyKey,
} from "@tedix/api-contract/schemas/workspace-feed";
export type {
	WorkspaceChangeActor,
	WorkspaceChangeEvent,
	WorkspaceChangeInput,
	WorkspaceChangeKind,
	WorkspaceChangeQueueMessage,
	WorkspaceChangeSummary,
	WorkspaceFeedSnapshot,
} from "@tedix/api-contract/schemas/workspace-feed";

import {
	WORKSPACE_CHANGE_MESSAGE_KIND,
	type WorkspaceChangeEvent,
	type WorkspaceChangeQueueMessage,
	WorkspaceChangeQueueMessageSchema,
} from "@tedix/api-contract/schemas/workspace-feed";

export function toWorkspaceChangeMessage(
	event: WorkspaceChangeEvent,
): WorkspaceChangeQueueMessage {
	return { kind: WORKSPACE_CHANGE_MESSAGE_KIND, event };
}

/** Parse one queue body; `null` for anything that is not a workspace change. */
export function parseWorkspaceChangeMessage(
	body: unknown,
): WorkspaceChangeQueueMessage | null {
	if (
		!body ||
		typeof body !== "object" ||
		(body as { kind?: unknown }).kind !== WORKSPACE_CHANGE_MESSAGE_KIND
	)
		return null;
	const parsed = WorkspaceChangeQueueMessageSchema.safeParse(body);
	return parsed.success ? parsed.data : null;
}
