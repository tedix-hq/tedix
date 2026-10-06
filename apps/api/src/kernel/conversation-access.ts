import type { DbClient } from "@tedix/db/client";
import { listKernelConversationGrants } from "@tedix/db/queries/kernel-conversation-access";
import type { KernelConversationGrantAccess } from "@tedix/db/schema";
import { withTransientD1ReadRetry } from "@tedix/db/utils/d1-retry";
import { safeExceptionTopology } from "../lib/safe-log-metadata";

export type KernelConversationAccessLevel = KernelConversationGrantAccess;

export type KernelConversationAccessPolicy = "grant" | "org-wide";

export interface KernelConversationAccessDecision {
	allowed: boolean;
	access: KernelConversationGrantAccess | null;
	policy: KernelConversationAccessPolicy;
}

const ACCESS_RANK: Record<KernelConversationGrantAccess, number> = {
	read: 1,
	edit: 2,
	owner: 3,
};

function accessAllows(
	actual: KernelConversationGrantAccess,
	required: KernelConversationAccessLevel,
): boolean {
	return ACCESS_RANK[actual] >= ACCESS_RANK[required];
}

export async function resolveKernelConversationAccess(
	db: DbClient,
	input: {
		conversationId: string;
		descopeUserId: string | null | undefined;
		organizationId: string;
		required: KernelConversationAccessLevel;
	},
): Promise<KernelConversationAccessDecision> {
	let grantRows: Awaited<ReturnType<typeof listKernelConversationGrants>>;
	try {
		grantRows = await withTransientD1ReadRetry(
			`kernel conversation grants ${input.organizationId}:${input.conversationId}`,
			() =>
				listKernelConversationGrants(db, {
					organizationId: input.organizationId,
					conversationId: input.conversationId,
					limit: 50,
				}),
		);
	} catch (error) {
		// Fail CLOSED on any DB error. A missing migration, a mispointed D1
		// binding, or a transient read failure must never widen access — the
		// conversation ACL denies rather than defaulting to allow-all. Do not
		// re-add a "no such table" (or any error-message) allow-all shortcut:
		// that turned an infrastructure fault into a silent authorization bypass.
		console.error({
			component: "api.kernel.conversation-access",
			event: "conversation_access_lookup_failed",
			exception: safeExceptionTopology(error),
		});
		return { allowed: false, access: null, policy: "grant" };
	}

	if (grantRows.length === 0) {
		return { allowed: true, access: null, policy: "org-wide" };
	}

	const userId = input.descopeUserId?.trim();
	if (!userId) return { allowed: false, access: null, policy: "grant" };

	const grant = grantRows
		.filter((row) => row.granteeDescopeUserId === userId)
		.sort((a, b) => ACCESS_RANK[b.access] - ACCESS_RANK[a.access])[0];
	if (!grant) return { allowed: false, access: null, policy: "grant" };

	return {
		allowed: accessAllows(grant.access, input.required),
		access: grant.access,
		policy: "grant",
	};
}
