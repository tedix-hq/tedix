import { and, eq, inArray } from "drizzle-orm";
import type { DbClient } from "../client";
import { chunkForBoundParams } from "../utils/batch";
import {
	type KernelConversationGrant,
	kernelConversationGrants,
} from "../schema/cognitive-runtime";

export async function listKernelConversationGrants(
	db: DbClient,
	input: { organizationId: string; conversationId: string; limit?: number },
): Promise<KernelConversationGrant[]> {
	return db
		.select()
		.from(kernelConversationGrants)
		.where(
			and(
				eq(kernelConversationGrants.organizationId, input.organizationId),
				eq(kernelConversationGrants.conversationId, input.conversationId),
			),
		)
		.limit(input.limit ?? 50);
}

/** Every grant row of each conversation in `conversationIds`, grouped by conversation. */
export async function listKernelConversationGrantsByConversation(
	db: DbClient,
	input: { organizationId: string; conversationIds: string[] },
): Promise<Map<string, KernelConversationGrant[]>> {
	const grouped = new Map<string, KernelConversationGrant[]>();
	for (const chunk of chunkForBoundParams(input.conversationIds, 90)) {
		const rows = await db
			.select()
			.from(kernelConversationGrants)
			.where(
				and(
					eq(kernelConversationGrants.organizationId, input.organizationId),
					inArray(kernelConversationGrants.conversationId, chunk),
				),
			);
		for (const row of rows) {
			const list = grouped.get(row.conversationId) ?? [];
			list.push(row);
			grouped.set(row.conversationId, list);
		}
	}
	return grouped;
}
