import { and, eq, desc, sql } from "drizzle-orm";
import type { DbQueryClient } from "../query-client";
import {
	organizationResidencyPolicies,
	residencyProviderVersions,
	residencyExecutionReceipts,
} from "../schema/data-residency";
import { auditEvents } from "../schema/audit-events";
import {
	ResidencyProviderSchema,
	type ResidencyProvider,
} from "@tedix/api-contract/schemas/data-residency";

export async function getOrganizationResidencyPolicy(
	db: DbQueryClient,
	organizationId: string,
) {
	const [row] = await db
		.select()
		.from(organizationResidencyPolicies)
		.where(eq(organizationResidencyPolicies.organizationId, organizationId))
		.limit(1);
	return row ?? null;
}

export async function setOrganizationResidencyPolicy(
	db: DbQueryClient,
	input: {
		organizationId: string;
		mode: "unrestricted" | "eu";
		expectedRevision: number;
		actorId: string;
		now: string;
	},
) {
	const { organizationId, mode, expectedRevision, actorId, now } = input;
	const update = db.all<{
		revision: number;
	}>(sql`INSERT INTO organization_residency_policies (organization_id, mode, revision, updated_at, updated_by)
		SELECT ${organizationId}, ${mode}, ${expectedRevision + 1}, ${now}, ${actorId}
		WHERE ${expectedRevision} = 0 OR EXISTS (SELECT 1 FROM organization_residency_policies WHERE organization_id = ${organizationId})
		ON CONFLICT (organization_id) DO UPDATE SET mode = excluded.mode, revision = excluded.revision, updated_at = excluded.updated_at, updated_by = excluded.updated_by
		WHERE organization_residency_policies.revision = ${expectedRevision} RETURNING revision`);
	const audit =
		db.run(sql`INSERT INTO ${auditEvents} (id, organization_id, actor_id, actor_type, action, resource_type, resource_id, metadata, timestamp)
		SELECT ${crypto.randomUUID()}, ${organizationId}, ${actorId}, 'user', 'organization.residency.updated', 'organization', ${organizationId}, ${JSON.stringify({ mode, revision: expectedRevision + 1 })}, ${Math.floor(Date.parse(now) / 1000)} WHERE changes() > 0`);
	const [result] = await db.batch([update, audit]);
	if (result.length !== 1)
		throw new Error("Residency policy revision conflict");
	return {
		mode,
		revision: expectedRevision + 1,
		updatedAt: now,
		updatedBy: actorId,
	};
}

export async function listResidencyProviders(
	db: DbQueryClient,
): Promise<ResidencyProvider[]> {
	const rows = await db
		.select()
		.from(residencyProviderVersions)
		.orderBy(desc(residencyProviderVersions.revision));
	const latest = new Map<string, ResidencyProvider>();
	for (const row of rows) {
		if (!latest.has(row.memberKey))
			latest.set(row.memberKey, ResidencyProviderSchema.parse(row.config));
	}
	return [...latest.values()];
}

export async function publishResidencyProvider(
	db: DbQueryClient,
	member: ResidencyProvider,
	actorId: string,
	now: string,
) {
	const config = ResidencyProviderSchema.parse(member);
	await db.insert(residencyProviderVersions).values({
		id: crypto.randomUUID(),
		memberKey: config.memberKey,
		revision: config.revision,
		config,
		publishedAt: now,
		publishedBy: actorId,
	});
	return config;
}

export async function recordResidencyExecution(
	db: DbQueryClient,
	receipt: typeof residencyExecutionReceipts.$inferInsert,
) {
	const [inserted] = await db
		.insert(residencyExecutionReceipts)
		.values(receipt)
		.onConflictDoNothing()
		.returning();
	if (inserted) return;
	const [existing] = await db
		.select()
		.from(residencyExecutionReceipts)
		.where(
			and(
				eq(residencyExecutionReceipts.executionId, receipt.executionId),
				eq(residencyExecutionReceipts.organizationId, receipt.organizationId),
			),
		);
	if (
		!existing ||
		Object.entries(receipt).some(
			([key, value]) =>
				key !== "createdAt" && existing[key as keyof typeof existing] !== value,
		)
	)
		throw new Error("Residency execution receipt conflict");
}
