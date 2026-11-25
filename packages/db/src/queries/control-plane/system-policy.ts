import { memoizeD1InvocationRead } from "../../slow-query";
import { and, desc, eq, isNull } from "drizzle-orm";
import type { DbQueryClient } from "../../query-client";
import { policyPacks } from "../../schema/control-plane";

/** Read an ownerless platform publication; tenant-owned and revoked heads grant nothing. */
export async function getActiveSystemPolicyDefinition(
	db: DbQueryClient,
	slug: string,
) {
	return (await getActiveSystemPolicy(db, slug))?.definition ?? null;
}

/** Ownerless system heads share a snapshot only within the current invocation. */
export async function getActiveSystemPolicy(db: DbQueryClient, slug: string) {
	const allRows = await memoizeD1InvocationRead(
		"system-policy",
		db.$client,
		() =>
			db
				.select({
					slug: policyPacks.slug,
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
					),
				)
				.orderBy(desc(policyPacks.version))
				.then((rows) => rows),
	);
	const rows = allRows.filter((row) => row.slug === slug).slice(0, 2);
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
	return { version: head.version, definition: head.definition };
}
