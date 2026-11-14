import { withTransientD1ReadRetry } from "../../utils/d1-retry";
import { auditEvents } from "../../schema/audit-events";
import * as z from "zod";
import {
	ExternalAgentWorkManagementGrantSchema,
	ExternalAgentPlatformSchema,
} from "@tedix/api-contract/schemas/external-agent-identity";
import { organizationMembers } from "../../schema/organization-members";
import type { JsonValue } from "@tedix/api-contract/schemas/common";
import { and, desc, eq, getColumns, inArray, ne, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
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
		const representedPerson = alias(organizationMembers, "represented_person");
		const inserted = await db
			.insert(externalAgentPrincipals)
			.select(
				db
					.select({
						id: sql<string>`${input.id}`.as("id"),
						organizationId: sql<string>`${input.organizationId}`.as(
							"organization_id",
						),
						key: sql<string>`${input.key}`.as("key"),
						displayName: sql<string>`${input.displayName}`.as("display_name"),
						status: sql<"active">`'active'`.as("status"),
						credentialBindingType: sql<
							typeof input.credentialBindingType
						>`${input.credentialBindingType}`.as("credential_binding_type"),
						credentialBindingId: sql<string>`${input.credentialBindingId}`.as(
							"credential_binding_id",
						),
						createdByType: sql<
							typeof input.createdByType
						>`${input.createdByType}`.as("created_by_type"),
						createdById: sql<string>`${input.createdById}`.as("created_by_id"),
						metadata: sql<
							Record<string, JsonValue>
						>`${JSON.stringify(input.metadata)}`.as("metadata"),
						createdAt: sql<string>`${input.createdAt}`.as("created_at"),
						updatedAt: sql<string>`${input.createdAt}`.as("updated_at"),
					})
					.from(representedPerson)
					.where(
						and(
							eq(representedPerson.organizationId, input.organizationId),
							eq(representedPerson.userId, representedUserId),
							eq(representedPerson.status, "active"),
							eq(representedPerson.kind, "human"),
							inArray(representedPerson.role, ["owner", "admin", "member"]),
						),
					)
					.limit(1),
			)
			.onConflictDoNothing()
			.returning({ id: externalAgentPrincipals.id });
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

/** Atomic grant replacement and audit; JSON operations preserve unrelated metadata. */
export async function setExternalAgentWorkManagement(
	db: DbClient,
	params: {
		organizationId: string;
		principalId: string;
		actorId: string;
		grant: z.infer<typeof ExternalAgentWorkManagementGrantSchema> | null;
		updatedAt: string;
	},
): Promise<ExternalAgentPrincipal> {
	const predicate = and(
		eq(externalAgentPrincipals.organizationId, params.organizationId),
		eq(externalAgentPrincipals.id, params.principalId),
	);
	const grant =
		params.grant === null
			? null
			: ExternalAgentWorkManagementGrantSchema.parse(params.grant);
	const audit = db.insert(auditEvents).select(
		db
			.select({
				id: sql<string>`${crypto.randomUUID()}`.as("audit_id"),
				organizationId: sql<string>`${params.organizationId}`.as("audit_org"),
				actorId: sql<string>`${params.actorId}`.as("audit_actor"),
				actorType: sql<string>`'user'`.as("audit_actor_type"),
				action: sql<string>`'external_agent.work_management.updated'`.as(
					"audit_action",
				),
				resourceType: sql<string>`'external_agent_principal'`.as(
					"audit_resource_type",
				),
				resourceId: externalAgentPrincipals.id,
				metadata: sql<
					Record<string, JsonValue>
				>`json_object('previousGrant', json_extract(${externalAgentPrincipals.metadata}, '$.workManagement'), 'grant', json(${JSON.stringify(grant)}))`.as(
					"audit_metadata",
				),
				ipAddress: sql<string | null>`NULL`.as("audit_ip"),
				userAgent: sql<string | null>`NULL`.as("audit_user_agent"),
				timestamp:
					sql<Date>`${Math.floor(Date.parse(params.updatedAt) / 1000)}`.as(
						"audit_timestamp",
					),
			})
			.from(externalAgentPrincipals)
			.where(predicate),
	);
	const update = db
		.update(externalAgentPrincipals)
		.set({
			metadata:
				grant === null
					? sql`json_remove(${externalAgentPrincipals.metadata}, '$.workManagement')`
					: sql`json_set(${externalAgentPrincipals.metadata}, '$.workManagement', json(${JSON.stringify(grant)}))`,
			updatedAt: params.updatedAt,
		})
		.where(predicate)
		.returning();
	const [, rows] = await db.batch([audit, update]);
	if (!rows[0])
		throw new ExternalAgentIdentityError(
			"principal_not_found",
			"External-agent principal not found",
		);
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
