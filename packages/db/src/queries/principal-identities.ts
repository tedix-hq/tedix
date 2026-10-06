import { and, eq, isNotNull, isNull, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import type { OrganizationPermission } from "@tedix/api-contract/schemas/user-settings";
import type { DbQueryClient } from "../query-client";
import { organizationMembers } from "../schema/organization-members";
import { organizations } from "../schema/organizations";
import type {
	NewPrincipalIdentity,
	PrincipalIdentity,
	PrincipalType,
} from "../schema/principal-identities";
import { principalIdentities } from "../schema/principal-identities";

export interface ExternalIdentity {
	provider: string;
	issuer: string;
	subject: string;
}

export interface CanonicalPrincipal {
	organizationId?: string | null;
	principalType: PrincipalType;
	principalId: string;
}

export class PrincipalIdentityConflictError extends Error {
	readonly code = "PRINCIPAL_IDENTITY_CONFLICT";

	constructor(message: string) {
		super(message);
		this.name = "PrincipalIdentityConflictError";
	}
}

function normalizeExternalIdentity(
	identity: ExternalIdentity,
): ExternalIdentity {
	const provider = identity.provider.trim().toLowerCase();
	const issuer = identity.issuer.trim().replace(/\/+$/, "");
	const subject = identity.subject.trim();
	if (!provider || !issuer || !subject) {
		throw new Error(
			"External identity provider, issuer, and subject are required",
		);
	}
	return { provider, issuer, subject };
}

export interface UserTenantIdentityContext {
	organizationId: string;
	canonicalUserId: string | null;
	memberRole: string | null;
	memberPermissionOverrides: OrganizationPermission[] | null;
}

/**
 * Resolve the canonical organization, user, and tenant membership required by
 * user-JWT authentication in one D1 statement. Canonical identity mappings win;
 * the Descope compatibility columns remain a read-only fallback for rows that
 * have not yet passed through the provider-neutral bootstrap.
 */
export async function resolveUserTenantIdentityContext(
	db: DbQueryClient,
	input: {
		organizationIdentity: ExternalIdentity;
		userIdentity: ExternalIdentity;
	},
): Promise<UserTenantIdentityContext | undefined> {
	const organizationIdentity = normalizeExternalIdentity(
		input.organizationIdentity,
	);
	const userIdentity = normalizeExternalIdentity(input.userIdentity);
	const organizationMapping = alias(
		principalIdentities,
		"tenant_organization_identity",
	);
	const userMapping = alias(principalIdentities, "tenant_user_identity");

	const [row] = await db
		.select({
			organizationId: sql<string>`${organizations.id}`.as(
				"identity_context_organization_id",
			),
			canonicalUserId: sql<string | null>`${userMapping.principalId}`.as(
				"identity_context_user_id",
			),
			memberRole: sql<string | null>`${organizationMembers.role}`.as(
				"identity_context_member_role",
			),
			memberPermissionOverrides: sql<
				OrganizationPermission[] | null
			>`${organizationMembers.customPermissions}`
				.mapWith(organizationMembers.customPermissions)
				.as("identity_context_member_permissions"),
		})
		.from(organizations)
		.leftJoin(
			organizationMapping,
			and(
				eq(organizationMapping.provider, organizationIdentity.provider),
				eq(organizationMapping.issuer, organizationIdentity.issuer),
				eq(organizationMapping.subject, organizationIdentity.subject),
				eq(organizationMapping.principalType, "organization"),
				eq(organizationMapping.status, "active"),
				eq(organizationMapping.principalId, organizations.id),
			),
		)
		.leftJoin(
			userMapping,
			and(
				eq(userMapping.provider, userIdentity.provider),
				eq(userMapping.issuer, userIdentity.issuer),
				eq(userMapping.subject, userIdentity.subject),
				eq(userMapping.principalType, "user"),
				eq(userMapping.status, "active"),
			),
		)
		.leftJoin(
			organizationMembers,
			and(
				eq(organizationMembers.organizationId, organizations.id),
				or(
					and(
						isNotNull(userMapping.principalId),
						eq(organizationMembers.userId, userMapping.principalId),
					),
					eq(organizationMembers.descopeUserId, userIdentity.subject),
				),
			),
		)
		.where(
			and(
				or(
					isNotNull(organizationMapping.id),
					eq(organizations.descopeTenantId, organizationIdentity.subject),
				),
				sql`json_extract(${organizations.metadata}, '$.retiredAt') IS NULL`,
			),
		)
		.orderBy(
			sql`CASE WHEN ${organizationMapping.id} IS NOT NULL THEN 0 ELSE 1 END`,
			sql`CASE WHEN ${organizationMembers.userId} = ${userMapping.principalId} THEN 0 ELSE 1 END`,
		)
		.limit(1);

	return row;
}

export async function resolvePrincipalIdentity(
	db: DbQueryClient,
	identity: ExternalIdentity,
	options?: {
		principalType?: PrincipalType;
		organizationId?: string | null;
		includeRevoked?: boolean;
	},
): Promise<PrincipalIdentity | undefined> {
	const external = normalizeExternalIdentity(identity);
	const conditions = [
		eq(principalIdentities.provider, external.provider),
		eq(principalIdentities.issuer, external.issuer),
		eq(principalIdentities.subject, external.subject),
	];
	if (!options?.includeRevoked) {
		conditions.push(eq(principalIdentities.status, "active"));
	}
	if (options?.principalType) {
		conditions.push(
			eq(principalIdentities.principalType, options.principalType),
		);
	}
	if (options && "organizationId" in options) {
		conditions.push(
			options.organizationId === null || options.organizationId === undefined
				? isNull(principalIdentities.organizationId)
				: eq(principalIdentities.organizationId, options.organizationId),
		);
	}
	const [row] = await db
		.select()
		.from(principalIdentities)
		.where(and(...conditions))
		.limit(1);
	return row;
}

export async function bindPrincipalIdentity(
	db: DbQueryClient,
	input: CanonicalPrincipal &
		ExternalIdentity & {
			id?: string;
			metadata?: NewPrincipalIdentity["metadata"];
			verifiedAt?: string;
		},
): Promise<PrincipalIdentity> {
	const external = normalizeExternalIdentity(input);
	const existing = await resolvePrincipalIdentity(db, external, {
		includeRevoked: true,
	});
	if (existing) {
		if (
			existing.principalType !== input.principalType ||
			existing.principalId !== input.principalId ||
			(existing.organizationId ?? null) !== (input.organizationId ?? null)
		) {
			throw new PrincipalIdentityConflictError(
				`External identity is already bound to ${existing.principalType}:${existing.principalId}`,
			);
		}
		const now = input.verifiedAt ?? new Date().toISOString();
		const [updated] = await db
			.update(principalIdentities)
			.set({
				status: "active",
				lastVerifiedAt: now,
				updatedAt: now,
				...(input.metadata ? { metadata: input.metadata } : {}),
			})
			.where(eq(principalIdentities.id, existing.id))
			.returning();
		if (!updated)
			throw new Error("Failed to refresh principal identity mapping");
		return updated;
	}

	const now = input.verifiedAt ?? new Date().toISOString();
	await db
		.insert(principalIdentities)
		.values({
			id: input.id ?? crypto.randomUUID(),
			organizationId: input.organizationId ?? null,
			principalType: input.principalType,
			principalId: input.principalId,
			provider: external.provider,
			issuer: external.issuer,
			subject: external.subject,
			status: "active",
			metadata: input.metadata ?? {},
			lastVerifiedAt: now,
			createdAt: now,
			updatedAt: now,
		})
		.onConflictDoNothing();

	const bound = await resolvePrincipalIdentity(db, external, {
		includeRevoked: true,
	});
	if (!bound) throw new Error("Failed to bind principal identity mapping");
	if (
		bound.principalType !== input.principalType ||
		bound.principalId !== input.principalId ||
		(bound.organizationId ?? null) !== (input.organizationId ?? null)
	) {
		throw new PrincipalIdentityConflictError(
			`External identity was concurrently bound to ${bound.principalType}:${bound.principalId}`,
		);
	}
	return bound;
}

export async function listPrincipalIdentities(
	db: DbQueryClient,
	principal: CanonicalPrincipal,
): Promise<PrincipalIdentity[]> {
	const conditions = [
		eq(principalIdentities.principalType, principal.principalType),
		eq(principalIdentities.principalId, principal.principalId),
	];
	if (principal.organizationId !== undefined) {
		conditions.push(
			principal.organizationId === null
				? isNull(principalIdentities.organizationId)
				: eq(principalIdentities.organizationId, principal.organizationId),
		);
	}
	return db
		.select()
		.from(principalIdentities)
		.where(and(...conditions));
}

export async function revokePrincipalIdentity(
	db: DbQueryClient,
	identity: ExternalIdentity,
	revokedAt = new Date().toISOString(),
): Promise<boolean> {
	const external = normalizeExternalIdentity(identity);
	const result = await db
		.update(principalIdentities)
		.set({ status: "revoked", updatedAt: revokedAt })
		.where(
			and(
				eq(principalIdentities.provider, external.provider),
				eq(principalIdentities.issuer, external.issuer),
				eq(principalIdentities.subject, external.subject),
				eq(principalIdentities.status, "active"),
			),
		)
		.returning({ id: principalIdentities.id });
	return result.length > 0;
}
