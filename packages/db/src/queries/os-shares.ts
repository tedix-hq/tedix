import { and, count, desc, eq, gt, isNull, sql } from "drizzle-orm";
import type { DbQueryClient } from "../query-client";
import { osWorkspaceCollaborators } from "../schema/os-collaborators";
import {
	type NewOsShareLinkInviteeRow,
	type NewOsShareLinkRow,
	type OsShareLinkInviteeRow,
	type OsShareLinkRow,
	type OsShareSessionRow,
	osShareLinkInvitees,
	osShareLinks,
	osShareSessions,
} from "../schema/os-shares";
import { getAffectedRows } from "../utils/d1-result";

export interface OsShareLinkScopeParams {
	organizationId: string;
	shareLinkId: string;
}

export interface OsShareResourceScopeParams {
	organizationId: string;
	resourceType: OsShareLinkRow["resourceType"];
	resourceId: string;
}

export async function createOsShareLink(
	db: DbQueryClient,
	link: NewOsShareLinkRow,
): Promise<OsShareLinkRow> {
	const [row] = await db.insert(osShareLinks).values(link).returning();
	if (!row) {
		throw new Error("OS share link insert returned no row");
	}
	return row;
}

/** All share links for one resource, newest first — revoked/expired included. */
export async function listOsShareLinks(
	db: DbQueryClient,
	params: OsShareResourceScopeParams,
): Promise<OsShareLinkRow[]> {
	return db
		.select()
		.from(osShareLinks)
		.where(
			and(
				eq(osShareLinks.organizationId, params.organizationId),
				eq(osShareLinks.resourceType, params.resourceType),
				eq(osShareLinks.resourceId, params.resourceId),
			),
		)
		.orderBy(desc(osShareLinks.createdAt), desc(osShareLinks.id));
}

/**
 * Revoke a share link, idempotently: the first revocation stamps `revoked_at`
 * and a repeat keeps the original timestamp. Returns the row, or undefined
 * when the id does not exist in the organization.
 */
export async function revokeOsShareLink(
	db: DbQueryClient,
	params: OsShareLinkScopeParams,
): Promise<OsShareLinkRow | undefined> {
	const now = new Date().toISOString();
	const updateLink = db
		.update(osShareLinks)
		.set({
			revokedAt: sql`coalesce(${osShareLinks.revokedAt}, ${now})`,
		})
		.where(
			and(
				eq(osShareLinks.organizationId, params.organizationId),
				eq(osShareLinks.id, params.shareLinkId),
			),
		)
		.returning();
	const revokeSessions = db
		.update(osShareSessions)
		.set({
			revokedAt: sql`coalesce(${osShareSessions.revokedAt}, ${now})`,
		})
		.where(
			and(
				eq(osShareSessions.shareLinkId, params.shareLinkId),
				sql`exists (
					select 1 from ${osShareLinks}
					where ${osShareLinks.id} = ${params.shareLinkId}
						and ${osShareLinks.organizationId} = ${params.organizationId}
				)`,
			),
		);
	const [rows] = await db.batch([updateLink, revokeSessions]);
	return rows[0];
}

const SHARE_ROLE_RANK = { viewer: 0, use: 1, build: 2 } as const;

function effectiveShareRoleRankSql() {
	return sql<number>`case
		when ${osShareLinks.policyMaxRole} = 'viewer' then 0
		when ${osShareLinks.policyMaxRole} = 'use' then 1
		when ${osShareLinks.policyMaxRole} = 'build' then 2
		when ${osShareLinks.role} = 'viewer' then 0
		when ${osShareLinks.role} = 'use' then 1
		else 2
	end`;
}

/**
 * Apply a stay-or-tighten policy ceiling and revoke sessions only when the
 * effective role becomes narrower. Both statements carry the same monotonic
 * predicate and run in one D1 batch, so concurrent writers cannot clear or
 * widen a ceiling and redemption cannot retain a pre-tightening session.
 */
export async function restrictOsShareLink(
	db: DbQueryClient,
	params: OsShareLinkScopeParams & {
		maxRole: NonNullable<OsShareLinkRow["policyMaxRole"]>;
		reason: string;
		now?: string;
	},
): Promise<{ share: OsShareLinkRow; revokedSessionCount: number } | undefined> {
	const requestedRank = SHARE_ROLE_RANK[params.maxRole];
	const now = params.now ?? new Date().toISOString();
	const canStayOrTighten = and(
		eq(osShareLinks.organizationId, params.organizationId),
		eq(osShareLinks.id, params.shareLinkId),
		sql`${requestedRank} <= ${effectiveShareRoleRankSql()}`,
	);
	const revokeSessions = db
		.update(osShareSessions)
		.set({ revokedAt: sql`coalesce(${osShareSessions.revokedAt}, ${now})` })
		.where(
			and(
				eq(osShareSessions.shareLinkId, params.shareLinkId),
				isNull(osShareSessions.revokedAt),
				gt(osShareSessions.expiresAt, now),
				sql`exists (
					select 1 from ${osShareLinks}
					where ${canStayOrTighten}
						and ${requestedRank} < ${effectiveShareRoleRankSql()}
				)`,
			),
		)
		.returning({ id: osShareSessions.id });
	const updateLink = db
		.update(osShareLinks)
		.set({
			policyMaxRole: params.maxRole,
			policyReason: params.reason,
			policyRestrictedAt: now,
		})
		.where(canStayOrTighten)
		.returning();
	const [revokedSessions, rows] = await db.batch([revokeSessions, updateLink]);
	const share = rows[0];
	return share
		? { share, revokedSessionCount: revokedSessions.length }
		: undefined;
}

/**
 * Edit an active link's note, expiry or role in place. The token hash never
 * changes, so the link keeps redeeming. With `endSessions`, live sessions end
 * in the same batch, so none outlives a narrowed role or earlier expiry.
 * Returns undefined when the link is missing, revoked, or in another
 * organization.
 */
export async function updateOsShareLinkSettings(
	db: DbQueryClient,
	params: OsShareLinkScopeParams & {
		set: Partial<
			Pick<OsShareLinkRow, "role" | "access" | "note" | "expiresAt">
		>;
		endSessions: boolean;
		now?: string;
	},
): Promise<{ share: OsShareLinkRow; revokedSessionCount: number } | undefined> {
	const now = params.now ?? new Date().toISOString();
	const activeLink = and(
		eq(osShareLinks.organizationId, params.organizationId),
		eq(osShareLinks.id, params.shareLinkId),
		isNull(osShareLinks.revokedAt),
	);
	const revokeSessions = db
		.update(osShareSessions)
		.set({ revokedAt: sql`coalesce(${osShareSessions.revokedAt}, ${now})` })
		.where(
			and(
				eq(osShareSessions.shareLinkId, params.shareLinkId),
				isNull(osShareSessions.revokedAt),
				gt(osShareSessions.expiresAt, now),
				sql`exists (select 1 from ${osShareLinks} where ${activeLink})`,
			),
		)
		.returning({ id: osShareSessions.id });
	const updateLink = db
		.update(osShareLinks)
		.set(params.set)
		.where(activeLink)
		.returning();
	if (!params.endSessions) {
		const [share] = await updateLink;
		return share ? { share, revokedSessionCount: 0 } : undefined;
	}
	const [revokedSessions, rows] = await db.batch([revokeSessions, updateLink]);
	const share = rows[0];
	return share
		? { share, revokedSessionCount: revokedSessions.length }
		: undefined;
}

/**
 * Resolve a share link by its token hash — deliberately NOT org-scoped: the
 * token is the capability. Returns the row whatever its revoked/expired state;
 * the caller decides how to refuse.
 */
export async function getOsShareLinkByTokenHash(
	db: DbQueryClient,
	tokenHash: string,
): Promise<OsShareLinkRow | undefined> {
	const [row] = await db
		.select()
		.from(osShareLinks)
		.where(eq(osShareLinks.tokenHash, tokenHash))
		.limit(1);
	return row;
}

/**
 * Resolve a link by its permanent public id (the `/s/<id>` path) — not
 * org-scoped, because the visitor has no organization yet; the caller proves
 * the host matches the link's organization before answering.
 */
export async function getOsShareLinkByPublicId(
	db: DbQueryClient,
	publicId: string,
): Promise<OsShareLinkRow | undefined> {
	const [row] = await db
		.select()
		.from(osShareLinks)
		.where(eq(osShareLinks.publicId, publicId))
		.limit(1);
	return row;
}

/** Resolve a link by id for a session read. */
export async function getOsShareLinkById(
	db: DbQueryClient,
	shareLinkId: string,
): Promise<OsShareLinkRow | undefined> {
	const [row] = await db
		.select()
		.from(osShareLinks)
		.where(eq(osShareLinks.id, shareLinkId))
		.limit(1);
	return row;
}

export async function getScopedOsShareLink(
	db: DbQueryClient,
	params: OsShareLinkScopeParams,
): Promise<OsShareLinkRow | undefined> {
	const [row] = await db
		.select()
		.from(osShareLinks)
		.where(
			and(
				eq(osShareLinks.organizationId, params.organizationId),
				eq(osShareLinks.id, params.shareLinkId),
			),
		)
		.limit(1);
	return row;
}

export async function deleteOsShareLink(
	db: DbQueryClient,
	params: OsShareLinkScopeParams,
): Promise<boolean> {
	const result = await db
		.delete(osShareLinks)
		.where(
			and(
				eq(osShareLinks.organizationId, params.organizationId),
				eq(osShareLinks.id, params.shareLinkId),
			),
		);
	return getAffectedRows(result) > 0;
}

/**
 * Mint a hash-only viewer session only while its link is live.
 * The INSERT..SELECT predicate makes link validation and session creation one
 * D1 statement, so revocation cannot interleave between them.
 */
export async function createOsShareSession(
	db: DbQueryClient,
	params: {
		id: string;
		sessionTokenHash: string;
		createdAt: string;
		lastSeenAt: string;
		expiresAt: string;
		linkId: string;
		expectedEffectiveRole: NonNullable<OsShareLinkRow["policyMaxRole"]>;
		now: string;
	},
): Promise<OsShareSessionRow | undefined> {
	const [row] = await db
		.insert(osShareSessions)
		.select(
			db
				.select({
					id: sql<string>`${params.id}`.as("id"),
					shareLinkId: sql<string>`${osShareLinks.id}`.as("share_link_id"),
					sessionTokenHash: sql<string>`${params.sessionTokenHash}`.as(
						"session_token_hash",
					),
					createdAt: sql<string>`${params.createdAt}`.as("created_at"),
					lastSeenAt: sql<string>`${params.lastSeenAt}`.as("last_seen_at"),
					expiresAt: sql<string>`${params.expiresAt}`.as("expires_at"),
					revokedAt: sql<string | null>`${null}`.as("revoked_at"),
				})
				.from(osShareLinks)
				.where(
					and(
						eq(osShareLinks.id, params.linkId),
						isNull(osShareLinks.revokedAt),
						sql`(${osShareLinks.expiresAt} is null or ${osShareLinks.expiresAt} > ${params.now})`,
						sql`${SHARE_ROLE_RANK[params.expectedEffectiveRole]} = ${effectiveShareRoleRankSql()}`,
					),
				),
		)
		.returning();
	return row;
}

/** Resolve a live session and advance its last-seen timestamp. */
export async function touchOsShareSession(
	db: DbQueryClient,
	sessionTokenHash: string,
	now: string,
): Promise<OsShareSessionRow | undefined> {
	const [row] = await db
		.update(osShareSessions)
		.set({ lastSeenAt: now })
		.where(
			and(
				eq(osShareSessions.sessionTokenHash, sessionTokenHash),
				isNull(osShareSessions.revokedAt),
				gt(osShareSessions.expiresAt, now),
			),
		)
		.returning();
	return row;
}

/**
 * A live session by id, for a runtime that already holds a signed reference
 * to it (a guest's app session). Read-only: it does not advance last-seen.
 */
export async function getLiveOsShareSession(
	db: DbQueryClient,
	sessionId: string,
	now: string,
): Promise<OsShareSessionRow | undefined> {
	const [row] = await db
		.select()
		.from(osShareSessions)
		.where(
			and(
				eq(osShareSessions.id, sessionId),
				isNull(osShareSessions.revokedAt),
				gt(osShareSessions.expiresAt, now),
			),
		)
		.limit(1);
	return row;
}

/** Everyone on a link's invite list, oldest first. */
export async function listOsShareLinkInvitees(
	db: DbQueryClient,
	params: OsShareLinkScopeParams,
): Promise<OsShareLinkInviteeRow[]> {
	return db
		.select()
		.from(osShareLinkInvitees)
		.where(
			and(
				eq(osShareLinkInvitees.organizationId, params.organizationId),
				eq(osShareLinkInvitees.shareLinkId, params.shareLinkId),
			),
		)
		.orderBy(osShareLinkInvitees.addedAt, osShareLinkInvitees.id);
}

/**
 * Add a person to a link's invite list. A repeat for the same email keeps the
 * existing row (and its earlier `added_at`); the insert and the read-back run
 * in one D1 batch.
 */
export async function addOsShareLinkInvitee(
	db: DbQueryClient,
	invitee: NewOsShareLinkInviteeRow & { email: string },
): Promise<OsShareLinkInviteeRow> {
	const [, rows] = await db.batch([
		db.insert(osShareLinkInvitees).values(invitee).onConflictDoNothing(),
		db
			.select()
			.from(osShareLinkInvitees)
			.where(
				and(
					eq(osShareLinkInvitees.shareLinkId, invitee.shareLinkId),
					eq(osShareLinkInvitees.email, invitee.email),
				),
			)
			.limit(1),
	]);
	const row = rows[0];
	if (!row) throw new Error("OS share link invitee insert returned no row");
	return row;
}

/**
 * Remove an invitee and, in the same batch, end every live session on the
 * link. A session does not record who opened it, and a guest's app calls do
 * not re-check the list, so ending them all is what stops the removed person;
 * everyone still invited reopens the link.
 */
export async function removeOsShareLinkInvitee(
	db: DbQueryClient,
	params: OsShareLinkScopeParams & { inviteeId: string; now?: string },
): Promise<boolean> {
	const now = params.now ?? new Date().toISOString();
	const invitee = and(
		eq(osShareLinkInvitees.organizationId, params.organizationId),
		eq(osShareLinkInvitees.shareLinkId, params.shareLinkId),
		eq(osShareLinkInvitees.id, params.inviteeId),
	);
	const endSessions = db
		.update(osShareSessions)
		.set({ revokedAt: sql`coalesce(${osShareSessions.revokedAt}, ${now})` })
		.where(
			and(
				eq(osShareSessions.shareLinkId, params.shareLinkId),
				isNull(osShareSessions.revokedAt),
				sql`exists (select 1 from ${osShareLinkInvitees} where ${invitee})`,
			),
		);
	const removeInvitee = db
		.delete(osShareLinkInvitees)
		.where(invitee)
		.returning({ id: osShareLinkInvitees.id });
	const [, removed] = await db.batch([endSessions, removeInvitee]);
	return removed.length > 0;
}

/**
 * Whether a signed-in person is on a link's invite list, by Tedix user id or
 * by (lowercased) email. A workspace link also admits the workspace's
 * collaborators, who were invited through the workspace itself.
 */
export async function isOsShareLinkInvitee(
	db: DbQueryClient,
	params: {
		link: Pick<OsShareLinkRow, "id" | "resourceType" | "resourceId">;
		userId: string;
		email: string | null;
	},
): Promise<boolean> {
	const email = params.email?.trim().toLowerCase() || null;
	const invitee = db
		.select({ inviteeId: osShareLinkInvitees.id })
		.from(osShareLinkInvitees)
		.where(
			and(
				eq(osShareLinkInvitees.shareLinkId, params.link.id),
				email
					? sql`(${osShareLinkInvitees.userId} = ${params.userId} or ${osShareLinkInvitees.email} = ${email})`
					: eq(osShareLinkInvitees.userId, params.userId),
			),
		)
		.limit(1);
	if (params.link.resourceType !== "workspace") {
		return (await invitee).length > 0;
	}
	const collaborator = db
		.select({ collaboratorId: osWorkspaceCollaborators.id })
		.from(osWorkspaceCollaborators)
		.where(
			and(
				eq(osWorkspaceCollaborators.workspaceId, params.link.resourceId),
				eq(osWorkspaceCollaborators.userId, params.userId),
			),
		)
		.limit(1);
	const [invitees, collaborators] = await db.batch([invitee, collaborator]);
	return invitees.length > 0 || collaborators.length > 0;
}

/** Count live sessions for revocation-impact preview. */
export async function countActiveOsShareSessions(
	db: DbQueryClient,
	shareLinkId: string,
	now: string,
): Promise<number> {
	const [row] = await db
		.select({ value: count() })
		.from(osShareSessions)
		.where(
			and(
				eq(osShareSessions.shareLinkId, shareLinkId),
				isNull(osShareSessions.revokedAt),
				gt(osShareSessions.expiresAt, now),
			),
		);
	return row?.value ?? 0;
}
