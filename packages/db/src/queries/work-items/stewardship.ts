import { WorkStewardshipPolicySchema } from "@tedix/api-contract/schemas/work-stewardship";
import { and, eq, isNull } from "drizzle-orm";
import type { DbQueryClient } from "../../query-client";
import { organizations } from "../../schema/organizations";
import { projects } from "../../schema/projects";
import { tedis } from "../../schema/tedis";
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
