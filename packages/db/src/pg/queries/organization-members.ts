import { apps } from "../schema/apps";
import { tedis } from "../schema/tedis";
import { normalizeStoredJsonText } from "../../utils/json";
import { and, desc, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import type { OrganizationPermission } from "@tedix/api-contract/schemas/user-settings";
import type { PgQueryClient } from "../query-client";
import { organizationMembers, organizations } from "../schema/organizations";
import type {
	MemberRole,
	MemberStatus,
	OrganizationMember,
	NewOrganizationMember,
} from "../../schema/organization-members";
import { chunkForBoundParams } from "../../utils/batch";
import { isOrganizationOffboarding } from "../../utils/organizations";

export async function getMemberById(
	db: PgQueryClient,
	id: string,
): Promise<OrganizationMember | undefined> {
	const [row] = await db
		.select()
		.from(organizationMembers)
		.where(and(eq(organizationMembers.id, id)))
		.limit(1);
	return row;
}

export async function getMemberByIdForOrganization(
	db: PgQueryClient,
	input: { organizationId: string; memberId: string },
): Promise<OrganizationMember | undefined> {
	const [row] = await db
		.select()
		.from(organizationMembers)
		.where(
			and(
				eq(organizationMembers.id, input.memberId),
				eq(organizationMembers.organizationId, input.organizationId),
			),
		)
		.limit(1);
	return row;
}

export async function getMemberByUserId(
	db: PgQueryClient,
	organizationId: string,
	descopeUserId: string,
): Promise<OrganizationMember | undefined> {
	const [row] = await db
		.select()
		.from(organizationMembers)
		.where(
			and(
				eq(organizationMembers.organizationId, organizationId),
				eq(organizationMembers.descopeUserId, descopeUserId),
			),
		)
		.limit(1);
	return row;
}

export async function getMemberAccessByUserId(
	db: PgQueryClient,
	organizationId: string,
	descopeUserId: string,
) {
	const rows = await db
		.select({
			role: organizationMembers.role,
			status: organizationMembers.status,
		})
		.from(organizationMembers)
		.where(
			and(
				eq(organizationMembers.organizationId, organizationId),
				eq(organizationMembers.descopeUserId, descopeUserId),
			),
		)
		.limit(1);
	return rows[0];
}

export async function getActiveMemberByEmail(
	db: PgQueryClient,
	organizationId: string,
	email: string,
): Promise<OrganizationMember | undefined> {
	const [row] = await db
		.select()
		.from(organizationMembers)
		.where(
			and(
				eq(organizationMembers.organizationId, organizationId),
				eq(organizationMembers.email, email.trim().toLowerCase()),
				eq(organizationMembers.status, "active"),
			),
		)
		.limit(1);
	return row;
}

export async function getMembershipsByDescopeTenants(
	db: PgQueryClient,
	descopeTenantIds: string[],
	descopeUserId: string,
): Promise<
	Array<{
		organizationId: string;
		descopeTenantId: string;
		status: OrganizationMember["status"];
		inboundClientPolicyJson: string | null;
	}>
> {
	const tenantIds = [...new Set(descopeTenantIds)];
	if (tenantIds.length === 0) return [];
	const rows: Array<{
		organizationId: string;
		descopeTenantId: string | null;
		status: OrganizationMember["status"];
		inboundClientPolicyJson: string | null;
	}> = [];
	for (const chunk of chunkForBoundParams(tenantIds, 50)) {
		rows.push(
			...(await db
				.select({
					organizationId: organizations.id,
					descopeTenantId: organizations.descopeTenantId,
					status: organizationMembers.status,
					inboundClientPolicyJson: sql<
						string | null
					>`(${organizations.metadata} ->> 'mcpInboundClientPolicy')`,
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
						sql`(${organizations.metadata} ->> 'retiredAt') IS NULL`,
					),
				)),
		);
	}
	return rows.flatMap(({ descopeTenantId, ...row }) =>
		descopeTenantId
			? [
					{
						...row,
						descopeTenantId,
						inboundClientPolicyJson: normalizeStoredJsonText(
							row.inboundClientPolicyJson,
						),
					},
				]
			: [],
	);
}

export async function getMemberByCanonicalUserId(
	db: PgQueryClient,
	organizationId: string,
	userId: string,
): Promise<OrganizationMember | undefined> {
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

export async function listMemberRepresentatives(
	db: PgQueryClient,
	organizationId: string,
	userIds: string[],
) {
	const rows: { userId: string | null; name: string | null; email: string }[] =
		[];
	for (const ids of chunkForBoundParams([...new Set(userIds)], 50)) {
		rows.push(
			...(await db
				.select({
					userId: organizationMembers.userId,
					name: organizationMembers.name,
					email: organizationMembers.email,
				})
				.from(organizationMembers)
				.where(
					and(
						eq(organizationMembers.organizationId, organizationId),
						eq(organizationMembers.status, "active"),
						eq(organizationMembers.kind, "human"),
						inArray(organizationMembers.userId, ids),
					),
				)),
		);
	}
	return rows;
}

export async function setMemberIdentity(
	db: PgQueryClient,
	organizationId: string,
	memberId: string,
	identity:
		| { kind: "human" }
		| {
				kind: "external_agent" | "browser_agent";
				displayName: string;
				representedUserId: string;
				/** The agent's own avatar; `undefined` leaves the stored value alone. */
				avatarUrl?: string | null;
		  },
) {
	const representedUserId =
		identity.kind !== "human" ? identity.representedUserId : null;
	return (
		await db
			.update(organizationMembers)
			.set({
				kind: identity.kind,
				representedUserId,
				...(identity.kind !== "human"
					? {
							name: identity.displayName,
							...(identity.avatarUrl !== undefined
								? { avatarUrl: identity.avatarUrl }
								: {}),
						}
					: {}),
				updatedAt: new Date().toISOString(),
			})
			.where(
				and(
					eq(organizationMembers.organizationId, organizationId),
					eq(organizationMembers.id, memberId),
					eq(organizationMembers.status, "active"),
					identity.kind === "browser_agent"
						? and(
								isNotNull(organizationMembers.userId),
								inArray(organizationMembers.role, ["member", "viewer"]),
							)
						: undefined,
					representedUserId
						? sql`EXISTS (SELECT 1 FROM organization_members AS person WHERE person.organization_id = ${organizationId} AND person.user_id = ${representedUserId} AND person.status = 'active' AND person.kind = 'human' AND person.id <> ${memberId})`
						: undefined,
				),
			)
			.returning()
	)[0];
}

export async function suspendBrowserAgentSeat(
	db: PgQueryClient,
	input: { organizationId: string; memberId: string; actorUserId: string },
) {
	const [seat] = await db
		.update(organizationMembers)
		.set({ status: "deactivated", updatedAt: new Date().toISOString() })
		.where(
			and(
				eq(organizationMembers.organizationId, input.organizationId),
				eq(organizationMembers.id, input.memberId),
				eq(organizationMembers.kind, "browser_agent"),
				inArray(organizationMembers.role, ["member", "viewer"]),
				sql`EXISTS (SELECT 1 FROM organization_members AS actor WHERE actor.organization_id = ${input.organizationId} AND actor.user_id = ${input.actorUserId} AND actor.status = 'active' AND actor.kind = 'human' AND (actor.role IN ('owner', 'admin') OR actor.user_id = ${organizationMembers.representedUserId}))`,
			),
		)
		.returning();
	return seat;
}

export async function countActiveOwners(
	db: PgQueryClient,
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

export async function getMembersByOrganization(
	db: PgQueryClient,
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
		.orderBy(sql`${organizationMembers.createdAt} DESC NULLS LAST`)
		.limit(opts?.limit ?? 100)
		.offset(opts?.offset ?? 0);
}

export async function getUserOsMemberships(
	db: PgQueryClient,
	descopeUserId: string,
): Promise<
	Array<{
		organizationId: string;
		organizationName: string;
		organizationSlug: string;
		organizationLogoUrl: string | null;
	}>
> {
	const joined = await db
		.select({ member: organizationMembers, organization: organizations })
		.from(organizationMembers)
		.innerJoin(
			organizations,
			eq(organizationMembers.organizationId, organizations.id),
		)
		.where(
			and(
				eq(organizationMembers.descopeUserId, descopeUserId),
				eq(organizationMembers.status, "active"),
			),
		)
		.orderBy(sql`${organizationMembers.lastActiveAt} DESC NULLS LAST`);
	const rows = joined.map(({ member, organization }) => ({
		...member,
		organization,
	}));

	return rows.flatMap((row) => {
		const organization = row.organization;
		if (
			!organization ||
			isOrganizationOffboarding(organization.metadata) ||
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

export async function addMember(
	db: PgQueryClient,
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

export async function inviteMember(
	db: PgQueryClient,
	organizationId: string,
	email: string,
	role: MemberRole = "member",
	descopeUserId?: string,
	invitedBy?: string,
): Promise<OrganizationMember> {
	const id = crypto.randomUUID();
	const now = new Date().toISOString();

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

export async function acceptInvite(
	db: PgQueryClient,
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

export async function updateMember(
	db: PgQueryClient,
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

export async function updateMemberRole(
	db: PgQueryClient,
	id: string,
	role: MemberRole,
): Promise<OrganizationMember> {
	return updateMember(db, id, { role });
}

export async function setMemberPermissions(
	db: PgQueryClient,
	id: string,
	permissions: OrganizationPermission[],
): Promise<OrganizationMember> {
	return updateMember(db, id, {
		customPermissions: permissions.length > 0 ? permissions : null,
	});
}

export async function removeMember(
	db: PgQueryClient,
	id: string,
): Promise<void> {
	await db.delete(organizationMembers).where(eq(organizationMembers.id, id));
}

export async function listTedisByMemberDescopeUserIds(
	db: PgQueryClient,
	organizationId: string,
	descopeUserIds: string[],
): Promise<
	Array<{ descopeUserId: string | null; tediId: string; avatar: string | null }>
> {
	const rows: Array<{
		descopeUserId: string | null;
		tediId: string;
		avatar: string | null;
	}> = [];
	for (const ids of chunkForBoundParams([...new Set(descopeUserIds)], 50)) {
		rows.push(
			...(await db
				.select({
					descopeUserId: tedis.descopeUserId,
					tediId: tedis.id,
					avatar: tedis.avatar,
				})
				.from(tedis)
				.where(
					and(
						eq(tedis.organizationId, organizationId),
						isNull(tedis.retiredAt),
						inArray(tedis.descopeUserId, ids),
					),
				)),
		);
	}
	return rows;
}

export async function getUserOrganizationMemberships(
	db: PgQueryClient,
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
	const joined = await db
		.select({ member: organizationMembers, organization: organizations })
		.from(organizationMembers)
		.innerJoin(
			organizations,
			eq(organizationMembers.organizationId, organizations.id),
		)
		.where(
			and(
				eq(organizationMembers.descopeUserId, descopeUserId),
				opts?.activeOnly ? eq(organizationMembers.status, "active") : undefined,
			),
		)
		.orderBy(sql`${organizationMembers.lastActiveAt} DESC NULLS LAST`);
	const rows = joined.map(({ member, organization }) => ({
		...member,
		organization,
	}));
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

	// Skip members whose organization no longer exists or is being offboarded
	// (cancelled or retired), then map to the return shape.
	const results = [];
	for (const row of rows) {
		const { organization, ...member } = row;
		if (!organization || isOrganizationOffboarding(organization.metadata))
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

export async function getOrganizationAggregatorGateways(
	db: PgQueryClient,
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
