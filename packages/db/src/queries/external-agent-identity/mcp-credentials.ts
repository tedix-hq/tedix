import { and, desc, eq, gt, inArray, isNull, lt, or, sql } from "drizzle-orm";
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
	const rows = (await db.all(sql`
		INSERT INTO ${externalAgentMcpIssuanceLeases} (
			id, organization_id, principal_id, session_id, mcp_server_id,
			owner_token, expires_at, created_at, updated_at
		)
		SELECT
			${input.id}, ${input.organizationId}, ${input.principalId},
			${input.sessionId}, ${input.mcpServerId}, ${input.ownerToken},
			${input.expiresAt}, ${input.now}, ${input.now}
		FROM ${externalAgentSessions} AS active_session
		JOIN ${externalAgentPrincipals} AS active_principal
			ON active_principal.organization_id = active_session.organization_id
			AND active_principal.id = active_session.principal_id
		WHERE active_session.organization_id = ${input.organizationId}
			AND active_session.principal_id = ${input.principalId}
			AND active_session.id = ${input.sessionId}
			AND active_session.status = 'active'
			AND active_principal.status = 'active'
			AND ${activePrincipalKey(sql`${input.now}`)}
		ON CONFLICT (organization_id, principal_id, session_id, mcp_server_id)
		DO UPDATE SET
			id = excluded.id,
			owner_token = excluded.owner_token,
			expires_at = excluded.expires_at,
			updated_at = excluded.updated_at
		WHERE ${externalAgentMcpIssuanceLeases.expiresAt} <= ${input.now}
		RETURNING id
	`)) as Array<{ id: string }>;
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
	const inserted = (await db.all(sql`
		INSERT INTO ${externalAgentMcpCredentials} (
			id, organization_id, principal_id, session_id, client_record_id,
			mcp_server_id, mcp_server_url, status, issued_at, expires_at, revoked_at
		)
		SELECT
			${input.id}, ${input.organizationId}, ${input.principalId},
			${input.sessionId}, ${input.clientRecordId}, ${input.mcpServerId},
			${input.mcpServerUrl}, 'active', ${input.issuedAt}, ${input.expiresAt}, NULL
		FROM ${externalAgentSessions} AS active_session
		JOIN ${externalAgentPrincipals} AS active_principal
			ON active_principal.organization_id = active_session.organization_id
			AND active_principal.id = active_session.principal_id
		WHERE active_session.organization_id = ${input.organizationId}
			AND active_session.principal_id = ${input.principalId}
			AND active_session.id = ${input.sessionId}
			AND active_session.status = 'active'
			AND active_principal.status = 'active'
			AND ${activePrincipalKey(sql`${input.issuedAt}`)}
		ON CONFLICT DO NOTHING
		RETURNING id
	`)) as Array<{ id: string }>;
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
	const rows = (await db.all(sql`
		UPDATE ${externalAgentMcpCredentials}
		SET issued_at = ${params.issuedAt}, expires_at = ${params.expiresAt}
		WHERE organization_id = ${params.organizationId}
			AND principal_id = ${params.principalId}
			AND session_id = ${params.sessionId}
			AND client_record_id = ${params.clientRecordId}
			AND mcp_server_id = ${params.mcpServerId}
			AND status = 'active'
            AND EXISTS (
             SELECT 1 FROM ${externalAgentPrincipals} AS active_principal
             JOIN ${externalAgentSessions} AS active_session
              ON active_session.organization_id = active_principal.organization_id
              AND active_session.principal_id = active_principal.id
             WHERE active_principal.organization_id = ${params.organizationId}
              AND active_principal.id = ${params.principalId}
              AND active_principal.status = 'active'
              AND active_session.id = ${params.sessionId}
              AND active_session.status = 'active'
              AND ${activePrincipalKey(sql`${params.leaseNow}`)}
            )
			AND EXISTS (
				SELECT 1 FROM ${externalAgentMcpIssuanceLeases} AS issuance_lease
				WHERE issuance_lease.organization_id = ${params.organizationId}
					AND issuance_lease.principal_id = ${params.principalId}
					AND issuance_lease.session_id = ${params.sessionId}
					AND issuance_lease.mcp_server_id = ${params.mcpServerId}
					AND issuance_lease.owner_token = ${params.leaseOwnerToken}
					AND issuance_lease.expires_at > ${params.leaseNow}
			)
		RETURNING id
	`)) as Array<{ id: string }>;
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
	const inserted = (await db.all(sql`
		INSERT INTO ${externalAgentMcpCredentials} (
			id, organization_id, principal_id, session_id, client_record_id,
			mcp_server_id, mcp_server_url, status, issued_at, expires_at, revoked_at
		)
		SELECT
			${input.id}, ${input.organizationId}, ${input.principalId},
			${input.sessionId}, ${input.clientRecordId}, ${input.mcpServerId},
			${input.mcpServerUrl}, 'active', ${input.issuedAt}, ${input.expiresAt}, NULL
		FROM ${externalAgentSessions} AS active_session
		JOIN ${externalAgentPrincipals} AS active_principal
			ON active_principal.organization_id = active_session.organization_id
			AND active_principal.id = active_session.principal_id
		JOIN ${externalAgentMcpIssuanceLeases} AS issuance_lease
			ON issuance_lease.organization_id = active_session.organization_id
			AND issuance_lease.principal_id = active_session.principal_id
			AND issuance_lease.session_id = active_session.id
			AND issuance_lease.mcp_server_id = ${input.mcpServerId}
			AND issuance_lease.owner_token = ${input.leaseOwnerToken}
			AND issuance_lease.expires_at > ${input.leaseNow}
		WHERE active_session.organization_id = ${input.organizationId}
			AND active_session.principal_id = ${input.principalId}
			AND active_session.id = ${input.sessionId}
			AND active_session.status = 'active'
			AND active_principal.status = 'active'
			AND ${activePrincipalKey(sql`${input.leaseNow}`)}
		ON CONFLICT DO NOTHING
		RETURNING id
	`)) as Array<{ id: string }>;
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
	const rows = (await db.all(sql`
		SELECT
			json_object(
				'id', principal.id,
				'organizationId', principal.organization_id,
				'key', principal.key,
				'displayName', principal.display_name,
				'status', principal.status,
				'credentialBindingType', principal.credential_binding_type,
				'credentialBindingId', principal.credential_binding_id,
				'createdByType', principal.created_by_type,
				'createdById', principal.created_by_id,
				'metadata', json(principal.metadata),
				'createdAt', principal.created_at,
				'updatedAt', principal.updated_at
			) AS principal_json,
			json_object(
				'id', agent_session.id,
				'organizationId', agent_session.organization_id,
				'principalId', agent_session.principal_id,
				'externalSessionKey', agent_session.external_session_key,
				'harness', agent_session.harness,
				'harnessVersion', agent_session.harness_version,
				'modelProvider', agent_session.model_provider,
				'modelId', agent_session.model_id,
				'modelVersion', agent_session.model_version,
				'identitySource', agent_session.identity_source,
				'status', agent_session.status,
				'creditEligible', json(agent_session.credit_eligible),
				'startedAt', agent_session.started_at,
				'lastSeenAt', agent_session.last_seen_at,
				'endedAt', agent_session.ended_at,
				'metadata', json(agent_session.metadata)
			) AS session_json,
			json_object(
				'id', credential.id,
				'organizationId', credential.organization_id,
				'principalId', credential.principal_id,
				'sessionId', credential.session_id,
				'clientRecordId', credential.client_record_id,
				'mcpServerId', credential.mcp_server_id,
				'mcpServerUrl', credential.mcp_server_url,
				'status', credential.status,
				'issuedAt', credential.issued_at,
				'expiresAt', credential.expires_at,
				'revokedAt', credential.revoked_at,
				'providerCleanupAt', credential.provider_cleanup_at
			) AS credential_json
		FROM ${externalAgentMcpCredentials} AS credential
		JOIN ${externalAgentSessions} AS agent_session
			ON agent_session.organization_id = credential.organization_id
			AND agent_session.principal_id = credential.principal_id
			AND agent_session.id = credential.session_id
		JOIN ${externalAgentPrincipals} AS principal
			ON principal.organization_id = agent_session.organization_id
			AND principal.id = agent_session.principal_id
		LEFT JOIN ${apiKeys} AS bound_key
			ON principal.credential_binding_type = 'api_key'
			AND bound_key.id = principal.credential_binding_id
			AND bound_key.organization_id = principal.organization_id
		WHERE credential.organization_id = ${params.organizationId}
			AND credential.principal_id = ${params.principalId}
			AND credential.session_id = ${params.sessionId}
			AND credential.client_record_id = ${params.clientRecordId}
			AND credential.status = 'active'
			AND credential.expires_at > ${params.now}
			AND agent_session.status = 'active'
			AND principal.status = 'active'
			AND (principal.credential_binding_type != 'api_key' OR (
				bound_key.status = 'active'
				AND (bound_key.expires_at IS NULL OR bound_key.expires_at > ${params.now})
			))
		LIMIT 1
	`)) as Array<{
		principal_json: string;
		session_json: string;
		credential_json: string;
	}>;
	const row = rows[0];
	if (!row) return null;
	const principal = JSON.parse(row.principal_json) as ExternalAgentPrincipal;
	const session = JSON.parse(row.session_json) as ExternalAgentSession;
	const credential = JSON.parse(
		row.credential_json,
	) as ExternalAgentMcpCredential;
	return {
		principal,
		session: { ...session, creditEligible: Boolean(session.creditEligible) },
		credential,
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

function activePrincipalKey(now: ReturnType<typeof sql>) {
	return sql`(active_principal.credential_binding_type != 'api_key' OR EXISTS (
  SELECT 1 FROM ${apiKeys} AS issuance_key
  WHERE issuance_key.id = active_principal.credential_binding_id
   AND issuance_key.organization_id = active_principal.organization_id
   AND issuance_key.status = 'active'
   AND (issuance_key.expires_at IS NULL OR issuance_key.expires_at > ${now})
 ))`;
}
