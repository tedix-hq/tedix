import { and, eq } from "drizzle-orm";
import type { DbClient } from "../client";
import { coreTable } from "../core-store/client";
import { anyIds } from "../core-store/dialect";
import {
	type KernelConversationGrant,
	kernelConversationGrants,
} from "../schema/cognitive-runtime";

export async function listKernelConversationGrants(
	db: DbClient,
	input: { organizationId: string; conversationId: string; limit?: number },
): Promise<KernelConversationGrant[]> {
	const table = coreTable(db, kernelConversationGrants);
	return db
		.select()
		.from(table)
		.where(
			and(
				eq(table.organizationId, input.organizationId),
				eq(table.conversationId, input.conversationId),
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
	if (input.conversationIds.length === 0) return grouped;
	const table = coreTable(db, kernelConversationGrants);
	const rows = await db
		.select()
		.from(table)
		.where(
			and(
				eq(table.organizationId, input.organizationId),
				anyIds(db, table.conversationId, input.conversationIds),
			),
		);
	for (const row of rows) {
		const list = grouped.get(row.conversationId) ?? [];
		list.push(row);
		grouped.set(row.conversationId, list);
	}
	return grouped;
}
