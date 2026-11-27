import { coreTable } from "../core-store/client";
import { jsonRead } from "../core-store/dialect";
import { and, eq, gt, lte, isNull, sql } from "drizzle-orm";
import type { DbQueryClient } from "../query-client";
import { oidcSessions as schemaOidcSessions } from "../schema/oidc-sessions";
import { organizations as schemaOrganizations } from "../schema/organizations";
import { principalIdentities as schemaPrincipalIdentities } from "../schema/principal-identities";
import { organizationMembers as schemaOrganizationMembers } from "../schema/organization-members";
import { users as schemaUsers } from "../schema/users";
import { prefixedColumns } from "../utils/select";

/** Resolve live session, configuration, and membership in one database round trip. */
export async function resolveOidcSessionContext(
	db: DbQueryClient,
	id: string,
	now: number,
) {
	const oidcSessions = coreTable(db, schemaOidcSessions);
	const organizations = coreTable(db, schemaOrganizations);
	const principalIdentities = coreTable(db, schemaPrincipalIdentities);
	const organizationMembers = coreTable(db, schemaOrganizationMembers);
	const users = coreTable(db, schemaUsers);
	const [row] = await db
		.select({
			session: prefixedColumns(oidcSessions, "oidc_session"),
			metadata: organizations.metadata,
			member: {
				id: sql<string>`${organizationMembers.id}`.as("oidc_member_id"),
				descopeUserId: organizationMembers.descopeUserId,
				kind: organizationMembers.kind,
				userId: sql<string | null>`${organizationMembers.userId}`.as(
					"oidc_member_user_id",
				),
				email: users.email,
				name: users.name,
				role: organizationMembers.role,
				permissions: organizationMembers.customPermissions,
			},
		})
		.from(oidcSessions)
		.innerJoin(organizations, eq(organizations.id, oidcSessions.organizationId))
		.leftJoin(
			principalIdentities,
			and(
				eq(principalIdentities.provider, "oidc"),
				eq(
					principalIdentities.issuer,
					jsonRead(db, organizations.metadata, ["identityProvider", "issuer"]),
				),
				eq(principalIdentities.subject, oidcSessions.subject),
				eq(principalIdentities.principalType, "user"),
				eq(principalIdentities.status, "active"),
				isNull(principalIdentities.organizationId),
			),
		)
		.leftJoin(users, eq(users.id, principalIdentities.principalId))
		.leftJoin(
			organizationMembers,
			and(
				eq(organizationMembers.userId, users.id),
				eq(organizationMembers.organizationId, oidcSessions.organizationId),
				eq(organizationMembers.status, "active"),
			),
		)
		.where(
			and(
				eq(oidcSessions.id, id),
				eq(oidcSessions.kind, "session"),
				gt(oidcSessions.expiresAt, now),
				isNull(jsonRead(db, organizations.metadata, ["retiredAt"])),
			),
		)
		.limit(1);
	if (!row) return undefined;
	const member = row.member;
	return {
		session: row.session,
		metadata: row.metadata,
		member:
			member?.userId && member.email && member.role
				? {
						...member,
						userId: member.userId,
						email: member.email,
						role: member.role,
					}
				: undefined,
	};
}

export async function insertOidcRecord(
	db: DbQueryClient,
	record: typeof schemaOidcSessions.$inferInsert,
) {
	const oidcSessions = coreTable(db, schemaOidcSessions);
	await db.batch([
		db
			.delete(oidcSessions)
			.where(lte(oidcSessions.expiresAt, Math.floor(Date.now() / 1000))),
		db.insert(oidcSessions).values(record),
	]);
}
export async function consumeOidcLogin(
	db: DbQueryClient,
	id: string,
	now: number,
) {
	const oidcSessions = coreTable(db, schemaOidcSessions);
	const [row] = await db
		.delete(oidcSessions)
		.where(
			and(
				eq(oidcSessions.id, id),
				eq(oidcSessions.kind, "login"),
				gt(oidcSessions.expiresAt, now),
			),
		)
		.returning();
	return row;
}
export async function deleteOidcSession(db: DbQueryClient, id: string) {
	const oidcSessions = coreTable(db, schemaOidcSessions);
	await db.delete(oidcSessions).where(eq(oidcSessions.id, id));
}
export async function getOidcOrganization(db: DbQueryClient, id: string) {
	const organizations = coreTable(db, schemaOrganizations);
	const [row] = await db
		.select({ id: organizations.id, metadata: organizations.metadata })
		.from(organizations)
		.where(
			and(
				eq(organizations.id, id),
				isNull(jsonRead(db, organizations.metadata, ["retiredAt"])),
			),
		)
		.limit(1);
	return row;
}
/** No email linking, Descope-subject fallback, or cached membership authority. */
export async function resolveOidcMember(
	db: DbQueryClient,
	orgId: string,
	issuer: string,
	subject: string,
) {
	const principalIdentities = coreTable(db, schemaPrincipalIdentities);
	const organizationMembers = coreTable(db, schemaOrganizationMembers);
	const users = coreTable(db, schemaUsers);
	const [row] = await db
		.select({
			userId: users.id,
			email: users.email,
			name: users.name,
			role: organizationMembers.role,
			permissions: organizationMembers.customPermissions,
		})
		.from(principalIdentities)
		.innerJoin(users, eq(users.id, principalIdentities.principalId))
		.innerJoin(
			organizationMembers,
			and(
				eq(organizationMembers.userId, users.id),
				eq(organizationMembers.organizationId, orgId),
				eq(organizationMembers.status, "active"),
			),
		)
		.where(
			and(
				eq(principalIdentities.provider, "oidc"),
				eq(principalIdentities.issuer, issuer),
				eq(principalIdentities.subject, subject),
				eq(principalIdentities.principalType, "user"),
				eq(principalIdentities.status, "active"),
				isNull(principalIdentities.organizationId),
			),
		)
		.limit(1);
	return row;
}
