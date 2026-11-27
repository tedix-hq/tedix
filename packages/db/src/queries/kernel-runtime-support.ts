import type { JsonValue } from "@tedix/api-contract/schemas/common";
import { and, desc, eq, isNotNull, isNull } from "drizzle-orm";
import type { DbClient } from "../client";
import type { DbQueryClient } from "../query-client";
import { coreTable } from "../core-store/client";
import { policyPacks as d1PolicyPacks } from "../schema/control-plane";
import { type Tedi, tedis as d1Tedis } from "../schema/tedis";
import { workItemComments as d1WorkItemComments } from "../schema/work-items";

/** Organization authority must never fall back to a platform default. */
export async function getActiveOrganizationPolicyPack(
	db: DbQueryClient,
	organizationId: string,
) {
	const policyPacks = coreTable(db, d1PolicyPacks);
	return (
		await db
			.select()
			.from(policyPacks)
			.where(
				and(
					eq(policyPacks.organizationId, organizationId),
					eq(policyPacks.status, "active"),
				),
			)
			.orderBy(desc(policyPacks.version))
			.limit(1)
	)[0];
}

export async function getActivePolicyPackDefinition(
	db: DbClient,
	organizationId: string,
): Promise<Record<string, unknown> | null | undefined> {
	const policyPacks = coreTable(db, d1PolicyPacks);
	const [organizationRow] = await db
		.select({
			definition: policyPacks.definition,
			id: policyPacks.id,
			version: policyPacks.version,
		})
		.from(policyPacks)
		.where(
			and(
				eq(policyPacks.organizationId, organizationId),
				eq(policyPacks.status, "active"),
			),
		)
		.orderBy(desc(policyPacks.version))
		.limit(1);
	if (organizationRow) {
		const definition = { ...organizationRow.definition };
		for (const key of ["governancePolicy", "gatingPolicy"]) {
			const raw = definition[key];
			if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
			const layer = { ...raw } as Record<string, JsonValue>;
			if (layer.autonomy && typeof layer.autonomy === "object")
				layer.autonomy = {
					...layer.autonomy,
					policyPack: {
						id: organizationRow.id,
						version: organizationRow.version,
					},
				};
			definition[key] = layer;
		}
		return definition;
	}

	// Fresh organizations intentionally start without a private policy pack.
	// Home must still inherit the published platform default, matching the
	// system-default pack assigned to their first tedi. Tenant-owned policy
	// remains authoritative whenever one exists.
	const [systemRow] = await db
		.select({ definition: policyPacks.definition })
		.from(policyPacks)
		.where(
			and(
				isNull(policyPacks.organizationId),
				eq(policyPacks.scope, "system"),
				eq(policyPacks.slug, "system-default"),
				eq(policyPacks.status, "active"),
				isNotNull(policyPacks.publishedAt),
			),
		)
		.orderBy(desc(policyPacks.version))
		.limit(1);
	if (!systemRow?.definition) return systemRow?.definition;
	const definition = { ...systemRow.definition };
	// Platform defaults cannot grant organization-owned autonomous execution.
	for (const key of ["governancePolicy", "gatingPolicy"]) {
		const raw = definition[key];
		if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
		const layer = { ...raw } as Record<string, JsonValue>;
		delete layer.autonomy;
		definition[key] = layer;
	}
	return definition;
}

export async function getOrganizationTedi(
	db: DbClient,
	input: { id: string; organizationId: string },
): Promise<Tedi | undefined> {
	const tedis = coreTable(db, d1Tedis);
	const [row] = await db
		.select()
		.from(tedis)
		.where(
			and(
				eq(tedis.id, input.id),
				eq(tedis.organizationId, input.organizationId),
			),
		)
		.limit(1);
	return row;
}

export async function insertWorkItemCommentIfAbsent(
	db: DbClient,
	input: typeof d1WorkItemComments.$inferInsert,
): Promise<boolean> {
	const workItemComments = coreTable(db, d1WorkItemComments);
	const rows = await db
		.insert(workItemComments)
		.values(input)
		.onConflictDoNothing({ target: workItemComments.id })
		.returning({ id: workItemComments.id });
	return rows.length > 0;
}
