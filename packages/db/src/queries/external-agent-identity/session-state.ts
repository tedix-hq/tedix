import { and, eq } from "drizzle-orm";
import type { DbClient } from "../../client";
import {
	type ExternalAgentSession,
	externalAgentSessions,
} from "../../schema/external-agent-identity";
import {
	ExternalAgentIdentityError,
	getExternalAgentPrincipal,
} from "./principals";

export async function getExternalAgentSession(
	db: DbClient,
	params: { organizationId: string; principalId: string; sessionId: string },
): Promise<ExternalAgentSession | null> {
	const rows = await db
		.select()
		.from(externalAgentSessions)
		.where(
			and(
				eq(externalAgentSessions.organizationId, params.organizationId),
				eq(externalAgentSessions.principalId, params.principalId),
				eq(externalAgentSessions.id, params.sessionId),
			),
		)
		.limit(1);
	return rows[0] ?? null;
}

export async function diagnoseMutableSession(
	db: DbClient,
	params: { organizationId: string; principalId: string; sessionId: string },
	options: { requireActivePrincipal?: boolean } = {},
): Promise<never> {
	const principal = await getExternalAgentPrincipal(db, params);
	if (!principal) {
		throw new ExternalAgentIdentityError(
			"principal_not_found",
			"External-agent principal not found",
		);
	}
	if (
		options.requireActivePrincipal !== false &&
		principal.status !== "active"
	) {
		throw new ExternalAgentIdentityError(
			"principal_inactive",
			`External-agent principal is ${principal.status}`,
		);
	}
	const session = await getExternalAgentSession(db, params);
	if (!session) {
		throw new ExternalAgentIdentityError(
			"session_not_found",
			"External Agent-Session not found",
		);
	}
	throw new ExternalAgentIdentityError(
		"session_ended",
		"External Agent-Session has ended",
	);
}
