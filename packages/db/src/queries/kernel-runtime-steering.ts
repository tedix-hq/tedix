import { and, eq, inArray } from "drizzle-orm";
import type { DbQueryClient } from "../query-client";
import { kernelRuntimeEvents } from "../schema/cognitive-runtime";
import { chunkForBoundParams } from "../utils/batch";
import { readLogStores } from "../utils/log-store";

export function steeringWithdrawalEventId(
	organizationId: string,
	messageId: string,
): string {
	return `home:${organizationId}:steering-withdrawn:${messageId}`;
}

export async function listWithdrawnSteeringMessageIds(
	db: DbQueryClient,
	input: {
		organizationId: string;
		conversationId: string;
		messageIds: string[];
	},
): Promise<string[]> {
	if (!input.messageIds.length) return [];
	const pages = await readLogStores(db, (store) =>
		listWithdrawnSteeringMessageIds(store, input),
	);
	if (pages) return [...new Set(pages.flat())];
	const withdrawn: string[] = [];
	for (const ids of chunkForBoundParams([...new Set(input.messageIds)], 50)) {
		const rows = await db
			.select({ messageId: kernelRuntimeEvents.messageId })
			.from(kernelRuntimeEvents)
			.where(
				and(
					eq(kernelRuntimeEvents.organizationId, input.organizationId),
					eq(kernelRuntimeEvents.conversationId, input.conversationId),
					eq(kernelRuntimeEvents.kind, "message.progress"),
					inArray(
						kernelRuntimeEvents.id,
						ids.map((id) =>
							steeringWithdrawalEventId(input.organizationId, id),
						),
					),
				),
			);
		withdrawn.push(
			...rows.flatMap((row) => (row.messageId ? [row.messageId] : [])),
		);
	}
	return withdrawn;
}
