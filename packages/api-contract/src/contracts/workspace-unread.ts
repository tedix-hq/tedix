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
		list: oc.input(z.object({})).output(WorkspaceUnreadListSchema),
		markRead: oc
			.input(WorkspaceMarkReadInputSchema)
			.output(WorkspaceUnreadStateSchema),
		markAllRead: oc
			.input(z.object({}))
			.output(z.object({ ok: z.literal(true) })),
	});
