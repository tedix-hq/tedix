import type { DbQueryClient } from "../../query-client";
import { externalAgentWorkloadTokenUses } from "../../schema/external-agent-identity";

export interface ConsumeExternalAgentWorkloadTokenParams {
	id: string;
	organizationId: string;
	principalId: string;
	issuer: string;
	subject: string;
	audience: string;
	jti: string;
	externalSessionKey: string;
	tokenIssuedAt: string;
	tokenExpiresAt: string;
	consumedAt: string;
}

/** Atomically returns false when the issuer+jti assertion was already used. */
export async function consumeExternalAgentWorkloadToken(
	db: DbQueryClient,
	params: ConsumeExternalAgentWorkloadTokenParams,
): Promise<boolean> {
	const rows = await db
		.insert(externalAgentWorkloadTokenUses)
		.values(params)
		.onConflictDoNothing({
			target: [
				externalAgentWorkloadTokenUses.issuer,
				externalAgentWorkloadTokenUses.jti,
			],
		})
		.returning({ id: externalAgentWorkloadTokenUses.id });
	return rows.length === 1;
}
