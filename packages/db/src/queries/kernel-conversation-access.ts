import { and, eq } from "drizzle-orm";
import type { DbClient } from "../client";
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
