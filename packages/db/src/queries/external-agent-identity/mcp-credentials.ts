import {
	and,
	desc,
	eq,
	exists,
	gt,
	inArray,
	isNull,
	lt,
	lte,
	ne,
	or,
	sql,
} from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import type { DbClient } from "../../client";
import { apiKeys } from "../../schema/api-keys";
import {
	type ExternalAgentMcpCredential,
	type ExternalAgentPrincipal,
	type ExternalAgentSession,
	externalAgentMcpCredentials,
	externalAgentMcpIssuanceLeases,
	externalAgentPrincipals,
	externalAgentSessions,
} from "../../schema/external-agent-identity";
import { ExternalAgentIdentityError } from "./principals";
import { diagnoseMutableSession } from "./session-state";
import { prefixedColumns } from "../../utils/select";

const activeSession = alias(externalAgentSessions, "active_session");
/** `activePrincipalKey` references this alias by name. */
const activePrincipal = alias(externalAgentPrincipals, "active_principal");

export async function acquireExternalAgentMcpIssuanceLease(
	db: DbClient,
	input: {
		id: string;
		organizationId: string;
		principalId: string;
		sessionId: string;
		mcpServerId: string;
		ownerToken: string;
		now: string;
		expiresAt: string;
	},
): Promise<boolean> {
	const rows = await db
		.insert(externalAgentMcpIssuanceLeases)
		.select(
			db
				.select({
					id: sql<string>`${input.id}`.as("id"),
					organizationId: sql<string>`${input.organizationId}`.as(
						"organization_id",
					),
					principalId: sql<string>`${input.principalId}`.as("principal_id"),
					sessionId: sql<string>`${input.sessionId}`.as("session_id"),
					mcpServerId: sql<string>`${input.mcpServerId}`.as("mcp_server_id"),
					ownerToken: sql<string>`${input.ownerToken}`.as("owner_token"),
					expiresAt: sql<string>`${input.expiresAt}`.as("expires_at"),
					createdAt: sql<string>`${input.now}`.as("created_at"),
					updatedAt: sql<string>`${input.now}`.as("updated_at"),
				})
				.from(activeSession)
				.innerJoin(activePrincipal, joinActivePrincipal())
				.where(
					and(
						activeSessionScope(input),
						eq(activePrincipal.status, "active"),
						activePrincipalKey(sql`${input.now}`),
					),
				),
		)
		.onConflictDoUpdate({
			target: [
				externalAgentMcpIssuanceLeases.organizationId,
				externalAgentMcpIssuanceLeases.principalId,
				externalAgentMcpIssuanceLeases.sessionId,
				externalAgentMcpIssuanceLeases.mcpServerId,
			],
			set: {
				id: sql`excluded.id`,
				ownerToken: sql`excluded.owner_token`,
				expiresAt: sql`excluded.expires_at`,
				updatedAt: sql`excluded.updated_at`,
			},
			setWhere: lte(externalAgentMcpIssuanceLeases.expiresAt, input.now),
		})
		.returning({ id: externalAgentMcpIssuanceLeases.id });
	return rows.length === 1;
}

export async function releaseExternalAgentMcpIssuanceLease(
	db: DbClient,
	input: {
		organizationId: string;
		principalId: string;
		sessionId: string;
		mcpServerId: string;
		ownerToken: string;
	},
): Promise<void> {
	await db
		.delete(externalAgentMcpIssuanceLeases)
		.where(
			and(
				eq(externalAgentMcpIssuanceLeases.organizationId, input.organizationId),
				eq(externalAgentMcpIssuanceLeases.principalId, input.principalId),
				eq(externalAgentMcpIssuanceLeases.sessionId, input.sessionId),
				eq(externalAgentMcpIssuanceLeases.mcpServerId, input.mcpServerId),
				eq(externalAgentMcpIssuanceLeases.ownerToken, input.ownerToken),
			),
		);
}

export async function recordExternalAgentMcpCredential(
	db: DbClient,
	input: {
		id: string;
		organizationId: string;
		principalId: string;
		sessionId: string;
		clientRecordId: string;
		mcpServerId: string;
		mcpServerUrl: string;
		issuedAt: string;
		expiresAt: string;
	},
): Promise<ExternalAgentMcpCredential> {
	const inserted = await db
		.insert(externalAgentMcpCredentials)
		.select(
			db
				.select({
					id: sql<string>`${input.id}`.as("id"),
					organizationId: sql<string>`${input.organizationId}`.as(
						"organization_id",
					),
					principalId: sql<string>`${input.principalId}`.as("principal_id"),
					sessionId: sql<string>`${input.sessionId}`.as("session_id"),
					clientRecordId: sql<string>`${input.clientRecordId}`.as(
						"client_record_id",
					),
					mcpServerId: sql<string>`${input.mcpServerId}`.as("mcp_server_id"),
					mcpServerUrl: sql<string>`${input.mcpServerUrl}`.as("mcp_server_url"),
					status: sql<"active">`'active'`.as("status"),
					issuedAt: sql<string>`${input.issuedAt}`.as("issued_at"),
					expiresAt: sql<string>`${input.expiresAt}`.as("expires_at"),
					revokedAt: sql<null>`NULL`.as("revoked_at"),
				})
				.from(activeSession)
				.innerJoin(activePrincipal, joinActivePrincipal())
				.where(
					and(
						activeSessionScope(input),
						eq(activePrincipal.status, "active"),
						activePrincipalKey(sql`${input.issuedAt}`),
					),
				),
		)
		.onConflictDoNothing()
		.returning({ id: externalAgentMcpCredentials.id });
	if (!inserted[0]) {
		const existingRows = await db
			.select()
			.from(externalAgentMcpCredentials)
			.where(
				eq(externalAgentMcpCredentials.clientRecordId, input.clientRecordId),
			)
			.limit(1);
		const existing = existingRows[0];
		if (existing) {
			if (
				existing.organizationId === input.organizationId &&
				existing.principalId === input.principalId &&
				existing.sessionId === input.sessionId &&
				existing.mcpServerId === input.mcpServerId &&
				existing.mcpServerUrl === input.mcpServerUrl &&
				existing.issuedAt === input.issuedAt &&
				existing.expiresAt === input.expiresAt
			) {
				return existing;
			}
			throw new ExternalAgentIdentityError(
				"binding_conflict",
				"MCP client record is already bound to another external-agent credential",
			);
		}
		await diagnoseMutableSession(db, input);
	}
	const rows = await db
		.select()
		.from(externalAgentMcpCredentials)
		.where(eq(externalAgentMcpCredentials.id, inserted[0]!.id))
		.limit(1);
	return rows[0]!;
}

export async function revokeExternalAgentMcpCredential(
	db: DbClient,
	params: {
		organizationId: string;
		principalId: string;
		sessionId: string;
		clientRecordId: string;
		revokedAt: string;
	},
): Promise<ExternalAgentMcpCredential> {
	const rows = await db
		.update(externalAgentMcpCredentials)
		.set({ status: "revoked", revokedAt: params.revokedAt })
		.where(
			and(
				eq(externalAgentMcpCredentials.organizationId, params.organizationId),
				eq(externalAgentMcpCredentials.principalId, params.principalId),
				eq(externalAgentMcpCredentials.sessionId, params.sessionId),
				eq(externalAgentMcpCredentials.clientRecordId, params.clientRecordId),
				eq(externalAgentMcpCredentials.status, "active"),
			),
		)
		.returning();
	if (!rows[0]) {
		throw new ExternalAgentIdentityError(
			"credential_not_found",
			"Active external-agent MCP credential not found",
		);
	}
	return rows[0];
}

/**
 * List expired active credentials and disabled principals' unfinished deletions.
 * Bounded and oldest-first so cleanup drains over successive reaper ticks.
 */
export async function listReapableExternalAgentMcpCredentials(
	db: DbClient,
	params: { expiredBefore: string; limit: number },
): Promise<Array<{ clientRecordId: string; mcpServerId: string }>> {
	return db
		.select({
			clientRecordId: externalAgentMcpCredentials.clientRecordId,
			mcpServerId: externalAgentMcpCredentials.mcpServerId,
		})
		.from(externalAgentMcpCredentials)
		.where(
			or(
				and(
					eq(externalAgentMcpCredentials.status, "active"),
					lt(externalAgentMcpCredentials.expiresAt, params.expiredBefore),
				),
				and(
					eq(externalAgentMcpCredentials.status, "revoked"),
					isNull(externalAgentMcpCredentials.providerCleanupAt),
					sql`EXISTS (SELECT 1 FROM ${externalAgentPrincipals} AS cleanup_principal WHERE cleanup_principal.organization_id = ${externalAgentMcpCredentials.organizationId} AND cleanup_principal.id = ${externalAgentMcpCredentials.principalId} AND json_extract(cleanup_principal.metadata, '$.providerCleanup') IN ('pending', 'failed'))`,
				),
			),
		)
		.orderBy(externalAgentMcpCredentials.expiresAt)
		.limit(params.limit);
}

/**
 * Mark a batch of credential rows revoked by their Descope client-record id,
 * after the reaper has deleted (or confirmed gone) the corresponding client.
 * Chunked to stay under D1's bound-parameter ceiling. Returns the number of
 * rows cleaned; existing revocation timestamps and history are preserved.
 */
export async function markExternalAgentMcpCredentialsReaped(
	db: DbClient,
	params: { clientRecordIds: string[]; revokedAt: string },
): Promise<number> {
	let revoked = 0;
	for (let i = 0; i < params.clientRecordIds.length; i += 50) {
		const chunk = params.clientRecordIds.slice(i, i + 50);
		if (chunk.length === 0) continue;
		const [rows] = await db.batch([
			db
				.update(externalAgentMcpCredentials)
				.set({
					status: "revoked",
					revokedAt: sql`coalesce(${externalAgentMcpCredentials.revokedAt}, ${params.revokedAt})`,
					providerCleanupAt: params.revokedAt,
				})
				.where(
					and(
						inArray(externalAgentMcpCredentials.clientRecordId, chunk),
						isNull(externalAgentMcpCredentials.providerCleanupAt),
					),
				)
				.returning({ id: externalAgentMcpCredentials.id }),
			db
				.update(externalAgentPrincipals)
				.set({
					metadata: sql`json_set(${externalAgentPrincipals.metadata}, '$.providerCleanup', 'done')`,
				})
				.where(
					and(
						sql`json_extract(${externalAgentPrincipals.metadata}, '$.providerCleanup') IN ('pending', 'failed')`,
						noOutstandingProviderCleanup(),
						sql`EXISTS (SELECT 1 FROM ${externalAgentMcpCredentials} AS completed_cleanup WHERE completed_cleanup.organization_id = ${externalAgentPrincipals.organizationId} AND completed_cleanup.principal_id = ${externalAgentPrincipals.id} AND completed_cleanup.client_record_id IN (SELECT value FROM json_each(${JSON.stringify(chunk)})))`,
					),
				),
		]);
		revoked += rows.length;
	}
	return revoked;
}

export async function listActiveExternalAgentMcpCredentials(
	db: DbClient,
	params: {
		organizationId: string;
		principalId: string;
		sessionId: string;
		mcpServerId: string;
	},
): Promise<ExternalAgentMcpCredential[]> {
	return db
		.select()
		.from(externalAgentMcpCredentials)
		.where(
			and(
				eq(externalAgentMcpCredentials.organizationId, params.organizationId),
				eq(externalAgentMcpCredentials.principalId, params.principalId),
				eq(externalAgentMcpCredentials.sessionId, params.sessionId),
				eq(externalAgentMcpCredentials.mcpServerId, params.mcpServerId),
				eq(externalAgentMcpCredentials.status, "active"),
			),
		)
		.orderBy(
			desc(externalAgentMcpCredentials.issuedAt),
			desc(externalAgentMcpCredentials.id),
		);
}

/** Bounded inventory candidates; callers must independently verify each session. */
export async function listMachinePolicyInventoryCandidates(
	db: DbClient,
	input: { organizationId: string; now: string },
) {
	return db
		.select({
			principalId: externalAgentMcpCredentials.principalId,
			sessionId: externalAgentMcpCredentials.sessionId,
			clientRecordId: externalAgentMcpCredentials.clientRecordId,
		})
		.from(externalAgentMcpCredentials)
		.where(
			and(
				eq(externalAgentMcpCredentials.organizationId, input.organizationId),
				eq(externalAgentMcpCredentials.status, "active"),
				gt(externalAgentMcpCredentials.expiresAt, input.now),
			),
		)
		.orderBy(desc(externalAgentMcpCredentials.issuedAt))
		.limit(100);
}

/** Tenant-scoped active credentials for governed retirement of one session. */
export async function listActiveExternalAgentMcpCredentialsForSession(
	db: DbClient,
	params: {
		organizationId: string;
		principalId: string;
		sessionId: string;
	},
): Promise<ExternalAgentMcpCredential[]> {
	return db
		.select()
		.from(externalAgentMcpCredentials)
		.where(
			and(
				eq(externalAgentMcpCredentials.organizationId, params.organizationId),
				eq(externalAgentMcpCredentials.principalId, params.principalId),
				eq(externalAgentMcpCredentials.sessionId, params.sessionId),
				eq(externalAgentMcpCredentials.status, "active"),
			),
		)
		.orderBy(
			desc(externalAgentMcpCredentials.issuedAt),
			desc(externalAgentMcpCredentials.id),
		);
}

export async function listActiveExternalAgentMcpCredentialsByServer(
	db: DbClient,
	mcpServerId: string,
): Promise<ExternalAgentMcpCredential[]> {
	return db
		.select()
		.from(externalAgentMcpCredentials)
		.where(
			and(
				eq(externalAgentMcpCredentials.mcpServerId, mcpServerId),
				eq(externalAgentMcpCredentials.status, "active"),
			),
		)
		.orderBy(externalAgentMcpCredentials.expiresAt);
}

export async function refreshExternalAgentMcpCredentialUnderLease(
	db: DbClient,
	params: {
		organizationId: string;
		principalId: string;
		sessionId: string;
		clientRecordId: string;
		issuedAt: string;
		expiresAt: string;
		mcpServerId: string;
		leaseOwnerToken: string;
		leaseNow: string;
	},
): Promise<ExternalAgentMcpCredential> {
	const issuanceLease = alias(externalAgentMcpIssuanceLeases, "issuance_lease");
	const rows = await db
		.update(externalAgentMcpCredentials)
		.set({ issuedAt: params.issuedAt, expiresAt: params.expiresAt })
		.where(
			and(
				eq(externalAgentMcpCredentials.organizationId, params.organizationId),
				eq(externalAgentMcpCredentials.principalId, params.principalId),
				eq(externalAgentMcpCredentials.sessionId, params.sessionId),
				eq(externalAgentMcpCredentials.clientRecordId, params.clientRecordId),
				eq(externalAgentMcpCredentials.mcpServerId, params.mcpServerId),
				eq(externalAgentMcpCredentials.status, "active"),
				exists(
					db
						.select({ one: sql`1` })
						.from(activePrincipal)
						.innerJoin(
							activeSession,
							and(
								eq(
									activeSession.organizationId,
									activePrincipal.organizationId,
								),
								eq(activeSession.principalId, activePrincipal.id),
							),
						)
						.where(
							and(
								eq(activePrincipal.organizationId, params.organizationId),
								eq(activePrincipal.id, params.principalId),
								eq(activePrincipal.status, "active"),
								eq(activeSession.id, params.sessionId),
								eq(activeSession.status, "active"),
								activePrincipalKey(sql`${params.leaseNow}`),
							),
						),
				),
				exists(
					db
						.select({ one: sql`1` })
						.from(issuanceLease)
						.where(
							and(
								eq(issuanceLease.organizationId, params.organizationId),
								eq(issuanceLease.principalId, params.principalId),
								eq(issuanceLease.sessionId, params.sessionId),
								eq(issuanceLease.mcpServerId, params.mcpServerId),
								eq(issuanceLease.ownerToken, params.leaseOwnerToken),
								gt(issuanceLease.expiresAt, params.leaseNow),
							),
						),
				),
			),
		)
		.returning({ id: externalAgentMcpCredentials.id });
	if (!rows[0]) {
		throw new ExternalAgentIdentityError(
			"binding_conflict",
			"External-agent MCP issuance lease no longer owns the credential refresh",
		);
	}
	const refreshed = await db
		.select()
		.from(externalAgentMcpCredentials)
		.where(eq(externalAgentMcpCredentials.id, rows[0].id))
		.limit(1);
	return refreshed[0]!;
}

export async function recordExternalAgentMcpCredentialUnderLease(
	db: DbClient,
	input: Parameters<typeof recordExternalAgentMcpCredential>[1] & {
		leaseOwnerToken: string;
		leaseNow: string;
	},
): Promise<ExternalAgentMcpCredential> {
	const issuanceLease = alias(externalAgentMcpIssuanceLeases, "issuance_lease");
	const inserted = await db
		.insert(externalAgentMcpCredentials)
		.select(
			db
				.select({
					id: sql<string>`${input.id}`.as("id"),
					organizationId: sql<string>`${input.organizationId}`.as(
						"organization_id",
					),
					principalId: sql<string>`${input.principalId}`.as("principal_id"),
					sessionId: sql<string>`${input.sessionId}`.as("session_id"),
					clientRecordId: sql<string>`${input.clientRecordId}`.as(
						"client_record_id",
					),
					mcpServerId: sql<string>`${input.mcpServerId}`.as("mcp_server_id"),
					mcpServerUrl: sql<string>`${input.mcpServerUrl}`.as("mcp_server_url"),
					status: sql<"active">`'active'`.as("status"),
					issuedAt: sql<string>`${input.issuedAt}`.as("issued_at"),
					expiresAt: sql<string>`${input.expiresAt}`.as("expires_at"),
					revokedAt: sql<null>`NULL`.as("revoked_at"),
				})
				.from(activeSession)
				.innerJoin(activePrincipal, joinActivePrincipal())
				.innerJoin(
					issuanceLease,
					and(
						eq(issuanceLease.organizationId, activeSession.organizationId),
						eq(issuanceLease.principalId, activeSession.principalId),
						eq(issuanceLease.sessionId, activeSession.id),
						eq(issuanceLease.mcpServerId, input.mcpServerId),
						eq(issuanceLease.ownerToken, input.leaseOwnerToken),
						gt(issuanceLease.expiresAt, input.leaseNow),
					),
				)
				.where(
					and(
						activeSessionScope(input),
						eq(activePrincipal.status, "active"),
						activePrincipalKey(sql`${input.leaseNow}`),
					),
				),
		)
		.onConflictDoNothing()
		.returning({ id: externalAgentMcpCredentials.id });
	if (!inserted[0]) {
		throw new ExternalAgentIdentityError(
			"binding_conflict",
			"External-agent MCP issuance lease no longer owns credential publication",
		);
	}
	const recorded = await db
		.select()
		.from(externalAgentMcpCredentials)
		.where(eq(externalAgentMcpCredentials.id, inserted[0].id))
		.limit(1);
	return recorded[0]!;
}

export async function resolveAuthorizedExternalAgentMcpSession(
	db: DbClient,
	params: {
		organizationId: string;
		principalId: string;
		sessionId: string;
		clientRecordId: string;
		now: string;
	},
): Promise<{
	principal: ExternalAgentPrincipal;
	session: ExternalAgentSession;
	credential: ExternalAgentMcpCredential;
} | null> {
	const credential = alias(externalAgentMcpCredentials, "credential");
	const agentSession = alias(externalAgentSessions, "agent_session");
	const principal = alias(externalAgentPrincipals, "principal");
	const boundKey = alias(apiKeys, "bound_key");
	const [row] = await db
		.select({
			principal: prefixedColumns(principal, "principal"),
			session: prefixedColumns(agentSession, "session"),
			credential: prefixedColumns(credential, "credential"),
		})
		.from(credential)
		.innerJoin(
			agentSession,
			and(
				eq(agentSession.organizationId, credential.organizationId),
				eq(agentSession.principalId, credential.principalId),
				eq(agentSession.id, credential.sessionId),
			),
		)
		.innerJoin(
			principal,
			and(
				eq(principal.organizationId, agentSession.organizationId),
				eq(principal.id, agentSession.principalId),
			),
		)
		.leftJoin(
			boundKey,
			and(
				eq(principal.credentialBindingType, "api_key"),
				eq(boundKey.id, principal.credentialBindingId),
				eq(boundKey.organizationId, principal.organizationId),
			),
		)
		.where(
			and(
				eq(credential.organizationId, params.organizationId),
				eq(credential.principalId, params.principalId),
				eq(credential.sessionId, params.sessionId),
				eq(credential.clientRecordId, params.clientRecordId),
				eq(credential.status, "active"),
				gt(credential.expiresAt, params.now),
				eq(agentSession.status, "active"),
				eq(principal.status, "active"),
				or(
					ne(principal.credentialBindingType, "api_key"),
					and(
						eq(boundKey.status, "active"),
						or(isNull(boundKey.expiresAt), gt(boundKey.expiresAt, params.now)),
					),
				),
			),
		)
		.limit(1);
	if (!row) return null;
	const { session } = row;
	return {
		principal: row.principal,
		session: { ...session, creditEligible: Boolean(session.creditEligible) },
		credential: row.credential,
	};
}

/** A bearer hash is globally unique; the resource fence precedes tenant resolution. */
export async function findFederatedWorkloadCredential(
	db: DbClient,
	params: { clientRecordId: string; mcpServerId: string },
): Promise<ExternalAgentMcpCredential | null> {
	if (!/^wif:[0-9a-f]{64}$/.test(params.clientRecordId)) return null;
	const rows = await db
		.select()
		.from(externalAgentMcpCredentials)
		.where(
			and(
				eq(externalAgentMcpCredentials.clientRecordId, params.clientRecordId),
				eq(externalAgentMcpCredentials.mcpServerId, params.mcpServerId),
			),
		)
		.limit(1);
	return rows[0] ?? null;
}

function noOutstandingProviderCleanup() {
	return sql`NOT EXISTS (SELECT 1 FROM ${externalAgentMcpCredentials} AS pending_cleanup WHERE pending_cleanup.organization_id = ${externalAgentPrincipals.organizationId} AND pending_cleanup.principal_id = ${externalAgentPrincipals.id} AND pending_cleanup.status = 'revoked' AND pending_cleanup.provider_cleanup_at IS NULL)`;
}

export async function listPendingExternalAgentProviderCleanup(
	db: DbClient,
	params: { organizationId: string; principalId: string },
) {
	return db
		.select({
			clientRecordId: externalAgentMcpCredentials.clientRecordId,
			mcpServerId: externalAgentMcpCredentials.mcpServerId,
		})
		.from(externalAgentMcpCredentials)
		.where(
			and(
				eq(externalAgentMcpCredentials.organizationId, params.organizationId),
				eq(externalAgentMcpCredentials.principalId, params.principalId),
				eq(externalAgentMcpCredentials.status, "revoked"),
				isNull(externalAgentMcpCredentials.providerCleanupAt),
			),
		)
		.orderBy(externalAgentMcpCredentials.issuedAt)
		.limit(500);
}

export async function finishExternalAgentProviderCleanup(
	db: DbClient,
	params: { organizationId: string; principalId: string; failed: boolean },
) {
	const [row] = await db
		.update(externalAgentPrincipals)
		.set({
			metadata: sql`json_set(${externalAgentPrincipals.metadata}, '$.providerCleanup', CASE WHEN ${noOutstandingProviderCleanup()} THEN 'done' ELSE ${params.failed ? "failed" : "pending"} END)`,
		})
		.where(
			and(
				eq(externalAgentPrincipals.organizationId, params.organizationId),
				eq(externalAgentPrincipals.id, params.principalId),
			),
		)
		.returning();
	if (!row)
		throw new ExternalAgentIdentityError(
			"principal_not_found",
			"External-agent principal not found",
		);
	return row;
}

function joinActivePrincipal() {
	return and(
		eq(activePrincipal.organizationId, activeSession.organizationId),
		eq(activePrincipal.id, activeSession.principalId),
	);
}

function activeSessionScope(input: {
	organizationId: string;
	principalId: string;
	sessionId: string;
}) {
	return and(
		eq(activeSession.organizationId, input.organizationId),
		eq(activeSession.principalId, input.principalId),
		eq(activeSession.id, input.sessionId),
		eq(activeSession.status, "active"),
	);
}

/** References the `active_principal` alias of the enclosing statement. */
function activePrincipalKey(now: ReturnType<typeof sql>) {
	return sql`(active_principal.credential_binding_type != 'api_key' OR EXISTS (
  SELECT 1 FROM ${apiKeys} AS issuance_key
  WHERE issuance_key.id = active_principal.credential_binding_id
   AND issuance_key.organization_id = active_principal.organization_id
   AND issuance_key.status = 'active'
   AND (issuance_key.expires_at IS NULL OR issuance_key.expires_at > ${now})
 ))`;
}
