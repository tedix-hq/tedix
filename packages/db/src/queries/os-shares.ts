import { and, count, desc, eq, gt, isNull, sql } from "drizzle-orm";
import { coreTable } from "../core-store/client";
import { anyIds, changedRows, coreStore } from "../core-store/dialect";
import { batchNonEmpty, chunkForBoundParams } from "../utils/batch";
import type { DbQueryClient } from "../query-client";
import { apiKeys as d1ApiKeys } from "../schema/api-keys";
import { externalAgentPrincipals as d1ExternalAgentPrincipals } from "../schema/external-agent-identity";
import { organizationMembers as d1OrganizationMembers } from "../schema/organization-members";
import { osWorkspaceCollaborators as d1OsWorkspaceCollaborators } from "../schema/os-collaborators";
import { tedis as d1Tedis } from "../schema/tedis";
import {
	type NewOsShareLinkInviteeRow,
	type NewOsShareLinkRow,
	type OsShareLinkInviteeRow,
	type OsShareLinkRow,
	type OsShareSessionRow,
	osShareLinkInvitees as d1OsShareLinkInvitees,
	osShareLinks as d1OsShareLinks,
	osShareSessions as d1OsShareSessions,
	osShareEmailCodes as d1OsShareEmailCodes,
	osShareSkillReadGrants as d1OsShareSkillReadGrants,
	type NewOsShareSkillReadGrantRow,
} from "../schema/os-shares";

export interface OsShareLinkScopeParams {
	organizationId: string;
	shareLinkId: string;
}

export interface OsShareResourceScopeParams {
	organizationId: string;
	resourceType: OsShareLinkRow["resourceType"];
	resourceId: string;
}

/** Serialize redemption with policy changes before their statement snapshots. */
function buildOsShareLinkLockStatements(
	db: DbQueryClient,
	params: { shareLinkId: string; organizationId?: string },
) {
	if (coreStore(db) !== "postgres") return [];
	const osShareLinks = coreTable(db, d1OsShareLinks);
	const scope = and(
		eq(osShareLinks.id, params.shareLinkId),
		params.organizationId === undefined
			? undefined
			: eq(osShareLinks.organizationId, params.organizationId),
	);
	return [
		db
			.select({ lock: sql<number>`1`.as("lock") })
			.from(
				sql`(select ${osShareLinks.id} from ${osShareLinks} where ${scope} for update) as locked_share`,
			),
	];
}

export async function getOsShareGrantApprover(
	db: DbQueryClient,
	organizationId: string,
	userId: string,
) {
	const organizationMembers = coreTable(db, d1OrganizationMembers);
	const [row] = await db
		.select()
		.from(organizationMembers)
		.where(
			and(
				eq(organizationMembers.organizationId, organizationId),
				eq(organizationMembers.userId, userId),
			),
		)
		.limit(1);
	return row;
}

export async function getOsShareSkillReadGrant(
	db: DbQueryClient,
	params: OsShareLinkScopeParams & {
		gadgetId: string;
		slot: string;
	},
) {
	const osShareSkillReadGrants = coreTable(db, d1OsShareSkillReadGrants);
	const [row] = await db
		.select()
		.from(osShareSkillReadGrants)
		.where(
			and(
				eq(osShareSkillReadGrants.organizationId, params.organizationId),
				eq(osShareSkillReadGrants.shareLinkId, params.shareLinkId),
				eq(osShareSkillReadGrants.gadgetId, params.gadgetId),
				eq(osShareSkillReadGrants.slot, params.slot),
				isNull(osShareSkillReadGrants.revokedAt),
			),
		)
		.limit(1);
	return row;
}

export async function setOsShareSkillReadGrants(
	db: DbQueryClient,
	scope: OsShareLinkScopeParams,
	grants: readonly NewOsShareSkillReadGrantRow[],
) {
	const osShareSkillReadGrants = coreTable(db, d1OsShareSkillReadGrants);
	if (
		grants.some(
			(grant) =>
				grant.organizationId !== scope.organizationId ||
				grant.shareLinkId !== scope.shareLinkId,
		)
	)
		throw new Error("Share approval scope mismatch");
	const unique = new Map<string, NewOsShareSkillReadGrantRow>();
	for (const grant of grants) {
		const key = JSON.stringify([grant.revisionId, grant.slot]);
		const previous = unique.get(key);
		unique.set(
			key,
			previous
				? {
						...previous,
						resourceId: grant.resourceId,
						providerResourceId: grant.providerResourceId,
						approvedByUserId: grant.approvedByUserId,
						approvedAt: grant.approvedAt,
						revokedAt: null,
					}
				: grant,
		);
	}
	const size = coreStore(db) === "postgres" ? Math.max(unique.size, 1) : 6;
	await db.batch([
		db
			.update(osShareSkillReadGrants)
			.set({ revokedAt: new Date().toISOString() })
			.where(
				and(
					eq(osShareSkillReadGrants.organizationId, scope.organizationId),
					eq(osShareSkillReadGrants.shareLinkId, scope.shareLinkId),
				),
			),
		...chunkForBoundParams([...unique.values()], size).map((rows) =>
			db
				.insert(osShareSkillReadGrants)
				.values(rows)
				.onConflictDoUpdate({
					target: [
						osShareSkillReadGrants.organizationId,
						osShareSkillReadGrants.shareLinkId,
						osShareSkillReadGrants.revisionId,
						osShareSkillReadGrants.slot,
					],
					set: {
						resourceId: sql`excluded.resource_id`,
						providerResourceId: sql`excluded.provider_resource_id`,
						approvedByUserId: sql`excluded.approved_by_user_id`,
						approvedAt: sql`excluded.approved_at`,
						revokedAt: null,
					},
				}),
		),
	]);
}

export async function createOsShareLink(
	db: DbQueryClient,
	link: NewOsShareLinkRow,
): Promise<OsShareLinkRow> {
	const osShareLinks = coreTable(db, d1OsShareLinks);
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
	const osShareLinks = coreTable(db, d1OsShareLinks);
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

/** Which of `resourceIds` still have at least one unrevoked share link. */
export async function listOsShareResourceIdsWithActiveLinks(
	db: DbQueryClient,
	params: {
		organizationId: string;
		resourceType: OsShareLinkRow["resourceType"];
		resourceIds: string[];
	},
): Promise<Set<string>> {
	const osShareLinks = coreTable(db, d1OsShareLinks);
	if (!params.resourceIds.length) return new Set();
	const rows = await db
		.selectDistinct({ resourceId: osShareLinks.resourceId })
		.from(osShareLinks)
		.where(
			and(
				eq(osShareLinks.organizationId, params.organizationId),
				eq(osShareLinks.resourceType, params.resourceType),
				anyIds(db, osShareLinks.resourceId, params.resourceIds),
				isNull(osShareLinks.revokedAt),
			),
		);
	return new Set(rows.map((row) => row.resourceId));
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
	const osShareLinks = coreTable(db, d1OsShareLinks);
	const osShareSessions = coreTable(db, d1OsShareSessions);
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
	const locks = buildOsShareLinkLockStatements(db, params);
	const results = await db.batch(
		batchNonEmpty([...locks, updateLink, revokeSessions]),
	);
	const rows = results[locks.length] as OsShareLinkRow[];
	return rows[0];
}

const SHARE_ROLE_RANK = { viewer: 0, use: 1, edit: 2, build: 3 } as const;

function effectiveShareRoleRankSql(db: DbQueryClient) {
	const osShareLinks = coreTable(db, d1OsShareLinks);
	return sql<number>`case
		when ${osShareLinks.policyMaxRole} = 'viewer' then 0
		when ${osShareLinks.policyMaxRole} = 'use' then 1
		when ${osShareLinks.policyMaxRole} = 'edit' then 2
		when ${osShareLinks.policyMaxRole} = 'build' then 3
		when ${osShareLinks.role} = 'viewer' then 0
		when ${osShareLinks.role} = 'use' then 1
		when ${osShareLinks.role} = 'edit' then 2
		else 3
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
	const osShareLinks = coreTable(db, d1OsShareLinks);
	const osShareSessions = coreTable(db, d1OsShareSessions);
	const requestedRank = SHARE_ROLE_RANK[params.maxRole];
	const now = params.now ?? new Date().toISOString();
	const canStayOrTighten = and(
		eq(osShareLinks.organizationId, params.organizationId),
		eq(osShareLinks.id, params.shareLinkId),
		sql`${requestedRank} <= ${effectiveShareRoleRankSql(db)}`,
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
						and ${requestedRank} < ${effectiveShareRoleRankSql(db)}
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
	const locks = buildOsShareLinkLockStatements(db, params);
	const results = await db.batch(
		batchNonEmpty([...locks, revokeSessions, updateLink]),
	);
	const revokedSessions = results[locks.length] as { id: string }[];
	const rows = results[locks.length + 1] as OsShareLinkRow[];
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
			Pick<
				OsShareLinkRow,
				"role" | "access" | "note" | "expiresAt" | "disabledAt" | "standalone"
			>
		>;
		endSessions: boolean;
		now?: string;
	},
): Promise<{ share: OsShareLinkRow; revokedSessionCount: number } | undefined> {
	const osShareLinks = coreTable(db, d1OsShareLinks);
	const osShareSessions = coreTable(db, d1OsShareSessions);
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
	const locks = buildOsShareLinkLockStatements(db, params);
	if (!params.endSessions) {
		const rows = locks.length
			? ((await db.batch(batchNonEmpty([...locks, updateLink])))[
					locks.length
				] as OsShareLinkRow[])
			: await updateLink;
		const [share] = rows;
		return share ? { share, revokedSessionCount: 0 } : undefined;
	}
	const results = await db.batch(
		batchNonEmpty([...locks, revokeSessions, updateLink]),
	);
	const revokedSessions = results[locks.length] as { id: string }[];
	const rows = results[locks.length + 1] as OsShareLinkRow[];
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
	const osShareLinks = coreTable(db, d1OsShareLinks);
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
	const osShareLinks = coreTable(db, d1OsShareLinks);
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
	const osShareLinks = coreTable(db, d1OsShareLinks);
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
	const osShareLinks = coreTable(db, d1OsShareLinks);
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
	const osShareLinks = coreTable(db, d1OsShareLinks);
	const result = await db
		.delete(osShareLinks)
		.where(
			and(
				eq(osShareLinks.organizationId, params.organizationId),
				eq(osShareLinks.id, params.shareLinkId),
			),
		)
		.returning({ id: osShareLinks.id });
	return changedRows(result) > 0;
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
		verifiedEmail?: string | null;
		createdAt: string;
		lastSeenAt: string;
		expiresAt: string;
		linkId: string;
		expectedEffectiveRole: NonNullable<OsShareLinkRow["policyMaxRole"]>;
		now: string;
	},
): Promise<OsShareSessionRow | undefined> {
	const osShareLinks = coreTable(db, d1OsShareLinks);
	const osShareSessions = coreTable(db, d1OsShareSessions);
	const insertSession = db
		.insert(osShareSessions)
		.select(
			db
				.select({
					id: sql<string>`${params.id}`.as("id"),
					shareLinkId: sql<string>`${osShareLinks.id}`.as("share_link_id"),
					sessionTokenHash: sql<string>`${params.sessionTokenHash}`.as(
						"session_token_hash",
					),
					verifiedEmail: sql<string | null>`${params.verifiedEmail ?? null}`.as(
						"verified_email",
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
						isNull(osShareLinks.disabledAt),
						sql`(${osShareLinks.expiresAt} is null or ${osShareLinks.expiresAt} > ${params.now})`,
						sql`${SHARE_ROLE_RANK[params.expectedEffectiveRole]} = ${effectiveShareRoleRankSql(db)}`,
					),
				),
		)
		.returning();
	const locks = buildOsShareLinkLockStatements(db, {
		shareLinkId: params.linkId,
	});
	const rows = locks.length
		? ((await db.batch(batchNonEmpty([...locks, insertSession])))[
				locks.length
			] as OsShareSessionRow[])
		: await insertSession;
	const [row] = rows;
	return row;
}

/** Resolve a live session and advance its last-seen timestamp. */
export async function touchOsShareSession(
	db: DbQueryClient,
	sessionTokenHash: string,
	now: string,
): Promise<OsShareSessionRow | undefined> {
	const osShareSessions = coreTable(db, d1OsShareSessions);
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
	const osShareSessions = coreTable(db, d1OsShareSessions);
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
	const osShareLinkInvitees = coreTable(db, d1OsShareLinkInvitees);
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
	const osShareLinkInvitees = coreTable(db, d1OsShareLinkInvitees);
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

export async function removeOsShareLinkInvitee(
	db: DbQueryClient,
	params: OsShareLinkScopeParams & { inviteeId: string },
): Promise<boolean> {
	const osShareLinkInvitees = coreTable(db, d1OsShareLinkInvitees);
	const result = await db
		.delete(osShareLinkInvitees)
		.where(
			and(
				eq(osShareLinkInvitees.organizationId, params.organizationId),
				eq(osShareLinkInvitees.shareLinkId, params.shareLinkId),
				eq(osShareLinkInvitees.id, params.inviteeId),
			),
		)
		.returning({ id: osShareLinkInvitees.id });
	return changedRows(result) > 0;
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
	const osShareLinkInvitees = coreTable(db, d1OsShareLinkInvitees);
	const osWorkspaceCollaborators = coreTable(db, d1OsWorkspaceCollaborators);
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

/**
 * The display name of whoever made a link, for the shared page's
 * "Shared by <name>" line: a person's membership name, a tedi's display name,
 * an external agent's principal name or an API key's name — org-scoped, and
 * null when the principal can no longer be named.
 * personOnly limits attribution to a human membership's nonblank name.
 */
export async function getOsShareCreatorName(
	db: DbQueryClient,
	link: Pick<
		OsShareLinkRow,
		"organizationId" | "createdByKind" | "createdById"
	>,
	options: { personOnly?: boolean } = {},
): Promise<string | null> {
	const organizationMembers = coreTable(db, d1OrganizationMembers);
	const tedis = coreTable(db, d1Tedis);
	const externalAgentPrincipals = coreTable(db, d1ExternalAgentPrincipals);
	const apiKeys = coreTable(db, d1ApiKeys);
	if (options.personOnly && link.createdByKind !== "user") return null;
	const scope = { organizationId: link.organizationId, id: link.createdById };
	if (link.createdByKind === "user") {
		const [row] = await db
			.select({
				name: organizationMembers.name,
				email: organizationMembers.email,
				kind: organizationMembers.kind,
			})
			.from(organizationMembers)
			.where(
				and(
					eq(organizationMembers.organizationId, scope.organizationId),
					eq(organizationMembers.descopeUserId, scope.id),
				),
			)
			.limit(1);
		if (options.personOnly)
			return row?.kind === "human" ? row.name?.trim() || null : null;
		return row?.name ?? row?.email ?? null;
	}
	if (link.createdByKind === "tedi") {
		const [row] = await db
			.select({ displayName: tedis.displayName, name: tedis.name })
			.from(tedis)
			.where(
				and(
					eq(tedis.organizationId, scope.organizationId),
					eq(tedis.id, scope.id),
				),
			)
			.limit(1);
		return row?.displayName ?? row?.name ?? null;
	}
	if (link.createdByKind === "external_agent") {
		const [row] = await db
			.select({ displayName: externalAgentPrincipals.displayName })
			.from(externalAgentPrincipals)
			.where(
				and(
					eq(externalAgentPrincipals.organizationId, scope.organizationId),
					eq(externalAgentPrincipals.id, scope.id),
				),
			)
			.limit(1);
		return row?.displayName ?? null;
	}
	const [row] = await db
		.select({ name: apiKeys.name })
		.from(apiKeys)
		.where(
			and(
				eq(apiKeys.organizationId, scope.organizationId),
				eq(apiKeys.id, scope.id),
			),
		)
		.limit(1);
	return row?.name ?? null;
}

/** Count live sessions for revocation-impact preview. */
export async function countActiveOsShareSessions(
	db: DbQueryClient,
	shareLinkId: string,
	now: string,
): Promise<number> {
	const osShareSessions = coreTable(db, d1OsShareSessions);
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

/** Atomic rolling-window reservation: concurrent sends cannot exceed either limit. */
export async function reserveOsShareEmailCode(
	db: DbQueryClient,
	params: typeof d1OsShareEmailCodes.$inferInsert & { windowStart: string },
): Promise<boolean> {
	const osShareEmailCodes = coreTable(db, d1OsShareEmailCodes);
	const osShareLinks = coreTable(db, d1OsShareLinks);
	const { windowStart, ...code } = params;
	const reserve = db
		.insert(osShareEmailCodes)
		.select(
			db
				.select({
					id: sql<string>`${code.id}`.as("id"),
					shareLinkId: sql<string>`${code.shareLinkId}`.as("share_link_id"),
					email: sql<string>`${code.email}`.as("email"),
					codeHash: sql<string>`${code.codeHash}`.as("code_hash"),
					ipHash: sql<string>`${code.ipHash}`.as("ip_hash"),
					createdAt: sql<string>`${code.createdAt}`.as("created_at"),
					expiresAt: sql<string>`${code.expiresAt}`.as("expires_at"),
					attempts: sql<number>`0`.as("attempts"),
					consumedAt: sql<string | null>`null`.as("consumed_at"),
				})
				.from(osShareLinks)
				.where(
					and(
						eq(osShareLinks.id, code.shareLinkId),
						eq(osShareLinks.access, "invited"),
						isNull(osShareLinks.revokedAt),
						isNull(osShareLinks.disabledAt),
						sql`(${osShareLinks.expiresAt} is null or ${osShareLinks.expiresAt} > ${code.createdAt})`,
						sql`(select count(*) from ${osShareEmailCodes} where share_link_id = ${code.shareLinkId} and email = ${code.email} and created_at > ${windowStart}) < 3`,
						sql`(select count(*) from ${osShareEmailCodes} where ip_hash = ${code.ipHash} and created_at > ${windowStart}) < 20`,
					),
				),
		)
		.returning({ id: osShareEmailCodes.id });
	// D1 serializes writers. Postgres needs transaction-held locks before the
	// reservation statement takes its snapshot; both limits share one batch.
	const rows =
		coreStore(db) === "postgres"
			? (
					await db.batch([
						db
							.select({
								lock: sql`pg_advisory_xact_lock(hashtextextended(${JSON.stringify(["share-email", code.shareLinkId, code.email])}, 0))`,
							})
							.from(sql`(select 1) as lock_scope`),
						db
							.select({
								lock: sql`pg_advisory_xact_lock(hashtextextended(${JSON.stringify(["share-ip", code.ipHash])}, 0))`,
							})
							.from(sql`(select 1) as lock_scope`),
						reserve,
					])
				)[2]
			: await reserve;
	return rows.length === 1;
}

/** Increment every guess and consume only a matching, unexpired challenge, once. */
export async function consumeOsShareEmailCode(
	db: DbQueryClient,
	params: { linkId: string; email: string; codeHash: string; now: string },
): Promise<boolean> {
	const osShareEmailCodes = coreTable(db, d1OsShareEmailCodes);
	const latest = db
		.select({ id: osShareEmailCodes.id })
		.from(osShareEmailCodes)
		.where(
			and(
				eq(osShareEmailCodes.shareLinkId, params.linkId),
				eq(osShareEmailCodes.email, params.email),
			),
		)
		.orderBy(desc(osShareEmailCodes.createdAt), desc(osShareEmailCodes.id))
		.limit(1);
	const [row] = await db
		.update(osShareEmailCodes)
		.set({
			attempts: sql`${osShareEmailCodes.attempts} + 1`,
			consumedAt: sql`case when ${osShareEmailCodes.codeHash} = ${params.codeHash} then ${params.now} else null end`,
		})
		.where(
			and(
				eq(osShareEmailCodes.id, sql`(${latest})`),
				isNull(osShareEmailCodes.consumedAt),
				gt(osShareEmailCodes.expiresAt, params.now),
				sql`${osShareEmailCodes.attempts} < 5`,
			),
		)
		.returning({ consumedAt: osShareEmailCodes.consumedAt });
	return row?.consumedAt === params.now;
}

/** Email-only admission for guests; no user or workspace-collaborator fallback. */
export async function isOsShareEmailInvited(
	db: DbQueryClient,
	linkId: string,
	email: string,
): Promise<boolean> {
	const osShareLinkInvitees = coreTable(db, d1OsShareLinkInvitees);
	const rows = await db
		.select({ id: osShareLinkInvitees.id })
		.from(osShareLinkInvitees)
		.where(
			and(
				eq(osShareLinkInvitees.shareLinkId, linkId),
				eq(osShareLinkInvitees.email, email),
			),
		)
		.limit(1);
	return rows.length > 0;
}

/** Owner-visible open history, scoped through the link's organization. */
export async function listOsShareEmailOpens(
	db: DbQueryClient,
	params: OsShareLinkScopeParams,
) {
	const osShareSessions = coreTable(db, d1OsShareSessions);
	const osShareLinks = coreTable(db, d1OsShareLinks);
	return db
		.select({
			email: osShareSessions.verifiedEmail,
			openedAt: osShareSessions.createdAt,
		})
		.from(osShareSessions)
		.innerJoin(osShareLinks, eq(osShareLinks.id, osShareSessions.shareLinkId))
		.where(
			and(
				eq(osShareLinks.organizationId, params.organizationId),
				eq(osShareLinks.id, params.shareLinkId),
				sql`${osShareSessions.verifiedEmail} is not null`,
			),
		)
		.orderBy(desc(osShareSessions.createdAt))
		.limit(100);
}

/**
 * Who saved through a share link, by share session: the email each session
 * proved and, when that person is also a member of the organization, their
 * name. Scoped through the link's organization; a session whose link was
 * deleted is gone and is not returned.
 */
export async function listOsShareSessionPeople(
	db: DbQueryClient,
	params: { organizationId: string; sessionIds: readonly string[] },
): Promise<Map<string, { email: string; name: string | null }>> {
	const osShareSessions = coreTable(db, d1OsShareSessions);
	const osShareLinks = coreTable(db, d1OsShareLinks);
	const organizationMembers = coreTable(db, d1OrganizationMembers);
	const people = new Map<string, { email: string; name: string | null }>();
	if (params.sessionIds.length) {
		const rows = await db
			.select({
				sessionId: osShareSessions.id,
				sessionEmail: osShareSessions.verifiedEmail,
				memberName: organizationMembers.name,
			})
			.from(osShareSessions)
			.innerJoin(osShareLinks, eq(osShareLinks.id, osShareSessions.shareLinkId))
			.leftJoin(
				organizationMembers,
				and(
					eq(organizationMembers.organizationId, osShareLinks.organizationId),
					eq(organizationMembers.kind, "human"),
					sql`lower(${organizationMembers.email}) = lower(${osShareSessions.verifiedEmail})`,
				),
			)
			.where(
				and(
					eq(osShareLinks.organizationId, params.organizationId),
					anyIds(db, osShareSessions.id, [...new Set(params.sessionIds)]),
				),
			);
		for (const row of rows) {
			if (!row.sessionEmail) continue;
			const name = row.memberName?.trim() || null;
			const known = people.get(row.sessionId);
			if (!known || (!known.name && name))
				people.set(row.sessionId, { email: row.sessionEmail, name });
		}
	}
	return people;
}
