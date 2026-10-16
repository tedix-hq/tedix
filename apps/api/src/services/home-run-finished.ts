import { listHomeRunFinishedEvents } from "@tedix/db/queries/kernel-runtime-events";
import { resolveKernelConversationAccess } from "../kernel/conversation-access";
import type { BaseContext } from "../rpc/orpc";

export async function pollHomeRunFinished(
	context: BaseContext,
	input: {
		after?: { at: string; id: string } | null;
		conversationId?: string;
		limit: number;
	},
	organizationId: string,
) {
	const rows = await listHomeRunFinishedEvents(context.db, {
		organizationId,
		...input,
		head: input.after == null,
		limit: input.after == null ? 1 : input.limit + 1,
	});
	if (input.after == null)
		return {
			events: [],
			after: rows[0] ? { at: rows[0].at, id: rows[0].id } : { at: "", id: "" },
			hasMore: false,
		};
	const page = rows.slice(0, input.limit);
	const events = [];
	for (const row of page) {
		const access = await resolveKernelConversationAccess(context.db, {
			organizationId,
			conversationId: row.conversationId,
			descopeUserId: context.descopeUserId ?? context.user?.sub ?? null,
			required: "read",
		});
		if (!access.allowed) continue;
		events.push({
			eventId: `evt_home_${row.parentRunId ?? ""}_${row.runId}_${row.status}`,
			timestamp: row.at,
			data: {
				organization_id: organizationId,
				conversation_id: row.conversationId,
				run_id: row.runId,
				parent_run_id: row.parentRunId,
				status: row.status,
			},
		});
	}
	const last = page.at(-1);
	return {
		events,
		after: last ? { at: last.at, id: last.id } : input.after,
		hasMore: rows.length > input.limit,
	};
}
