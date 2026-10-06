import { and, asc, eq } from "drizzle-orm";
import type { DbClient } from "../client";
import {
	type KernelConversationArtifactPin,
	kernelConversationArtifactPins,
} from "../schema/conversation-artifact-pins";

export class ConversationArtifactPinConflictError extends Error {
	constructor() {
		super(
			"Replay name or artifact revision is already pinned to this conversation",
		);
		this.name = "ConversationArtifactPinConflictError";
	}
}

export async function attachConversationArtifactPin(
	db: DbClient,
	input: typeof kernelConversationArtifactPins.$inferInsert,
): Promise<KernelConversationArtifactPin> {
	const rows = await db
		.insert(kernelConversationArtifactPins)
		.values(input)
		.onConflictDoNothing()
		.returning();
	const row = rows[0];
	if (row) return row;
	const existing = await db
		.select()
		.from(kernelConversationArtifactPins)
		.where(
			and(
				eq(kernelConversationArtifactPins.organizationId, input.organizationId),
				eq(kernelConversationArtifactPins.conversationId, input.conversationId),
				eq(kernelConversationArtifactPins.artifactId, input.artifactId),
				eq(kernelConversationArtifactPins.revisionDigest, input.revisionDigest),
				eq(kernelConversationArtifactPins.replayName, input.replayName),
			),
		)
		.limit(1);
	if (existing[0]) return existing[0];
	throw new ConversationArtifactPinConflictError();
}

export async function listConversationArtifactPins(
	db: DbClient,
	input: { organizationId: string; conversationId: string },
): Promise<KernelConversationArtifactPin[]> {
	return db
		.select()
		.from(kernelConversationArtifactPins)
		.where(
			and(
				eq(kernelConversationArtifactPins.organizationId, input.organizationId),
				eq(kernelConversationArtifactPins.conversationId, input.conversationId),
			),
		)
		.orderBy(asc(kernelConversationArtifactPins.replayName));
}

export async function detachConversationArtifactPin(
	db: DbClient,
	input: { organizationId: string; conversationId: string; pinId: string },
): Promise<KernelConversationArtifactPin | null> {
	const rows = await db
		.delete(kernelConversationArtifactPins)
		.where(
			and(
				eq(kernelConversationArtifactPins.id, input.pinId),
				eq(kernelConversationArtifactPins.organizationId, input.organizationId),
				eq(kernelConversationArtifactPins.conversationId, input.conversationId),
			),
		)
		.returning();
	return rows[0] ?? null;
}
