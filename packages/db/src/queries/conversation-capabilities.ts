import { and, asc, eq } from "drizzle-orm";
import type { DbClient } from "../client";
import {
	type KernelConversationCapability,
	kernelConversationCapabilities,
} from "../schema/conversation-capabilities";

export class ConversationCapabilityConflictError extends Error {
	constructor() {
		super("Replay name or capability is already attached to this conversation");
		this.name = "ConversationCapabilityConflictError";
	}
}

export async function attachConversationCapability(
	db: DbClient,
	input: typeof kernelConversationCapabilities.$inferInsert,
): Promise<KernelConversationCapability> {
	const rows = await db
		.insert(kernelConversationCapabilities)
		.values(input)
		.onConflictDoNothing()
		.returning();
	const row = rows[0];
	if (!row) {
		const existing = await db
			.select()
			.from(kernelConversationCapabilities)
			.where(
				and(
					eq(
						kernelConversationCapabilities.organizationId,
						input.organizationId,
					),
					eq(
						kernelConversationCapabilities.conversationId,
						input.conversationId,
					),
					eq(kernelConversationCapabilities.capabilityId, input.capabilityId),
					eq(kernelConversationCapabilities.replayName, input.replayName),
				),
			)
			.limit(1);
		if (existing[0]) return existing[0];
		throw new ConversationCapabilityConflictError();
	}
	return row;
}

export async function listConversationCapabilities(
	db: DbClient,
	input: { organizationId: string; conversationId: string },
): Promise<KernelConversationCapability[]> {
	return db
		.select()
		.from(kernelConversationCapabilities)
		.where(
			and(
				eq(kernelConversationCapabilities.organizationId, input.organizationId),
				eq(kernelConversationCapabilities.conversationId, input.conversationId),
			),
		)
		.orderBy(asc(kernelConversationCapabilities.replayName));
}

export async function detachConversationCapability(
	db: DbClient,
	input: {
		organizationId: string;
		conversationId: string;
		referenceId: string;
	},
): Promise<KernelConversationCapability | null> {
	const rows = await db
		.delete(kernelConversationCapabilities)
		.where(
			and(
				eq(kernelConversationCapabilities.id, input.referenceId),
				eq(kernelConversationCapabilities.organizationId, input.organizationId),
				eq(kernelConversationCapabilities.conversationId, input.conversationId),
			),
		)
		.returning();
	return rows[0] ?? null;
}
