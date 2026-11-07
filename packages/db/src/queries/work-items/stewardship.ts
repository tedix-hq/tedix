import { WorkStewardshipPolicySchema } from "@tedix/api-contract/schemas/work-stewardship";
import { and, eq, isNull } from "drizzle-orm";
import type { DbQueryClient } from "../../query-client";
import { organizations } from "../../schema/organizations";
import { projects } from "../../schema/projects";
import { tedis } from "../../schema/tedis";
import { workItems } from "../../schema/work-items";
import type { CreateWorkItemParams } from "./crud";

/** Defaults confer stewardship only; admission and acceptance remain separate. */
export async function resolveWorkItemSteward(
	db: DbQueryClient,
	params: Pick<
		CreateWorkItemParams,
		| "orgId"
		| "projectId"
		| "workKind"
		| "accountableOwnerType"
		| "accountableOwnerId"
		| "stewardType"
		| "stewardId"
		| "metadata"
	>,
): Promise<{ stewardType?: "tedi"; stewardId?: string }> {
	if (
		params.accountableOwnerType ||
		params.accountableOwnerId ||
		params.stewardType ||
		params.stewardId ||
		params.metadata?.executor === "human"
	)
		return {};
	const [organization] = await db
		.select({ metadata: organizations.metadata })
		.from(organizations)
		.where(eq(organizations.id, params.orgId))
		.limit(1);
	const parsed = WorkStewardshipPolicySchema.safeParse(
		organization?.metadata?.workStewardship,
	);
	if (!parsed.success || !parsed.data?.enabled) return {};
	const policy = parsed.data;
	const [project] = params.projectId
		? await db
				.select({ leadTediId: projects.leadTediId })
				.from(projects)
				.where(
					and(
						eq(projects.orgId, params.orgId),
						eq(projects.id, params.projectId),
					),
				)
				.limit(1)
		: [];
	// An unknown/cross-tenant project must not acquire an unrelated default.
	if (params.projectId && !project) return {};
	const candidate =
		(params.projectId && policy.projectStewards[params.projectId]) ||
		(policy.useProjectLead && project?.leadTediId) ||
		policy.workKindStewards[params.workKind ?? "other"] ||
		policy.defaultTediId;
	if (!candidate) return {};
	const [tedi] = await db
		.select({ id: tedis.id })
		.from(tedis)
		.where(
			and(
				eq(tedis.id, candidate),
				eq(tedis.organizationId, params.orgId),
				eq(tedis.status, "active"),
				isNull(tedis.retiredAt),
			),
		)
		.limit(1);
	return tedi ? { stewardType: "tedi", stewardId: tedi.id } : {};
}

/**
 * The organization's designated steward tedi for an ask: the project's
 * steward, the project lead when the policy uses leads, else the policy's
 * default tedi. Only an active, unretired tedi in the organization qualifies.
 */
export async function resolveDecisionSteward(
	db: DbQueryClient,
	params: {
		orgId: string;
		projectId?: string | null;
		workItemId?: string | null;
	},
): Promise<{ id: string; slug: string; name: string } | null> {
	const [organization] = await db
		.select({ metadata: organizations.metadata })
		.from(organizations)
		.where(eq(organizations.id, params.orgId))
		.limit(1);
	const policy = WorkStewardshipPolicySchema.safeParse(
		organization?.metadata?.workStewardship,
	).data;
	if (!policy) return null;
	const [work] =
		!params.projectId && params.workItemId
			? await db
					.select({ projectId: workItems.projectId })
					.from(workItems)
					.where(
						and(
							eq(workItems.orgId, params.orgId),
							eq(workItems.id, params.workItemId),
						),
					)
					.limit(1)
			: [];
	const projectId = params.projectId ?? work?.projectId ?? null;
	const [project] = projectId
		? await db
				.select({ leadTediId: projects.leadTediId })
				.from(projects)
				.where(
					and(eq(projects.orgId, params.orgId), eq(projects.id, projectId)),
				)
				.limit(1)
		: [];
	const candidates = [
		projectId ? policy.projectStewards[projectId] : undefined,
		policy.useProjectLead ? project?.leadTediId : undefined,
		policy.defaultTediId,
	].filter((id): id is string => Boolean(id));
	for (const candidate of candidates) {
		const [tedi] = await db
			.select({
				id: tedis.id,
				slug: tedis.slug,
				name: tedis.name,
				displayName: tedis.displayName,
			})
			.from(tedis)
			.where(
				and(
					eq(tedis.id, candidate),
					eq(tedis.organizationId, params.orgId),
					eq(tedis.status, "active"),
					isNull(tedis.retiredAt),
				),
			)
			.limit(1);
		if (tedi)
			return {
				id: tedi.id,
				slug: tedi.slug,
				name: tedi.displayName ?? tedi.name,
			};
	}
	return null;
}
