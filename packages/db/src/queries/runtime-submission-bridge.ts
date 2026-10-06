import { and, asc, eq } from "drizzle-orm";
import type { DbClient } from "../client";
import { tediRuntimeEvents } from "../schema/cognitive-runtime";

export async function getTediSubmissionInputEvent(
	db: DbClient,
	input: { organizationId: string; tediId: string; runId: string },
) {
	const [row] = await db
		.select({
			conversationId: tediRuntimeEvents.conversationId,
			payload: tediRuntimeEvents.payload,
		})
		.from(tediRuntimeEvents)
		.where(
			and(
				eq(tediRuntimeEvents.organizationId, input.organizationId),
				eq(tediRuntimeEvents.tediId, input.tediId),
				eq(tediRuntimeEvents.runId, input.runId),
				eq(tediRuntimeEvents.kind, "message.received"),
			),
		)
		.orderBy(asc(tediRuntimeEvents.createdAt))
		.limit(1);
	return row;
}
