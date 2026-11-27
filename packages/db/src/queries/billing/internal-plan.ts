import { auditWriteTable, readAuditEventById } from "../audit-delivery";
import { and, eq, exists, isNull, sql } from "drizzle-orm";
import type { DbClient } from "../../client";
import { coreTable } from "../../core-store/client";
import {
	coreStore,
	epochTimestamp,
	jsonParameter,
	jsonRead,
} from "../../core-store/dialect";

import {
	billingAccounts as schemaBillingAccounts,
	billingUsageReservations as schemaBillingUsageReservations,
} from "../../schema/billing";
import {
	DEFAULT_ORGANIZATION_FEATURES_BY_PLAN,
	organizations as schemaOrganizations,
	type OrganizationFeaturePlanKey,
} from "../../schema/organizations";
import { getOrganizationById } from "../organizations";
import { getBillingEntitlement, requireActiveBillingPlan } from "./plans";

export async function assignInternalPlan(
	db: DbClient,
	input: {
		organizationId: string;
		planKey: OrganizationFeaturePlanKey;
		idempotencyKey: string;
		reason: string;
	},
	actor: { id: string; type: string },
	now: string,
) {
	const auditId = `internal-plan:${input.organizationId}:${input.idempotencyKey}`;
	const request = JSON.stringify(input);
	const auditEvents = auditWriteTable(db);
	const billingAccounts = coreTable(db, schemaBillingAccounts);
	const billingUsageReservations = coreTable(
		db,
		schemaBillingUsageReservations,
	);
	const receipt = await readAuditEventById(db, input.organizationId, auditId);
	if (receipt) {
		if (receipt.metadata?.request !== request)
			throw new Error("Plan assignment key reused with different input");
		return { alreadyAssigned: true };
	}
	const organization = await getOrganizationById(db, input.organizationId);
	if (!organization) throw new Error("Organization not found");
	const current = await getBillingEntitlement(db, input.organizationId);
	if (
		current &&
		(current.account.stripeCustomerId ||
			current.account.stripeSubscriptionId ||
			!["trial", "internal"].includes(current.account.billingMode))
	) {
		throw new Error("Internal assignment refuses externally billed accounts");
	}
	const plan = await requireActiveBillingPlan(db, input.planKey, now);
	const end = new Date(now);
	end.setUTCMonth(end.getUTCMonth() + 1);
	const metadata = {
		...current?.account.metadata,
		internalPlanAssignment: {
			key: input.idempotencyKey,
			request,
			actor,
			reason: input.reason,
			assignedAt: now,
		},
	};
	const noReservations = sql`NOT EXISTS (SELECT 1 FROM ${billingUsageReservations} WHERE ${billingUsageReservations.organizationId} = ${input.organizationId} AND ${billingUsageReservations.status} = 'reserved' AND ${billingUsageReservations.expiresAt} > ${now})`;
	const accountFence = and(
		eq(
			billingAccounts.entitlementVersion,
			current?.account.entitlementVersion ?? 0,
		),
		isNull(billingAccounts.stripeCustomerId),
		isNull(billingAccounts.stripeSubscriptionId),
		noReservations,
	);
	const assignedAccount = and(
		eq(billingAccounts.organizationId, input.organizationId),
		sql`${jsonRead(db, billingAccounts.metadata, ["internalPlanAssignment", "request"])} = ${request}`,
		eq(
			billingAccounts.entitlementVersion,
			(current?.account.entitlementVersion ?? 0) + 1,
		),
	);
	const assigned = exists(
		db
			.select({ one: sql`1` })
			.from(billingAccounts)
			.where(assignedAccount),
	);
	// Each dependent write shares the successful account CAS inside D1's atomic batch.
	const organizations = coreTable(db, schemaOrganizations);
	const defaults = JSON.stringify(
		DEFAULT_ORGANIZATION_FEATURES_BY_PLAN[input.planKey],
	);
	await db.batch([
		db
			.insert(billingAccounts)
			.values({
				organizationId: input.organizationId,
				planVersionId: plan.id,
				status: "active",
				billingMode: "internal",
				periodStart: now,
				periodEnd: end.toISOString(),
				metadata,
				createdAt: now,
				updatedAt: now,
			})
			.onConflictDoUpdate({
				target: billingAccounts.organizationId,
				set: {
					planVersionId: plan.id,
					status: "active",
					billingMode: "internal",
					periodStart: now,
					periodEnd: end.toISOString(),
					hardSpendLimitMicros: null,
					overageEnabled: false,
					entitlementVersion: (current?.account.entitlementVersion ?? 0) + 1,
					metadata,
					updatedAt: now,
				},
				setWhere: accountFence,
			}),
		db
			.update(organizations)
			.set({
				features:
					coreStore(db) === "postgres"
						? sql`(${defaults}::jsonb || CASE WHEN jsonb_typeof(${organizations.features} -> 'os') = 'boolean' THEN jsonb_build_object('os', ${organizations.features} -> 'os') ELSE '{}'::jsonb END)`
						: sql`json_patch(${defaults}, CASE json_type(${organizations.features}, '$.os') WHEN 'true' THEN '{"os":true}' WHEN 'false' THEN '{"os":false}' ELSE '{}' END)`,
				updatedAt: now,
			})
			.where(and(eq(organizations.id, input.organizationId), assigned)),
		db
			.insert(auditEvents)
			.select(
				// billing_accounts is keyed by organization: at most one row, only once assigned.
				db
					.select({
						id: sql<string>`${auditId}`.as("id"),
						organizationId: sql<string>`${input.organizationId}`.as(
							"organization_id",
						),
						actorId: sql<string>`${actor.id}`.as("actor_id"),
						actorType: sql<string>`${actor.type}`.as("actor_type"),
						action: sql<string>`'billing.internal_plan_assigned'`.as("action"),
						resourceType: sql<string>`'billing_account'`.as("resource_type"),
						resourceId: sql<string>`${input.organizationId}`.as("resource_id"),
						metadata:
							sql<string>`${jsonParameter(db, { request, planVersionId: plan.id, previousPlanVersionId: current?.plan.id ?? null, actor, reason: input.reason })}`.as(
								"metadata",
							),
						ipAddress: sql<null>`NULL`.as("ip_address"),
						userAgent: sql<null>`NULL`.as("user_agent"),
						timestamp: sql<number>`${epochTimestamp(db, now)}`.as("timestamp"),
					})
					.from(billingAccounts)
					.where(assignedAccount),
			)
			.onConflictDoNothing(),
	]);
	const saved = await readAuditEventById(db, input.organizationId, auditId);
	if (!saved)
		throw new Error(
			"Billing entitlement changed or has in-flight reservations; re-read before assignment",
		);
	if (saved.metadata?.request !== request)
		throw new Error("Plan assignment key reused with different input");
	return { alreadyAssigned: false };
}
