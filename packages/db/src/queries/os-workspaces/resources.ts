import { and, asc, desc, eq, isNotNull, isNull, or, sql } from "drizzle-orm";
import type { DbQueryClient } from "../../query-client";
import { skillEntries } from "../../schema/cognitive";
import { projects } from "../../schema/projects";
import {
	type NewOsWorkspaceResourceRow,
	type OsWorkspaceResourceRow,
	osOutputRevisions,
	osOutputs,
	osWorkspaceProjects,
	osWorkspaceResources,
	osWorkspaceSkillDraftGrants,
	osWorkspaceSkillDraftProposals,
} from "../../schema/os-workspaces";

export interface OsWorkspaceSkillDraftGrantIdentity extends OsWorkspaceResourceIdentity {
	memberId: string;
}

export async function getOsWorkspaceSkillDraftGrant(
	db: DbQueryClient,
	params: OsWorkspaceSkillDraftGrantIdentity,
) {
	const [row] = await db
		.select()
		.from(osWorkspaceSkillDraftGrants)
		.where(
			and(
				eq(osWorkspaceSkillDraftGrants.organizationId, params.organizationId),
				eq(osWorkspaceSkillDraftGrants.memberId, params.memberId),
				eq(osWorkspaceSkillDraftGrants.workspaceId, params.workspaceId),
				eq(osWorkspaceSkillDraftGrants.resourceId, params.resourceId),
			),
		)
		.limit(1);
	return row;
}

export async function setOsWorkspaceSkillDraftGrant(
	db: DbQueryClient,
	grant: typeof osWorkspaceSkillDraftGrants.$inferInsert,
) {
	const [row] = await db
		.insert(osWorkspaceSkillDraftGrants)
		.values(grant)
		.onConflictDoUpdate({
			target: [
				osWorkspaceSkillDraftGrants.organizationId,
				osWorkspaceSkillDraftGrants.memberId,
				osWorkspaceSkillDraftGrants.workspaceId,
				osWorkspaceSkillDraftGrants.resourceId,
			],
			set: {
				skillId: grant.skillId,
				enabled: grant.enabled,
				expiresAt: grant.expiresAt,
				grantedBy: grant.grantedBy,
				updatedAt: grant.updatedAt,
			},
		})
		.returning();
	if (!row)
		throw new Error("Workspace skill draft grant write returned no row");
	return row;
}

export interface OsWorkspaceResourceScope {
	organizationId: string;
	workspaceId: string;
}

export async function getOsWorkspaceSkillDraftProposal(
	db: DbQueryClient,
	input: OsWorkspaceResourceIdentity & { proposalId: string },
) {
	const [row] = await db
		.select()
		.from(osWorkspaceSkillDraftProposals)
		.where(
			and(
				eq(osWorkspaceSkillDraftProposals.organizationId, input.organizationId),
				eq(osWorkspaceSkillDraftProposals.workspaceId, input.workspaceId),
				eq(osWorkspaceSkillDraftProposals.resourceId, input.resourceId),
				eq(osWorkspaceSkillDraftProposals.id, input.proposalId),
			),
		)
		.limit(1);
	return row;
}

export async function createOsWorkspaceSkillDraftProposal(
	db: DbQueryClient,
	proposal: typeof osWorkspaceSkillDraftProposals.$inferInsert,
) {
	await db
		.insert(osWorkspaceSkillDraftProposals)
		.values(proposal)
		.onConflictDoNothing({ target: osWorkspaceSkillDraftProposals.id });
	return getOsWorkspaceSkillDraftProposal(db, {
		...proposal,
		proposalId: proposal.id,
	});
}

export async function listOsWorkspaceSkillDraftProposals(
	db: DbQueryClient,
	input: OsWorkspaceResourceIdentity & { memberId?: string },
) {
	return db
		.select({
			id: osWorkspaceSkillDraftProposals.id,
			memberId: osWorkspaceSkillDraftProposals.memberId,
			sourceRevision: osWorkspaceSkillDraftProposals.sourceRevision,
			reason: osWorkspaceSkillDraftProposals.reason,
			createdAt: osWorkspaceSkillDraftProposals.createdAt,
			status: osWorkspaceSkillDraftProposals.status,
		})
		.from(osWorkspaceSkillDraftProposals)
		.where(
			and(
				eq(osWorkspaceSkillDraftProposals.organizationId, input.organizationId),
				eq(osWorkspaceSkillDraftProposals.workspaceId, input.workspaceId),
				eq(osWorkspaceSkillDraftProposals.resourceId, input.resourceId),
				input.memberId
					? eq(osWorkspaceSkillDraftProposals.memberId, input.memberId)
					: undefined,
			),
		)
		.orderBy(
			desc(osWorkspaceSkillDraftProposals.createdAt),
			desc(osWorkspaceSkillDraftProposals.id),
		)
		.limit(50);
}

export async function withdrawOsWorkspaceSkillDraftProposal(
	db: DbQueryClient,
	input: OsWorkspaceSkillDraftGrantIdentity & {
		proposalId: string;
		now: string;
	},
) {
	await db
		.update(osWorkspaceSkillDraftProposals)
		.set({ status: "withdrawn", withdrawnAt: input.now })
		.where(
			and(
				eq(osWorkspaceSkillDraftProposals.organizationId, input.organizationId),
				eq(osWorkspaceSkillDraftProposals.workspaceId, input.workspaceId),
				eq(osWorkspaceSkillDraftProposals.resourceId, input.resourceId),
				eq(osWorkspaceSkillDraftProposals.memberId, input.memberId),
				eq(osWorkspaceSkillDraftProposals.id, input.proposalId),
				eq(osWorkspaceSkillDraftProposals.status, "pending"),
			),
		);
	return getOsWorkspaceSkillDraftProposal(db, input);
}

export interface OsWorkspaceResourceIdentity extends OsWorkspaceResourceScope {
	resourceId: string;
}

export async function createOsWorkspaceResource(
	db: DbQueryClient,
	resource: NewOsWorkspaceResourceRow,
): Promise<OsWorkspaceResourceRow> {
	const [row] = await db
		.insert(osWorkspaceResources)
		.values(resource)
		.returning();
	if (!row) throw new Error("OS workspace resource insert returned no row");
	return row;
}

export async function getOsWorkspaceResource(
	db: DbQueryClient,
	params: OsWorkspaceResourceIdentity,
): Promise<OsWorkspaceResourceRow | undefined> {
	const [row] = await db
		.select()
		.from(osWorkspaceResources)
		.where(
			and(
				eq(osWorkspaceResources.organizationId, params.organizationId),
				eq(osWorkspaceResources.workspaceId, params.workspaceId),
				eq(osWorkspaceResources.id, params.resourceId),
			),
		)
		.limit(1);
	return row;
}

export async function listOsWorkspaceResources(
	db: DbQueryClient,
	params: OsWorkspaceResourceScope & {
		status?: OsWorkspaceResourceRow["status"];
		limit?: number;
	},
): Promise<OsWorkspaceResourceRow[]> {
	const conditions = [
		eq(osWorkspaceResources.organizationId, params.organizationId),
		eq(osWorkspaceResources.workspaceId, params.workspaceId),
	];
	if (params.status) {
		conditions.push(eq(osWorkspaceResources.status, params.status));
	}
	return db
		.select()
		.from(osWorkspaceResources)
		.where(and(...conditions))
		.orderBy(asc(osWorkspaceResources.name), asc(osWorkspaceResources.id))
		.limit(Math.min(Math.max(params.limit ?? 100, 1), 500));
}

/**
 * Workspaces a skill runs for: the ids of workspaces holding an active
 * `tedix`/`skill` resource whose provider object is this skill.
 */
export async function listOsWorkspaceIdsLinkingSkill(
	db: DbQueryClient,
	params: { organizationId: string; skillId: string },
): Promise<string[]> {
	const rows = await db
		.select({ workspaceId: osWorkspaceResources.workspaceId })
		.from(osWorkspaceResources)
		.where(
			and(
				eq(osWorkspaceResources.organizationId, params.organizationId),
				eq(osWorkspaceResources.providerId, "tedix"),
				eq(osWorkspaceResources.connectionScope, "tenant"),
				eq(osWorkspaceResources.resourceType, "skill"),
				eq(osWorkspaceResources.providerResourceId, params.skillId),
				eq(osWorkspaceResources.status, "active"),
			),
		)
		.limit(20);
	return [...new Set(rows.map((row) => row.workspaceId))];
}

export async function updateOsWorkspaceResourceMetadata(
	db: DbQueryClient,
	params: OsWorkspaceResourceIdentity & {
		metadata: string;
		expectedUpdatedAt: string;
		now: string;
	},
): Promise<OsWorkspaceResourceRow | undefined> {
	const [row] = await db
		.update(osWorkspaceResources)
		.set({ metadata: params.metadata, updatedAt: params.now })
		.where(
			and(
				eq(osWorkspaceResources.organizationId, params.organizationId),
				eq(osWorkspaceResources.workspaceId, params.workspaceId),
				eq(osWorkspaceResources.id, params.resourceId),
				eq(osWorkspaceResources.updatedAt, params.expectedUpdatedAt),
			),
		)
		.returning();
	return row;
}

export async function renameOsWorkspaceResource(
	db: DbQueryClient,
	params: OsWorkspaceResourceIdentity & {
		name: string;
		expectedUpdatedAt: string;
		now: string;
	},
): Promise<OsWorkspaceResourceRow | undefined> {
	const [row] = await db
		.update(osWorkspaceResources)
		.set({ name: params.name, updatedAt: params.now })
		.where(
			and(
				eq(osWorkspaceResources.organizationId, params.organizationId),
				eq(osWorkspaceResources.workspaceId, params.workspaceId),
				eq(osWorkspaceResources.id, params.resourceId),
				eq(osWorkspaceResources.status, "active"),
				eq(osWorkspaceResources.updatedAt, params.expectedUpdatedAt),
			),
		)
		.returning();
	return row;
}

/** Change only the credential requirement for one active, exact provider object. */
export async function rebindOsWorkspaceResource(
	db: DbQueryClient,
	params: OsWorkspaceResourceIdentity & {
		connectionScope: OsWorkspaceResourceRow["connectionScope"];
		personalOwnerUserId?: string | null;
		connectionInstanceId?: string | null;
		providerAccess?: { canRead: boolean; canWrite: boolean } | null;
		requiredScopes?: string;
		expectedUpdatedAt: string;
		now: string;
	},
): Promise<OsWorkspaceResourceRow | undefined> {
	const [row] = await db
		.update(osWorkspaceResources)
		.set({
			connectionScope: params.connectionScope,
			personalOwnerUserId: params.personalOwnerUserId ?? null,
			connectionInstanceId: params.connectionInstanceId ?? null,
			providerAccess: params.providerAccess ?? null,
			...(params.requiredScopes === undefined
				? {}
				: { requiredScopes: params.requiredScopes }),
			updatedAt: params.now,
		})
		.where(
			and(
				eq(osWorkspaceResources.organizationId, params.organizationId),
				eq(osWorkspaceResources.workspaceId, params.workspaceId),
				eq(osWorkspaceResources.id, params.resourceId),
				eq(osWorkspaceResources.status, "active"),
				eq(osWorkspaceResources.updatedAt, params.expectedUpdatedAt),
			),
		)
		.returning();
	return row;
}

export async function removeOsWorkspaceResource(
	db: DbQueryClient,
	params: OsWorkspaceResourceIdentity & {
		expectedUpdatedAt: string;
		now: string;
	},
): Promise<OsWorkspaceResourceRow | undefined> {
	const [row] = await db
		.update(osWorkspaceResources)
		.set({ status: "removed", removedAt: params.now, updatedAt: params.now })
		.where(
			and(
				eq(osWorkspaceResources.organizationId, params.organizationId),
				eq(osWorkspaceResources.workspaceId, params.workspaceId),
				eq(osWorkspaceResources.id, params.resourceId),
				eq(osWorkspaceResources.status, "active"),
				eq(osWorkspaceResources.updatedAt, params.expectedUpdatedAt),
			),
		)
		.returning();
	return row;
}

/** The organization-scoped reference to one provider object in a Workspace, in any status. */
export async function findOsWorkspaceTenantResource(
	db: DbQueryClient,
	params: OsWorkspaceResourceScope & {
		providerId: string;
		resourceType: string;
		providerResourceId: string;
	},
): Promise<OsWorkspaceResourceRow | undefined> {
	const [row] = await db
		.select()
		.from(osWorkspaceResources)
		.where(
			and(
				eq(osWorkspaceResources.organizationId, params.organizationId),
				eq(osWorkspaceResources.workspaceId, params.workspaceId),
				eq(osWorkspaceResources.providerId, params.providerId),
				eq(osWorkspaceResources.connectionScope, "tenant"),
				isNull(osWorkspaceResources.personalOwnerUserId),
				isNull(osWorkspaceResources.connectionInstanceId),
				eq(osWorkspaceResources.resourceType, params.resourceType),
				eq(osWorkspaceResources.providerResourceId, params.providerResourceId),
			),
		)
		.limit(1);
	return row;
}

/** Make a removed reference active again, keeping its id, name and metadata. */
export async function restoreOsWorkspaceResource(
	db: DbQueryClient,
	params: OsWorkspaceResourceIdentity & { now: string },
): Promise<OsWorkspaceResourceRow | undefined> {
	const [row] = await db
		.update(osWorkspaceResources)
		.set({ status: "active", removedAt: null, updatedAt: params.now })
		.where(
			and(
				eq(osWorkspaceResources.organizationId, params.organizationId),
				eq(osWorkspaceResources.workspaceId, params.workspaceId),
				eq(osWorkspaceResources.id, params.resourceId),
				eq(osWorkspaceResources.status, "removed"),
			),
		)
		.returning();
	return row;
}

/** Why a skill belongs to a Workspace even though no link says so yet. */
export type OsWorkspaceSkillLinkReason = "factory_project" | "wrote_outputs";

export interface OsWorkspaceSkillLinkCandidate {
	skillId: string;
	title: string;
	reason: OsWorkspaceSkillLinkReason;
}

const factorySkillId = sql<
	string | null
>`json_extract(${projects.metadata}, '$.factory.skillId')`;
const factoryWorkspaceId = sql<
	string | null
>`json_extract(${projects.metadata}, '$.factory.workspaceId')`;

/**
 * The organization's skills that run a Workspace by its existing data: the
 * lane skill of a factory project bound to it (`metadata.factory.workspaceId`)
 * or linked to it as a Work project, and every skill whose runs wrote
 * revisions of the Workspace's Outputs. Each skill appears once, with the
 * first reason found; linked or not is the caller's business.
 */
export async function listOsWorkspaceSkillLinkCandidates(
	db: DbQueryClient,
	params: OsWorkspaceResourceScope,
): Promise<OsWorkspaceSkillLinkCandidate[]> {
	const linkedProjectIds = db
		.select({ projectId: osWorkspaceProjects.projectId })
		.from(osWorkspaceProjects)
		.where(
			and(
				eq(osWorkspaceProjects.organizationId, params.organizationId),
				eq(osWorkspaceProjects.workspaceId, params.workspaceId),
				eq(osWorkspaceProjects.status, "active"),
			),
		);
	const factoryRows = await db
		.select({ skillId: skillEntries.id, title: skillEntries.title })
		.from(projects)
		.innerJoin(
			skillEntries,
			and(
				eq(skillEntries.id, factorySkillId),
				eq(skillEntries.organizationId, projects.orgId),
			),
		)
		.where(
			and(
				eq(projects.orgId, params.organizationId),
				isNotNull(factorySkillId),
				or(
					eq(factoryWorkspaceId, params.workspaceId),
					sql`${projects.id} in ${linkedProjectIds}`,
				),
			),
		)
		.orderBy(asc(skillEntries.title))
		.limit(50);
	const writerRows = await db
		.selectDistinct({ skillId: skillEntries.id, title: skillEntries.title })
		.from(osOutputs)
		.innerJoin(
			osOutputRevisions,
			and(
				eq(osOutputRevisions.outputId, osOutputs.id),
				eq(osOutputRevisions.organizationId, osOutputs.organizationId),
			),
		)
		.innerJoin(
			skillEntries,
			and(
				eq(skillEntries.id, osOutputRevisions.skillId),
				eq(skillEntries.organizationId, osOutputs.organizationId),
			),
		)
		.where(
			and(
				eq(osOutputs.organizationId, params.organizationId),
				eq(osOutputs.workspaceId, params.workspaceId),
			),
		)
		.orderBy(asc(skillEntries.title))
		.limit(50);
	const seen = new Set<string>();
	const candidates: OsWorkspaceSkillLinkCandidate[] = [];
	for (const [rows, reason] of [
		[factoryRows, "factory_project"],
		[writerRows, "wrote_outputs"],
	] as const) {
		for (const row of rows) {
			if (seen.has(row.skillId)) continue;
			seen.add(row.skillId);
			candidates.push({ ...row, reason });
		}
	}
	return candidates;
}
