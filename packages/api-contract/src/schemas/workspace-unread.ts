import * as z from "zod";

/**
 * What is new for one person in the workspaces they have opened: chat
 * messages, agent results and file changes that someone else made since the
 * person last looked.
 */

export const WorkspaceUnreadKindSchema = z.enum([
	/** A person posted in the workspace chat. */
	"message",
	/** An agent finished its reply. */
	"agent_reply",
	/** An agent run stopped without finishing. */
	"agent_stopped",
	/** An agent is waiting for a decision. */
	"needs_decision",
	/** A file was changed. */
	"file",
]);
export type WorkspaceUnreadKind = z.infer<typeof WorkspaceUnreadKindSchema>;

export const WorkspaceUnreadItemSchema = z.object({
	/** Stable within the workspace: the feed position of the newest change. */
	id: z.string(),
	kind: WorkspaceUnreadKindSchema,
	/** True when an agent, not a person, made the change. */
	byAgent: z.boolean(),
	actorId: z.string(),
	occurredAt: z.string(),
	/** Set for a file. */
	outputId: z.string().optional(),
	title: z.string().nullable().optional(),
	/** Set for chat rows once the workspace records them. */
	conversationId: z.string().optional(),
	turnId: z.string().optional(),
});
export type WorkspaceUnreadItem = z.infer<typeof WorkspaceUnreadItemSchema>;

export const WorkspaceUnreadCountsSchema = z.object({
	workspaceId: z.string(),
	/** Unread chat messages and agent results. */
	chat: z.number().int().nonnegative(),
	/** Files changed by someone else and not opened since. */
	files: z.number().int().nonnegative(),
	total: z.number().int().nonnegative(),
});
export type WorkspaceUnreadCounts = z.infer<typeof WorkspaceUnreadCountsSchema>;

export const WorkspaceUnreadSummarySchema = z.object({
	total: z.number().int().nonnegative(),
	workspaces: z.array(WorkspaceUnreadCountsSchema),
});
export type WorkspaceUnreadSummary = z.infer<
	typeof WorkspaceUnreadSummarySchema
>;

export const WorkspaceUnreadStateSchema = WorkspaceUnreadCountsSchema.extend({
	/** Ids of the files with unread changes. */
	fileIds: z.array(z.string()),
});
export type WorkspaceUnreadState = z.infer<typeof WorkspaceUnreadStateSchema>;

export const WorkspaceUnreadGroupSchema = z.object({
	workspaceId: z.string(),
	workspaceName: z.string(),
	latestAt: z.string(),
	items: z.array(WorkspaceUnreadItemSchema),
});
export const WorkspaceUnreadListSchema = z.object({
	total: z.number().int().nonnegative(),
	groups: z.array(WorkspaceUnreadGroupSchema),
});
export type WorkspaceUnreadList = z.infer<typeof WorkspaceUnreadListSchema>;

export const WorkspaceMarkReadInputSchema = z.object({
	workspaceId: z.string().uuid(),
	target: z.discriminatedUnion("type", [
		z.object({ type: z.literal("chat") }),
		z.object({ type: z.literal("file"), outputId: z.string().uuid() }),
		z.object({ type: z.literal("all") }),
	]),
});
