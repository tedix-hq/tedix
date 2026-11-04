import { and, asc, eq } from "drizzle-orm";
import type { DbClient } from "../client";
import {
	type KernelConversationSessionPolicyRow,
	kernelConversationSessionPolicies,
} from "../schema/conversation-session-policies";

export interface ConversationSessionPolicyScopeParams {
	organizationId: string;
	conversationId: string;
}

export interface GrantConversationSessionPolicyParams extends ConversationSessionPolicyScopeParams {
	scopeKey: string;
	grantedByType: KernelConversationSessionPolicyRow["grantedByType"];
	grantedById: string;
	reason?: string | null;
	expiresAt?: string | null;
	now?: string;
}

export function conversationSessionPolicyId(
	params: ConversationSessionPolicyScopeParams & { scopeKey: string },
): string {
	return `${params.organizationId}:${params.conversationId}:${params.scopeKey}`;
}

/**
 * Record (or refresh) a standing "allow" for one scope in one conversation.
 * Idempotent per scope: a repeat grant updates who granted it and when.
 */
export async function grantConversationSessionPolicy(
	db: DbClient,
	params: GrantConversationSessionPolicyParams,
): Promise<KernelConversationSessionPolicyRow> {
	const createdAt = params.now ?? new Date().toISOString();
	const values = {
		id: conversationSessionPolicyId(params),
		organizationId: params.organizationId,
		conversationId: params.conversationId,
		scopeKey: params.scopeKey,
		effect: "allow" as const,
		grantedByType: params.grantedByType,
		grantedById: params.grantedById,
		reason: params.reason ?? null,
		createdAt,
		expiresAt: params.expiresAt ?? null,
	};
	const rows = await db
		.insert(kernelConversationSessionPolicies)
		.values(values)
		.onConflictDoUpdate({
			target: kernelConversationSessionPolicies.id,
			set: {
				effect: values.effect,
				grantedByType: values.grantedByType,
				grantedById: values.grantedById,
				reason: values.reason,
				createdAt: values.createdAt,
				expiresAt: values.expiresAt,
			},
		})
		.returning();
	return rows[0] ?? values;
}

/** Live (unexpired) standing decisions for a conversation, oldest first. */
export async function listConversationSessionPolicies(
	db: DbClient,
	params: ConversationSessionPolicyScopeParams,
	options: { now?: string } = {},
): Promise<KernelConversationSessionPolicyRow[]> {
	const now = options.now ?? new Date().toISOString();
	const rows = await db
		.select()
		.from(kernelConversationSessionPolicies)
		.where(
			and(
				eq(
					kernelConversationSessionPolicies.organizationId,
					params.organizationId,
				),
				eq(
					kernelConversationSessionPolicies.conversationId,
					params.conversationId,
				),
			),
		)
		.orderBy(asc(kernelConversationSessionPolicies.createdAt));
	return rows.filter((row) => !row.expiresAt || row.expiresAt > now);
}

/** Remove every standing decision of a conversation (conversation delete). */
export async function clearConversationSessionPolicies(
	db: DbClient,
	params: ConversationSessionPolicyScopeParams,
): Promise<void> {
	await db
		.delete(kernelConversationSessionPolicies)
		.where(
			and(
				eq(
					kernelConversationSessionPolicies.organizationId,
					params.organizationId,
				),
				eq(
					kernelConversationSessionPolicies.conversationId,
					params.conversationId,
				),
			),
		);
}
