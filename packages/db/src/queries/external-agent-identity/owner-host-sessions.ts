/**
 * Owner-host Agent-Sessions: plugin-only MCP hosts authenticate as their human
 * owner, so their accountable principal is an `owner_user` binding to that
 * owner's canonical user id. These queries are the single resolver used by
 * both the edge preflight and Work admission; a session resolves only for the
 * exact owning user, organization, and active principal/session pair.
 */

import { and, eq } from "drizzle-orm";
import type { DbClient } from "../../client";
import {
	type ExternalAgentPrincipal,
	type ExternalAgentSession,
	externalAgentPrincipals,
	externalAgentSessions,
} from "../../schema/external-agent-identity";
import { prefixedColumns } from "../../utils/select";

export const OWNER_USER_BINDING_TYPE = "owner_user" as const;

export async function getOwnerUserExternalAgentPrincipal(
	db: DbClient,
	params: { organizationId: string; userId: string },
): Promise<ExternalAgentPrincipal | null> {
	const rows = await db
		.select()
		.from(externalAgentPrincipals)
		.where(
			and(
				eq(externalAgentPrincipals.organizationId, params.organizationId),
				eq(
					externalAgentPrincipals.credentialBindingType,
					OWNER_USER_BINDING_TYPE,
				),
				eq(externalAgentPrincipals.credentialBindingId, params.userId),
			),
		)
		.limit(1);
	return rows[0] ?? null;
}

export type ResolveOwnerHostSessionParams = {
	organizationId: string;
	/** Canonical user id of the authenticated human owner. */
	userId: string;
	sessionId: string;
};

export type ResolveOwnerHostSessionResult = {
	principal: ExternalAgentPrincipal;
	session: ExternalAgentSession;
};

/**
 * Resolve an active owner-host session for exactly this user and organization.
 * Returns null for an unknown, ended, foreign-organization, other-user, or
 * machine-credential (api_key/workload) session, and for a suspended or
 * retired principal.
 */
export async function resolveOwnerHostSession(
	db: DbClient,
	params: ResolveOwnerHostSessionParams,
): Promise<ResolveOwnerHostSessionResult | null> {
	const rows = await db
		.select({
			principal: prefixedColumns(externalAgentPrincipals, "principal"),
			session: prefixedColumns(externalAgentSessions, "session"),
		})
		.from(externalAgentSessions)
		.innerJoin(
			externalAgentPrincipals,
			and(
				eq(
					externalAgentPrincipals.organizationId,
					externalAgentSessions.organizationId,
				),
				eq(externalAgentPrincipals.id, externalAgentSessions.principalId),
			),
		)
		.where(
			and(
				eq(externalAgentSessions.organizationId, params.organizationId),
				eq(externalAgentSessions.id, params.sessionId),
				eq(externalAgentSessions.status, "active"),
				eq(externalAgentPrincipals.status, "active"),
				eq(
					externalAgentPrincipals.credentialBindingType,
					OWNER_USER_BINDING_TYPE,
				),
				eq(externalAgentPrincipals.credentialBindingId, params.userId),
			),
		)
		.limit(1);
	const row = rows[0];
	if (!row) return null;
	return { principal: row.principal, session: row.session };
}
