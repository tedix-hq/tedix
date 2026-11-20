import * as pg from "../pg/queries/oidc-sessions";
import type { PgQueryClient } from "../pg/query-client";
import type { CoreStoreBinding } from "./postgres/core-store";
import { and, eq, gt, lte, isNull, sql } from "drizzle-orm";
import type { DbQueryClient } from "../query-client";
import { oidcSessions } from "../schema/oidc-sessions";
import { organizations } from "../schema/organizations";
import { principalIdentities } from "../schema/principal-identities";
import { organizationMembers } from "../schema/organization-members";
import { users } from "../schema/users";
import { prefixedColumns } from "../utils/select";

/** Resolve live session, configuration, and membership in one database round trip. */
export async function resolveOidcSessionContext(
	db: DbQueryClient | CoreStoreBinding<PgQueryClient>,
	id: string,
	now: number,
) {
	if ("plane" in db) {
		if (db.plane === "postgres")
			return pg.resolveOidcSessionContext(db.db, id, now);
		db = db.db;
	}

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
					sql<string>`json_extract(${organizations.metadata}, '$.identityProvider.issuer')`,
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
				sql`json_extract(${organizations.metadata}, '$.retiredAt') IS NULL`,
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
	db: DbQueryClient | CoreStoreBinding<PgQueryClient>,
	record: typeof oidcSessions.$inferInsert,
) {
	if ("plane" in db) {
		if (db.plane === "postgres") return pg.insertOidcRecord(db.db, record);
		db = db.db;
	}

	await db.batch([
		db
			.delete(oidcSessions)
			.where(lte(oidcSessions.expiresAt, Math.floor(Date.now() / 1000))),
		db.insert(oidcSessions).values(record),
	]);
}
export async function consumeOidcLogin(
	db: DbQueryClient | CoreStoreBinding<PgQueryClient>,
	id: string,
	now: number,
) {
	if ("plane" in db) {
		if (db.plane === "postgres") return pg.consumeOidcLogin(db.db, id, now);
		db = db.db;
	}

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
export async function getOidcSession(
	db: DbQueryClient | CoreStoreBinding<PgQueryClient>,
	id: string,
	now: number,
) {
	if ("plane" in db) {
		if (db.plane === "postgres") return pg.getOidcSession(db.db, id, now);
		db = db.db;
	}

	const [row] = await db
		.select()
		.from(oidcSessions)
		.where(
			and(
				eq(oidcSessions.id, id),
				eq(oidcSessions.kind, "session"),
				gt(oidcSessions.expiresAt, now),
			),
		)
		.limit(1);
	return row;
}
export async function deleteOidcSession(
	db: DbQueryClient | CoreStoreBinding<PgQueryClient>,
	id: string,
) {
	if ("plane" in db) {
		if (db.plane === "postgres") return pg.deleteOidcSession(db.db, id);
		db = db.db;
	}

	await db.delete(oidcSessions).where(eq(oidcSessions.id, id));
}
export async function getOidcOrganization(
	db: DbQueryClient | CoreStoreBinding<PgQueryClient>,
	id: string,
) {
	if ("plane" in db) {
		if (db.plane === "postgres") return pg.getOidcOrganization(db.db, id);
		db = db.db;
	}

	const [row] = await db
		.select({ id: organizations.id, metadata: organizations.metadata })
		.from(organizations)
		.where(
			and(
				eq(organizations.id, id),
				sql`json_extract(${organizations.metadata}, '$.retiredAt') IS NULL`,
			),
		)
		.limit(1);
	return row;
}
/** No email linking, Descope-subject fallback, or cached membership authority. */
export async function resolveOidcMember(
	db: DbQueryClient | CoreStoreBinding<PgQueryClient>,
	orgId: string,
	issuer: string,
	subject: string,
) {
	if ("plane" in db) {
		if (db.plane === "postgres")
			return pg.resolveOidcMember(db.db, orgId, issuer, subject);
		db = db.db;
	}

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
