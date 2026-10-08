/**
 * Organization Member Query Helpers
 * Database queries for team membership and RBAC
 *
 * Members link to canonical users via userId. Descope subjects remain on the
 * adapter edge for invitations and migration fallback.
 */

import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { DbClient } from "../client";
import { apps } from "../schema/apps";
import type {
	MemberRole,
	MemberStatus,
	NewOrganizationMember,
	OrganizationMember,
} from "../schema/organization-members";
import { organizationMembers } from "../schema/organization-members";
import { organizations } from "../schema/organizations";
import { tedis } from "../schema/tedis";
import { chunkForBoundParams } from "../utils/batch";
import type { OrganizationPermission } from "@tedix/api-contract/schemas/user-settings";

// ============================================================================
// Read Operations
// ============================================================================

/**
 * Get member by ID
 *
 * @param db - Database client
 * @param id - Member ID
 */
export async function getMemberById(
	db: DbClient,
	id: string,
): Promise<OrganizationMember | undefined> {
	return db.query.organizationMembers.findFirst({ where: { id } });
}

/**
 * Get member by organization and Descope user ID
 * Primary lookup for checking user membership
 *
 * @param db - Database client
 * @param organizationId - Organization ID
 * @param descopeUserId - Descope user ID
 */
export async function getMemberByUserId(
	db: DbClient,
	organizationId: string,
	descopeUserId: string,
): Promise<OrganizationMember | undefined> {
	return db.query.organizationMembers.findFirst({
		where: { organizationId, descopeUserId },
	});
}

/**
 * Active member of an organization by normalized email. Used by inbound email
 * sender trust: a verified member address is a trusted correspondent.
 */
export async function getActiveMemberByEmail(
	db: DbClient,
	organizationId: string,
	email: string,
): Promise<OrganizationMember | undefined> {
	return db.query.organizationMembers.findFirst({
		where: {
			organizationId,
			email: email.trim().toLowerCase(),
			status: "active",
		},
	});
}

/**
 * One statement for a user's memberships in a bounded set of Descope tenants:
 * non-retired organizations joined to that user's member rows. Callers decide
 * which statuses grant access. Replaces a per-tenant org-then-member lookup on
 * the live MCP grant path.
 */
export async function getMembershipsByDescopeTenants(
	db: DbClient,
	descopeTenantIds: string[],
	descopeUserId: string,
): Promise<
	Array<{
		organizationId: string;
		descopeTenantId: string;
		status: OrganizationMember["status"];
	}>
> {
	const tenantIds = [...new Set(descopeTenantIds)];
	if (tenantIds.length === 0) return [];
	const rows: Array<{
		organizationId: string;
		descopeTenantId: string | null;
		status: OrganizationMember["status"];
	}> = [];
	// D1 caps bound parameters at 100 per statement.
	for (const chunk of chunkForBoundParams(tenantIds, 50)) {
		rows.push(
			...(await db
				.select({
					organizationId: organizations.id,
					descopeTenantId: organizations.descopeTenantId,
					status: organizationMembers.status,
				})
				.from(organizations)
				.innerJoin(
					organizationMembers,
					and(
						eq(organizationMembers.organizationId, organizations.id),
						eq(organizationMembers.descopeUserId, descopeUserId),
					),
				)
				.where(
					and(
						inArray(organizations.descopeTenantId, chunk),
						sql`json_extract(${organizations.metadata}, '$.retiredAt') IS NULL`,
					),
				)),
		);
	}
	return rows.flatMap(({ descopeTenantId, ...row }) =>
		descopeTenantId ? [{ ...row, descopeTenantId }] : [],
	);
}

/** Resolve membership by the stable Tedix user id, independent of provider. */
export async function getMemberByCanonicalUserId(
	db: DbClient,
	organizationId: string,
	userId: string,
): Promise<OrganizationMember | undefined> {
	return db.query.organizationMembers.findFirst({
		where: { organizationId, userId },
	});
}

/**
 * Count active owners in an organization.
 *
 * Used to enforce the last-owner invariant: an org must always retain at least
 * one active owner, so a demotion/removal that would drop the count to zero is
 * rejected.
 */
export async function countActiveOwners(
	db: DbClient,
	organizationId: string,
): Promise<number> {
	return db.$count(
		organizationMembers,
		and(
			eq(organizationMembers.organizationId, organizationId),
			eq(organizationMembers.role, "owner"),
			eq(organizationMembers.status, "active"),
		),
	);
}

/**
 * Get all members of an organization
 *
 * @param db - Database client
 * @param organizationId - Organization ID
 * @param opts - Filter options
 */
export async function getMembersByOrganization(
	db: DbClient,
	organizationId: string,
	opts?: {
		status?: MemberStatus;
		role?: MemberRole;
		limit?: number;
		offset?: number;
	},
): Promise<OrganizationMember[]> {
	const conditions = [eq(organizationMembers.organizationId, organizationId)];

	if (opts?.status) {
		conditions.push(eq(organizationMembers.status, opts.status));
	}

	if (opts?.role) {
		conditions.push(eq(organizationMembers.role, opts.role));
	}

	return db
		.select()
		.from(organizationMembers)
		.where(and(...conditions))
		.orderBy(desc(organizationMembers.createdAt))
		.limit(opts?.limit ?? 100)
		.offset(opts?.offset ?? 0);
}

/**
 * Get all organizations a user belongs to
 * Used for showing user's org list after login
 *
 * @param db - Database client
 * @param descopeUserId - Descope user ID
 * @param opts - Filter options
 */
export async function getUserOrganizationMemberships(
	db: DbClient,
	descopeUserId: string,
	opts?: { activeOnly?: boolean },
): Promise<
	Array<{
		member: OrganizationMember;
		organizationId: string;
		organizationName: string;
		organizationSlug: string;
		organizationLogoUrl: string | null;
		organizationType: "personal" | "organization";
		descopeTenantId: string | null;
		appsCount: number | null;
		tediCount: number;
	}>
> {
	const rows = await db.query.organizationMembers.findMany({
		where: opts?.activeOnly
			? { descopeUserId, status: "active" }
			: { descopeUserId },
		with: { organization: true },
		orderBy: { lastActiveAt: "desc" },
	});
	const organizationIds = rows
		.map((row) => row.organization?.id)
		.filter((id): id is string => Boolean(id));
	const tediCounts: Array<{ organizationId: string; total: number }> = [];
	// D1 caps bound parameters at 100 per statement; chunk the org IN() list.
	// Each org id lands in exactly one chunk, so the per-org GROUP BY rows
	// merge without double counting.
	for (const chunk of chunkForBoundParams(organizationIds, 50)) {
		tediCounts.push(
			...(await db
				.select({
					organizationId: tedis.organizationId,
					total: sql<number>`count(*)`.as("total"),
				})
				.from(tedis)
				// Retired tedis keep their row (and their memory) but are not
				// workers the org still operates, so they must not inflate the
				// per-organization headcount shown to members.
				.where(
					and(inArray(tedis.organizationId, chunk), isNull(tedis.retiredAt)),
				)
				.groupBy(tedis.organizationId)),
		);
	}
	const tediCountByOrganizationId = new Map(
		tediCounts.map((row) => [row.organizationId, Number(row.total) || 0]),
	);

	// Filter out members whose organization no longer exists and map to return shape
	const results = [];
	for (const row of rows) {
		const { organization, ...member } = row;
		if (
			!organization ||
			(organization.metadata as { retiredAt?: string } | null)?.retiredAt
		)
			continue;

		results.push({
			member,
			organizationId: organization.id,
			organizationName: organization.name,
			organizationSlug: organization.slug,
			organizationLogoUrl: organization.logoUrl ?? null,
			organizationType: (organization.type ?? "organization") as
				| "personal"
				| "organization",
			descopeTenantId: organization.descopeTenantId ?? null,
			appsCount: organization.appsCount ?? null,
			tediCount: tediCountByOrganizationId.get(organization.id) ?? 0,
		});
	}

	return results;
}

/**
 * List the caller's active memberships whose organizations explicitly enable
 * the Tedix OS. This is the apex launcher's source of truth: wildcard
 * DNS makes every slug resolvable, so membership alone is insufficient and an
 * unprovisioned organization must never be offered as an OS destination.
 *
 * The result deliberately excludes gateway, billing, and operational fields.
 * The launcher needs identity plus a canonical hostname slug and nothing else.
 */
export async function getUserOsMemberships(
	db: DbClient,
	descopeUserId: string,
): Promise<
	Array<{
		organizationId: string;
		organizationName: string;
		organizationSlug: string;
		organizationLogoUrl: string | null;
	}>
> {
	const rows = await db.query.organizationMembers.findMany({
		where: { descopeUserId, status: "active" },
		with: { organization: true },
		orderBy: { lastActiveAt: "desc" },
	});

	return rows.flatMap((row) => {
		const organization = row.organization;
		if (
			!organization ||
			(organization.metadata as { retiredAt?: string } | null)?.retiredAt ||
			organization.features?.os !== true
		)
			return [];
		return [
			{
				organizationId: organization.id,
				organizationName: organization.name,
				organizationSlug: organization.slug,
				organizationLogoUrl: organization.logoUrl ?? null,
			},
		];
	});
}

/**
 * Resolve each organization's org-wide unified MCP gateway app (the Code Mode
 * aggregator), keyed by organization id. The gateway is an `apps` row whose own
 * slug becomes `{slug}.mcp.<domain>` — it is NOT derivable from the org slug
 * (e.g. org "acme-s-workspace-1a2b3c" → gateway "acme-unified"). It is
 * distinguished from per-tool proxy apps (which also set `aggregateApps` +
 * `authMode:"authenticated"`) by `codeMode === true`; when an org has several
 * candidates a `-unified` slug wins the tie-break.
 *
 * Returns the aggregator's slug + customMcpDomain so the API layer (which knows
 * the environment's MCP domain) can build the full gateway URL.
 */
export async function getOrganizationAggregatorGateways(
	db: DbClient,
	organizationIds: string[],
): Promise<Map<string, { slug: string; customMcpDomain: string | null }>> {
	const result = new Map<
		string,
		{ slug: string; customMcpDomain: string | null }
	>();
	if (organizationIds.length === 0) return result;
	const selectChunk = (chunk: string[]) =>
		db
			.select({
				organizationId: apps.organizationId,
				slug: apps.slug,
				customMcpDomain: apps.customMcpDomain,
				metadata: apps.metadata,
			})
			.from(apps)
			.where(inArray(apps.organizationId, chunk));
	const rows: Awaited<ReturnType<typeof selectChunk>> = [];
	// D1 caps bound parameters at 100 per statement; chunk the org IN() list.
	for (const chunk of chunkForBoundParams([...new Set(organizationIds)], 50)) {
		rows.push(...(await selectChunk(chunk)));
	}
	const candidatesByOrg = new Map<
		string,
		Array<{ slug: string; customMcpDomain: string | null }>
	>();
	for (const row of rows) {
		if (!row.organizationId) continue;
		const mcpConfig = (
			row.metadata as { mcpConfig?: Record<string, unknown> } | null
		)?.mcpConfig;
		if (!mcpConfig || typeof mcpConfig !== "object") continue;
		const aggregateApps = (mcpConfig as { aggregateApps?: unknown })
			.aggregateApps;
		const aggregateTedis = (mcpConfig as { aggregateTedis?: unknown })
			.aggregateTedis;
		const isUnifiedGateway =
			(mcpConfig as { authMode?: unknown }).authMode === "authenticated" &&
			(mcpConfig as { codeMode?: unknown }).codeMode === true &&
			((Array.isArray(aggregateApps) && aggregateApps.length > 0) ||
				(Array.isArray(aggregateTedis) && aggregateTedis.length > 0) ||
				row.slug.endsWith("-unified"));
		if (!isUnifiedGateway) continue;
		const list = candidatesByOrg.get(row.organizationId) ?? [];
		list.push({ slug: row.slug, customMcpDomain: row.customMcpDomain ?? null });
		candidatesByOrg.set(row.organizationId, list);
	}
	for (const [organizationId, candidates] of candidatesByOrg) {
		const chosen =
			candidates.find((c) => c.slug.endsWith("-unified")) ?? candidates[0];
		if (chosen) result.set(organizationId, chosen);
	}
	return result;
}

// ============================================================================
// Write Operations
// ============================================================================

/**
 * Add a member to an organization
 *
 * @param db - Database client
 * @param data - Member data
 */
export async function addMember(
	db: DbClient,
	data: Omit<NewOrganizationMember, "id" | "createdAt" | "updatedAt">,
): Promise<OrganizationMember> {
	const id = crypto.randomUUID();
	const now = new Date().toISOString();

	await db.insert(organizationMembers).values({
		...data,
		id,
		email: data.email.toLowerCase(),
		createdAt: now,
		updatedAt: now,
	});

	const created = await getMemberById(db, id);
	if (!created) {
		throw new Error(`Failed to add member: ${id}`);
	}
	return created;
}

/**
 * Invite a member to an organization
 * Creates a pending membership that becomes active when user accepts
 *
 * @param db - Database client
 * @param organizationId - Organization ID
 * @param email - Email to invite
 * @param role - Role to assign
 * @param descopeUserId - Descope user ID if already created in Descope
 * @param invitedBy - Descope user ID of inviter
 */
export async function inviteMember(
	db: DbClient,
	organizationId: string,
	email: string,
	role: MemberRole = "member",
	descopeUserId?: string,
	invitedBy?: string,
): Promise<OrganizationMember> {
	const id = crypto.randomUUID();
	const now = new Date().toISOString();

	// Check if already invited/member
	const existingRows = await db
		.select()
		.from(organizationMembers)
		.where(
			and(
				eq(organizationMembers.organizationId, organizationId),
				eq(organizationMembers.email, email.toLowerCase()),
			),
		)
		.limit(1);
	const existing = existingRows[0];
	if (existing) {
		if (existing.status === "active") {
			throw new Error(`User ${email} is already a member of this organization`);
		}
		// Re-send invite for deactivated/invited users
		// Update descopeUserId if we now have it
		return updateMember(db, existing.id, {
			status: "invited",
			role,
			invitedAt: now,
			invitedBy,
			...(descopeUserId && { descopeUserId }),
		});
	}

	await db.insert(organizationMembers).values({
		id,
		organizationId,
		// `descope_user_id` is still NOT NULL and unique per organization while
		// the invitation is pending. An empty string made every pending invite
		// claim the same identity, so the second invite failed with a D1 unique
		// constraint before its email could be sent. Keep the pre-acceptance
		// placeholder unique and replace it with the verified Descope subject in
		// `acceptInvite`.
		descopeUserId: descopeUserId || `pending:${id}`,
		email: email.toLowerCase(),
		role,
		status: "invited",
		invitedAt: now,
		invitedBy,
		createdAt: now,
		updatedAt: now,
	});

	const created = await getMemberById(db, id);
	if (!created) {
		throw new Error(`Failed to invite member: ${id}`);
	}
	return created;
}

/**
 * Accept an invitation
 * Links the Descope user ID and activates membership
 *
 * @param db - Database client
 * @param memberId - Member ID
 * @param descopeUserId - Descope user ID of accepting user
 * @param userInfo - Additional user info to denormalize
 */
export async function acceptInvite(
	db: DbClient,
	memberId: string,
	descopeUserId: string,
	userInfo?: { name?: string; avatarUrl?: string },
): Promise<OrganizationMember> {
	const now = new Date().toISOString();

	await db
		.update(organizationMembers)
		.set({
			descopeUserId,
			status: "active",
			inviteAcceptedAt: now,
			lastActiveAt: now,
			...(userInfo?.name && { name: userInfo.name }),
			...(userInfo?.avatarUrl && { avatarUrl: userInfo.avatarUrl }),
			updatedAt: now,
		})
		.where(eq(organizationMembers.id, memberId));

	const updated = await getMemberById(db, memberId);
	if (!updated) {
		throw new Error(`Member not found: ${memberId}`);
	}
	return updated;
}

/**
 * Update a member
 *
 * @param db - Database client
 * @param id - Member ID
 * @param data - Fields to update
 */
export async function updateMember(
	db: DbClient,
	id: string,
	data: Partial<Omit<NewOrganizationMember, "id" | "createdAt">>,
): Promise<OrganizationMember> {
	const now = new Date().toISOString();

	await db
		.update(organizationMembers)
		.set({
			...data,
			...(data.email && { email: data.email.toLowerCase() }),
			updatedAt: now,
		})
		.where(eq(organizationMembers.id, id));

	const updated = await getMemberById(db, id);
	if (!updated) {
		throw new Error(`Member not found: ${id}`);
	}
	return updated;
}

/**
 * Update member role
 *
 * @param db - Database client
 * @param id - Member ID
 * @param role - New role
 */
export async function updateMemberRole(
	db: DbClient,
	id: string,
	role: MemberRole,
): Promise<OrganizationMember> {
	return updateMember(db, id, { role });
}

/**
 * Replace a member's additive permission overrides.
 *
 * Stores the canonical vocabulary (`OrganizationPermission[]`), which is what
 * the column has always been typed as. Persistence does not police the values:
 * the API bounds them to `TENANT_GRANTABLE_PERMISSIONS` on write AND filters
 * them again on read, so a row written by any other path cannot become
 * authority.
 *
 * @param db - Database client
 * @param id - Member ID
 * @param permissions - Complete desired override list; empty clears them
 */
export async function setMemberPermissions(
	db: DbClient,
	id: string,
	permissions: OrganizationPermission[],
): Promise<OrganizationMember> {
	return updateMember(db, id, {
		customPermissions: permissions.length > 0 ? permissions : null,
	});
}

/**
 * Remove a member (hard delete)
 * Use deactivateMember for soft-delete
 *
 * @param db - Database client
 * @param id - Member ID
 */
export async function removeMember(db: DbClient, id: string): Promise<void> {
	await db.delete(organizationMembers).where(eq(organizationMembers.id, id));
}
