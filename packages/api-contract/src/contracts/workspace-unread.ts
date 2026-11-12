import "@orpc/openapi/extensions/route";
import { oc } from "@orpc/contract";
import * as z from "zod";
import { baseErrors } from "../errors";
import {
	WorkspaceMarkReadInputSchema,
	WorkspaceUnreadListSchema,
	WorkspaceUnreadStateSchema,
	WorkspaceUnreadSummarySchema,
} from "../schemas/workspace-unread";

export const workspaceUnreadContract = oc
	.route({ tags: ["internal"] })
	.errors(baseErrors)
	.router({
		/** Counts per workspace and the total, for badges and the app icon. */
		summary: oc.input(z.object({})).output(WorkspaceUnreadSummarySchema),
		/** One workspace: unread chat count and the files with unread changes. */
		workspace: oc
			.input(z.object({ workspaceId: z.string().uuid() }))
			.output(WorkspaceUnreadStateSchema),
		/** Everything unread, newest first, grouped by workspace. */
		list: oc.input(z.strictObject({})).output(WorkspaceUnreadListSchema),
		markRead: oc
			.input(WorkspaceMarkReadInputSchema)
			.output(WorkspaceUnreadStateSchema),
		/**
		 * The caller just posted in a workspace chat: notify people who are
		 * mentioned or took part in that conversation and do not have the
		 * workspace open. The server checks the post itself; `pending` means it
		 * has not arrived in the activity feed yet and the call can be repeated.
		 */
		notifyChat: oc
			.input(
				z.object({
					workspaceId: z.string().uuid(),
					conversationId: z.string().min(1).max(200),
					mentionedUserIds: z.array(z.string().min(1).max(200)).max(10),
				}),
			)
			.output(
				z.object({
					status: z.enum(["sent", "pending", "none"]),
					notified: z.number().int().nonnegative(),
				}),
			),
		markAllRead: oc
			.input(z.object({}))
			.output(z.object({ ok: z.literal(true) })),
	});
