import { and, desc, eq, isNull } from "drizzle-orm";
import type { DbQueryClient } from "../../query-client";
import { policyPacks } from "../../schema/control-plane";

/** Read an ownerless platform publication; tenant-owned and revoked heads grant nothing. */
export async function getActiveSystemPolicyDefinition(
	db: DbQueryClient,
	slug: string,
) {
	const rows = await db
		.select({
			version: policyPacks.version,
			target: policyPacks.target,
			status: policyPacks.status,
			publishedAt: policyPacks.publishedAt,
			publishedBy: policyPacks.publishedBy,
			definition: policyPacks.definition,
		})
		.from(policyPacks)
		.where(
			and(
				eq(policyPacks.scope, "system"),
				isNull(policyPacks.organizationId),
				eq(policyPacks.slug, slug),
			),
		)
		.orderBy(desc(policyPacks.version))
		.limit(2);
	const head = rows[0];
	if (
		!head ||
		rows[1]?.version === head.version ||
		head.target !== "shared" ||
		head.status !== "active" ||
		!head.publishedAt ||
		!Number.isFinite(Date.parse(head.publishedAt)) ||
		!head.publishedBy?.trim()
	)
		return null;
	return head.definition;
}
