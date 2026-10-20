import { withTransientD1ReadRetry } from "../../utils/d1-retry";
import type { JsonValue } from "@tedix/api-contract/schemas/common";
import { and, desc, eq, inArray, ne, sql } from "drizzle-orm";
import type { DbClient } from "../../client";
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
		credentialBindingType: "api_key" | "github_actions_oidc" | "owner_user";
		credentialBindingId: string;
		createdByType: "user" | "api_key" | "platform";
		createdById: string;
		metadata?: Record<string, JsonValue>;
		createdAt: string;
	},
): Promise<ExternalAgentPrincipal> {
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
		"External-agent key or credential binding is already owned by another principal",
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
): Promise<ExternalAgentPrincipal[]> {
	return db
		.select()
		.from(externalAgentPrincipals)
		.where(eq(externalAgentPrincipals.organizationId, params.organizationId))
		.orderBy(desc(externalAgentPrincipals.updatedAt))
		.limit(Math.min(Math.max(params.limit ?? 100, 1), 500));
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
