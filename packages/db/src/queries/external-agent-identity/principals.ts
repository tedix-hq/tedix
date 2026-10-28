import { withTransientD1ReadRetry } from "../../utils/d1-retry";
import { ExternalAgentPlatformSchema } from "@tedix/api-contract/schemas/external-agent-identity";
import { organizationMembers } from "../../schema/organization-members";
import type { JsonValue } from "@tedix/api-contract/schemas/common";
import { and, desc, eq, getColumns, inArray, ne, or, sql } from "drizzle-orm";
import type { DbClient } from "../../client";
import type { DbQueryClient } from "../../query-client";
import { apiKeys } from "../../schema/api-keys";
import {
	type ExternalAgentPrincipal,
	externalAgentPrincipals,
	externalAgentSessions,
	externalAgentMcpCredentials,
	externalAgentMcpIssuanceLeases,
} from "../../schema/external-agent-identity";

export type ExternalAgentIdentityErrorReason =
	| "binding_conflict"
	| "active_work_item_attempt"
	| "credential_inactive"
	| "credential_not_found"
	| "immutable_session_conflict"
	| "principal_inactive"
	| "principal_not_found"
	| "review_conflict"
	| "review_not_found"
	| "knowledge_disposition_conflict"
	| "knowledge_disposition_required"
	| "session_ended"
	| "session_not_found"
	| "wrong_org";

export class ExternalAgentIdentityError extends Error {
	constructor(
		readonly reason: ExternalAgentIdentityErrorReason,
		message: string,
	) {
		super(message);
		this.name = "ExternalAgentIdentityError";
	}
}

export async function getExternalAgentPrincipal(
	db: DbClient,
	params: { organizationId: string; principalId: string },
): Promise<ExternalAgentPrincipal | null> {
	const rows = await withTransientD1ReadRetry(
		"external_agent.principal",
		async () =>
			db
				.select()
				.from(externalAgentPrincipals)
				.where(
					and(
						eq(externalAgentPrincipals.organizationId, params.organizationId),
						eq(externalAgentPrincipals.id, params.principalId),
					),
				)
				.limit(1),
		{ timeoutMs: 5_000 },
	);
	return rows[0] ?? null;
}

/** Resolve a machine-credential-bound principal (API key or workload). An
 * owner_user binding id is a human user id, never a machine credential. */
export async function getExternalAgentPrincipalByCredential(
	db: DbClient,
	params: { organizationId: string; credentialBindingId: string },
): Promise<ExternalAgentPrincipal | null> {
	const rows = await db
		.select()
		.from(externalAgentPrincipals)
		.where(
			and(
				eq(externalAgentPrincipals.organizationId, params.organizationId),
				eq(
					externalAgentPrincipals.credentialBindingId,
					params.credentialBindingId,
				),
				ne(externalAgentPrincipals.credentialBindingType, "owner_user"),
			),
		)
		.limit(1);
	return rows[0] ?? null;
}

/**
 * Principals that act for one person: an `owner_user` binding to their
 * canonical user id, or an `api_key` binding carrying
 * `metadata.representedUserId` — the same canonical-party mapping the
 * separation-of-duties ledger uses.
 */
export async function listExternalAgentPrincipalsRepresentingUser(
	db: DbQueryClient,
	params: { organizationId: string; userId: string; limit?: number },
): Promise<ExternalAgentPrincipal[]> {
	return db
		.select()
		.from(externalAgentPrincipals)
		.where(
			and(
				eq(externalAgentPrincipals.organizationId, params.organizationId),
				or(
					and(
						eq(externalAgentPrincipals.credentialBindingType, "owner_user"),
						eq(externalAgentPrincipals.credentialBindingId, params.userId),
					),
					and(
						eq(externalAgentPrincipals.credentialBindingType, "api_key"),
						eq(
							sql`json_extract(${externalAgentPrincipals.metadata}, '$.representedUserId')`,
							params.userId,
						),
					),
				),
			),
		)
		.limit(Math.min(Math.max(params.limit ?? 50, 1), 50));
}

/** Resolve the globally unique canonical principal id before tenant context is
 * established. Only credential/session bootstrap callers should use this. */
export async function getExternalAgentPrincipalById(
	db: DbClient,
	principalId: string,
): Promise<ExternalAgentPrincipal | null> {
	const rows = await db
		.select()
		.from(externalAgentPrincipals)
		.where(eq(externalAgentPrincipals.id, principalId))
		.limit(1);
	return rows[0] ?? null;
}

export async function createExternalAgentPrincipal(
	db: DbClient,
	input: {
		id: string;
		organizationId: string;
		key: string;
		displayName: string;
		credentialBindingType:
			| "api_key"
			| "github_actions_oidc"
			| "owner_user"
			| "aih_m2m";
		credentialBindingId: string;
		createdByType: "user" | "api_key" | "platform";
		createdById: string;
		metadata?: Record<string, JsonValue>;
		createdAt: string;
	},
): Promise<ExternalAgentPrincipal> {
	const representedUserId = input.metadata?.representedUserId;
	if (representedUserId !== undefined) {
		if (typeof representedUserId !== "string" || !representedUserId.trim())
			throw new ExternalAgentIdentityError(
				"binding_conflict",
				"Representation requires a canonical human user id",
			);
		const inserted = await db.all(sql`
			INSERT INTO ${externalAgentPrincipals} (
				id, organization_id, key, display_name, status,
				credential_binding_type, credential_binding_id, created_by_type,
				created_by_id, metadata, created_at, updated_at
			)
			SELECT ${input.id}, ${input.organizationId}, ${input.key}, ${input.displayName}, 'active',
				${input.credentialBindingType}, ${input.credentialBindingId}, ${input.createdByType},
				${input.createdById}, ${JSON.stringify(input.metadata)}, ${input.createdAt}, ${input.createdAt}
			FROM ${organizationMembers} AS represented_person
			WHERE represented_person.organization_id = ${input.organizationId}
				AND represented_person.user_id = ${representedUserId}
				AND represented_person.status = 'active'
				AND represented_person.kind = 'human'
				AND represented_person.role IN ('owner', 'admin', 'member')
			LIMIT 1
			ON CONFLICT DO NOTHING RETURNING id
		`);
		if (inserted.length)
			return (await getExternalAgentPrincipal(db, {
				organizationId: input.organizationId,
				principalId: input.id,
			}))!;
	} else {
		const inserted = await db
			.insert(externalAgentPrincipals)
			.values({
				...input,
				status: "active",
				metadata: input.metadata ?? {},
				updatedAt: input.createdAt,
			})
			.onConflictDoNothing()
			.returning();
		if (inserted[0]) return inserted[0];
	}

	const byKey = await db
		.select()
		.from(externalAgentPrincipals)
		.where(
			and(
				eq(externalAgentPrincipals.organizationId, input.organizationId),
				eq(externalAgentPrincipals.key, input.key),
			),
		)
		.limit(1);
	const existing = byKey[0];
	if (
		existing &&
		existing.credentialBindingType === input.credentialBindingType &&
		existing.credentialBindingId === input.credentialBindingId
	) {
		return existing;
	}
	throw new ExternalAgentIdentityError(
		"binding_conflict",
		representedUserId === undefined
			? "External-agent key or credential binding is already owned by another principal"
			: "Representation requires an active human non-viewer member in this organization and an unused principal binding",
	);
}

export async function setExternalAgentPrincipalStatus(
	db: DbClient,
	params: {
		organizationId: string;
		principalId: string;
		status: "active" | "suspended" | "retired";
		updatedAt: string;
	},
): Promise<ExternalAgentPrincipal> {
	const principalUpdate = db
		.update(externalAgentPrincipals)
		.set({ status: params.status, updatedAt: params.updatedAt })
		.where(
			and(
				eq(externalAgentPrincipals.organizationId, params.organizationId),
				eq(externalAgentPrincipals.id, params.principalId),
			),
		)
		.returning();
	const [rows] =
		params.status === "active"
			? [await principalUpdate]
			: await db.batch([
					principalUpdate,
					db
						.update(externalAgentSessions)
						.set({
							status: "ended",
							lastSeenAt: params.updatedAt,
							endedAt: params.updatedAt,
						})
						.where(
							and(
								eq(externalAgentSessions.organizationId, params.organizationId),
								eq(externalAgentSessions.principalId, params.principalId),
								eq(externalAgentSessions.status, "active"),
							),
						),
				]);
	if (!rows[0]) {
		throw new ExternalAgentIdentityError(
			"principal_not_found",
			"External-agent principal not found",
		);
	}
	return rows[0];
}

/** Display name only: the key is immutable because provenance refers to it. */
export async function renameExternalAgentPrincipal(
	db: DbClient,
	params: {
		organizationId: string;
		principalId: string;
		displayName: string;
		updatedAt: string;
	},
): Promise<ExternalAgentPrincipal> {
	const [row] = await db
		.update(externalAgentPrincipals)
		.set({ displayName: params.displayName, updatedAt: params.updatedAt })
		.where(
			and(
				eq(externalAgentPrincipals.organizationId, params.organizationId),
				eq(externalAgentPrincipals.id, params.principalId),
			),
		)
		.returning();
	if (!row) {
		throw new ExternalAgentIdentityError(
			"principal_not_found",
			"External-agent principal not found",
		);
	}
	return row;
}

export async function listExternalAgentPrincipals(
	db: DbClient,
	params: { organizationId: string; limit?: number },
) {
	// Explicit outer names prevent single-table SELECT column dequalification in subqueries.
	const rows = await db
		.select({
			...getColumns(externalAgentPrincipals),
			expiresAt: sql<string | null>`(
				SELECT bound_key.expires_at FROM ${apiKeys} AS bound_key
				WHERE external_agent_principals.credential_binding_type = 'api_key'
					AND bound_key.id = external_agent_principals.credential_binding_id
					AND bound_key.organization_id = external_agent_principals.organization_id
				LIMIT 1
			)`,
			lastSeenAt: sql<string | null>`(
				SELECT latest_session.last_seen_at FROM ${externalAgentSessions} AS latest_session
				WHERE latest_session.organization_id = external_agent_principals.organization_id
					AND latest_session.principal_id = external_agent_principals.id
				ORDER BY latest_session.started_at DESC, latest_session.id DESC LIMIT 1
			)`,
		})
		.from(externalAgentPrincipals)
		.where(eq(externalAgentPrincipals.organizationId, params.organizationId))
		.orderBy(desc(externalAgentPrincipals.updatedAt))
		.limit(Math.min(Math.max(params.limit ?? 100, 1), 500));
	return rows.map((row) => ({
		...row,
		platform:
			ExternalAgentPlatformSchema.safeParse(row.metadata.platform).data ?? null,
		representedUserId:
			typeof row.metadata.representedUserId === "string"
				? row.metadata.representedUserId
				: null,
		allowedScopes: Array.isArray(row.metadata.allowedScopes)
			? row.metadata.allowedScopes.filter(
					(scope): scope is string => typeof scope === "string",
				)
			: null,
	}));
}

export async function listExternalAgentPrincipalsByIds(
	db: DbClient,
	params: { principalIds: string[]; organizationId?: string },
): Promise<ExternalAgentPrincipal[]> {
	if (params.principalIds.length === 0) return [];
	return db
		.select()
		.from(externalAgentPrincipals)
		.where(
			params.organizationId
				? and(
						eq(externalAgentPrincipals.organizationId, params.organizationId),
						// bound-params: exact audit actor ids are capped to 50.
						inArray(
							externalAgentPrincipals.id,
							params.principalIds.slice(0, 50),
						),
					)
				: // bound-params: exact platform audit actor ids are capped to 50.
					inArray(externalAgentPrincipals.id, params.principalIds.slice(0, 50)),
		);
}

/** Local denial is atomic; remote deletion runs only after this batch commits. */
export async function disableExternalAgentPrincipal(
	db: DbClient,
	params: {
		organizationId: string;
		principalId: string;
		reason: string;
		now: string;
	},
): Promise<ExternalAgentPrincipal> {
	const scoped = and(
		eq(externalAgentPrincipals.organizationId, params.organizationId),
		eq(externalAgentPrincipals.id, params.principalId),
	);
	const [principals] = await db.batch([
		db
			.update(externalAgentPrincipals)
			.set({
				status: "suspended",
				updatedAt: params.now,
				metadata: sql`json_set(${externalAgentPrincipals.metadata}, '$.providerCleanup', 'pending', '$.disableReason', ${params.reason})`,
			})
			.where(scoped)
			.returning(),
		db
			.update(externalAgentMcpCredentials)
			.set({ status: "revoked", revokedAt: params.now })
			.where(
				and(
					eq(externalAgentMcpCredentials.organizationId, params.organizationId),
					eq(externalAgentMcpCredentials.principalId, params.principalId),
					eq(externalAgentMcpCredentials.status, "active"),
				),
			),
		db
			.update(apiKeys)
			.set({
				status: "revoked",
				revokedAt: params.now,
				revokeReason: params.reason,
				updatedAt: params.now,
				previousKeyHash: null,
				previousKeyExpiresAt: null,
			})
			.where(
				and(
					eq(apiKeys.organizationId, params.organizationId),
					sql`${apiKeys.id} IN (SELECT credential_binding_id FROM ${externalAgentPrincipals} WHERE organization_id = ${params.organizationId} AND id = ${params.principalId} AND credential_binding_type = 'api_key')`,
				),
			),
		db
			.delete(externalAgentMcpIssuanceLeases)
			.where(
				and(
					eq(
						externalAgentMcpIssuanceLeases.organizationId,
						params.organizationId,
					),
					eq(externalAgentMcpIssuanceLeases.principalId, params.principalId),
				),
			),
	]);
	if (!principals[0])
		throw new ExternalAgentIdentityError(
			"principal_not_found",
			"External-agent principal not found",
		);
	return principals[0];
}
