import { and, eq, isNull, sql } from "drizzle-orm";
import type { DbClient } from "../../client";
import { auditEvents } from "../../schema/audit-events";
import { billingAccounts } from "../../schema/billing";
import {
	DEFAULT_ORGANIZATION_FEATURES_BY_PLAN,
	organizations,
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
	const [receipt] = await db
		.select()
		.from(auditEvents)
		.where(eq(auditEvents.id, auditId))
		.limit(1);
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
	if (plan.overageUnitPriceMicros !== 0 || plan.metadata.monetaryInference)
		throw new Error("Internal assignment requires a zero-priced overage plan");
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
	const noReservations = sql`NOT EXISTS (SELECT 1 FROM billing_usage_reservations WHERE organization_id = ${input.organizationId} AND status = 'reserved' AND expires_at > ${now})`;
	const accountFence = and(
		eq(
			billingAccounts.entitlementVersion,
			current?.account.entitlementVersion ?? 0,
		),
		isNull(billingAccounts.stripeCustomerId),
		isNull(billingAccounts.stripeSubscriptionId),
		noReservations,
	);
	const assigned = sql`EXISTS (SELECT 1 FROM billing_accounts WHERE organization_id = ${input.organizationId} AND json_extract(metadata, '$.internalPlanAssignment.request') = ${request} AND entitlement_version = ${(current?.account.entitlementVersion ?? 0) + 1})`;
	// Each dependent write shares the successful account CAS inside D1's atomic batch.
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
				features: sql`json_patch(${JSON.stringify(DEFAULT_ORGANIZATION_FEATURES_BY_PLAN[input.planKey])}, CASE json_type(${organizations.features}, '$.os') WHEN 'true' THEN '{"os":true}' WHEN 'false' THEN '{"os":false}' ELSE '{}' END)`,
				updatedAt: now,
			})
			.where(and(eq(organizations.id, input.organizationId), assigned)),
		db
			.insert(auditEvents)
			.select(
				sql`SELECT ${auditId}, ${input.organizationId}, ${actor.id}, ${actor.type}, 'billing.internal_plan_assigned', 'billing_account', ${input.organizationId}, ${JSON.stringify({ request, planVersionId: plan.id, previousPlanVersionId: current?.plan.id ?? null, actor, reason: input.reason })}, NULL, NULL, ${Math.floor(Date.parse(now) / 1000)} WHERE ${assigned}`,
			)
			.onConflictDoNothing(),
	]);
	const [saved] = await db
		.select({ metadata: auditEvents.metadata })
		.from(auditEvents)
		.where(eq(auditEvents.id, auditId));
	if (!saved)
		throw new Error(
			"Billing entitlement changed or has in-flight reservations; re-read before assignment",
		);
	if (saved.metadata?.request !== request)
		throw new Error("Plan assignment key reused with different input");
	return { alreadyAssigned: false };
}
