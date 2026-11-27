import { coreTable } from "../core-store/client";
import { coreStore, jsonParameter } from "../core-store/dialect";
import { getD1BindingKey } from "../slow-query";
import { and, eq, desc, sql } from "drizzle-orm";
import { createDbQueryClient, type DbQueryClient } from "../query-client";
import {
	organizationResidencyPolicies as schemaOrganizationResidencyPolicies,
	residencyProviderVersions as schemaResidencyProviderVersions,
	residencyExecutionReceipts as schemaResidencyExecutionReceipts,
} from "../schema/data-residency";
import { auditWriteTable } from "./audit-delivery";
import {
	ResidencyProviderSchema,
	type ResidencyProvider,
} from "@tedix/api-contract/schemas/data-residency";

type ResidencyPolicyRow =
	typeof schemaOrganizationResidencyPolicies.$inferSelect;
const policySnapshots = new WeakMap<
	object,
	Map<string, { expiresAt: number; row: Promise<ResidencyPolicyRow | null> }>
>();

export async function getOrganizationResidencyPolicy(
	db: DbQueryClient | D1Database,
	organizationId: string,
) {
	const query = "prepare" in db ? createDbQueryClient(db) : db;
	const organizationResidencyPolicies = coreTable(
		query,
		schemaOrganizationResidencyPolicies,
	);
	const key = getD1BindingKey(query.$client);
	let policies = policySnapshots.get(key);
	if (!policies) {
		policies = new Map();
		policySnapshots.set(key, policies);
	}
	let snapshot = policies.get(organizationId);
	if (!snapshot || snapshot.expiresAt <= Date.now()) {
		snapshot = {
			expiresAt: Date.now() + 60_000,
			row: query
				.select()
				.from(organizationResidencyPolicies)
				.where(eq(organizationResidencyPolicies.organizationId, organizationId))
				.limit(1)
				.then((rows) => rows[0] ?? null),
		};
		policies.set(organizationId, snapshot);
	}
	try {
		return await snapshot.row;
	} catch (error) {
		if (policies.get(organizationId) === snapshot)
			policies.delete(organizationId);
		throw error;
	}
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
	const organizationResidencyPolicies = coreTable(
		db,
		schemaOrganizationResidencyPolicies,
	);
	const { organizationId, mode, expectedRevision, actorId, now } = input;
	const values = {
		organizationId,
		mode,
		revision: expectedRevision + 1,
		updatedAt: now,
		updatedBy: actorId,
	};
	// Revision 0 creates the row; any other revision only advances an existing
	// row that still holds the expected revision.
	const update =
		expectedRevision === 0
			? db
					.insert(organizationResidencyPolicies)
					.values(values)
					.onConflictDoUpdate({
						target: organizationResidencyPolicies.organizationId,
						set: {
							mode: sql`excluded.mode`,
							revision: sql`excluded.revision`,
							updatedAt: sql`excluded.updated_at`,
							updatedBy: sql`excluded.updated_by`,
						},
						setWhere: eq(
							organizationResidencyPolicies.revision,
							expectedRevision,
						),
					})
					.returning({ revision: organizationResidencyPolicies.revision })
			: db
					.update(organizationResidencyPolicies)
					.set(values)
					.where(
						and(
							eq(organizationResidencyPolicies.organizationId, organizationId),
							eq(organizationResidencyPolicies.revision, expectedRevision),
						),
					)
					.returning({ revision: organizationResidencyPolicies.revision });
	if (coreStore(db) === "postgres") {
		const changed = db
			.$with("changed", { revision: organizationResidencyPolicies.revision })
			.as(update.getSQL());
		const auditTable = auditWriteTable(db);
		const audited = db.$with("audited", { id: auditTable.id }).as(
			db
				.insert(auditTable)
				.select(
					db
						.select({
							id: sql<string>`${crypto.randomUUID()}`.as("id"),
							organizationId: sql<string>`${organizationId}`.as(
								"organization_id",
							),
							actorId: sql<string>`${actorId}`.as("actor_id"),
							actorType: sql<string>`'user'`.as("actor_type"),
							action: sql<string>`'organization.residency.updated'`.as(
								"action",
							),
							resourceType: sql<string>`'organization'`.as("resource_type"),
							resourceId: sql<string>`${organizationId}`.as("resource_id"),
							metadata: jsonParameter(db, {
								mode,
								revision: expectedRevision + 1,
							}).as("metadata"),
							timestamp:
								sql<Date>`to_timestamp(${Math.floor(Date.parse(now) / 1000)})`.as(
									"timestamp",
								),
						})
						.from(changed),
				)
				.returning({ id: auditTable.id })
				.getSQL(),
		);
		const rows = await db
			.with(changed, audited)
			.select({ revision: changed.revision })
			.from(changed);
		if (rows.length !== 1)
			throw new Error("Residency policy revision conflict");
		policySnapshots.get(getD1BindingKey(db.$client))?.delete(organizationId);
		return {
			mode,
			revision: expectedRevision + 1,
			updatedAt: now,
			updatedBy: actorId,
		};
	}

	// The policy row exists whenever the upsert changed it, so it doubles as the
	// one-row source for an audit insert gated on changes().
	const audit = db.insert(auditWriteTable(db)).select(
		db
			.select({
				id: sql<string>`${crypto.randomUUID()}`.as("id"),
				organizationId: organizationResidencyPolicies.organizationId,
				actorId: sql<string>`${actorId}`.as("actor_id"),
				actorType: sql<string>`'user'`.as("actor_type"),
				action: sql<string>`'organization.residency.updated'`.as("action"),
				resourceType: sql<string>`'organization'`.as("resource_type"),
				resourceId: sql<string>`${organizationId}`.as("resource_id"),
				metadata:
					sql<string>`${JSON.stringify({ mode, revision: expectedRevision + 1 })}`.as(
						"metadata",
					),
				timestamp: sql<number>`${Math.floor(Date.parse(now) / 1000)}`.as(
					"timestamp",
				),
			})
			.from(organizationResidencyPolicies)
			.where(
				and(
					eq(organizationResidencyPolicies.organizationId, organizationId),
					sql`changes() > 0`,
				),
			),
	);
	const [result] = await db.batch([update, audit]);
	if (result.length !== 1)
		throw new Error("Residency policy revision conflict");
	policySnapshots.get(getD1BindingKey(db.$client))?.delete(organizationId);
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
	const residencyProviderVersions = coreTable(
		db,
		schemaResidencyProviderVersions,
	);
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
	const residencyProviderVersions = coreTable(
		db,
		schemaResidencyProviderVersions,
	);
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
	receipt: typeof schemaResidencyExecutionReceipts.$inferInsert,
) {
	const residencyExecutionReceipts = coreTable(
		db,
		schemaResidencyExecutionReceipts,
	);
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
