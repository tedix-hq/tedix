/** D1-owned effective inference-admission policies. */

import type { AiGatewayAdmissionPolicy } from "@tedix/api-contract/schemas/tedi";
import { and, eq } from "drizzle-orm";
import type { DbClient } from "../../client";
import { coreTable } from "../../core-store/client";
import {
	billingAccounts as schemaBillingAccounts,
	billingInferencePolicies as schemaBillingInferencePolicies,
} from "../../schema/billing";
import { tedis as schemaTedis } from "../../schema/tedis";

export interface EffectiveInferencePolicies {
	organization: AiGatewayAdmissionPolicy;
	tedi?: AiGatewayAdmissionPolicy;
	tediFound: boolean;
}

export interface UpsertTediInferencePolicyParams {
	organizationId: string;
	tediId: string;
	policy: AiGatewayAdmissionPolicy;
}

/** Persist the canonical admission policy corresponding to a tedi budget edit. */
export async function upsertTediInferencePolicy(
	db: DbClient,
	params: UpsertTediInferencePolicyParams,
): Promise<typeof schemaBillingInferencePolicies.$inferSelect> {
	const now = new Date().toISOString();
	const billingInferencePolicies = coreTable(
		db,
		schemaBillingInferencePolicies,
	);
	const values = {
		id: crypto.randomUUID(),
		organizationId: params.organizationId,
		scope: "tedi" as const,
		subjectKey: params.tediId,
		tediId: params.tediId,
		allowedModelTiers: params.policy.allowedModelTiers ?? null,
		createdAt: now,
		updatedAt: now,
	};

	await db
		.insert(billingInferencePolicies)
		.values(values)
		.onConflictDoUpdate({
			target: [
				billingInferencePolicies.organizationId,
				billingInferencePolicies.scope,
				billingInferencePolicies.subjectKey,
			],
			set: {
				allowedModelTiers: values.allowedModelTiers,
				updatedAt: now,
			},
		});

	const [row] = await db
		.select()
		.from(billingInferencePolicies)
		.where(
			and(
				eq(billingInferencePolicies.organizationId, params.organizationId),
				eq(billingInferencePolicies.scope, "tedi"),
				eq(billingInferencePolicies.subjectKey, params.tediId),
			),
		)
		.limit(1);
	if (!row) throw new Error("Failed to persist tedi inference policy");
	return row;
}

function policyFromRow(
	row: InferencePolicyRow | undefined,
): AiGatewayAdmissionPolicy | undefined {
	if (!row) return undefined;
	return {
		...(row.allowedModelTiers === null
			? {}
			: { allowedModelTiers: row.allowedModelTiers }),
	};
}

type InferencePolicyRow = typeof schemaBillingInferencePolicies.$inferSelect;

/** The explicit policy row for one scope, as a composable statement. */
export function inferencePolicyQuery(
	db: DbClient,
	organizationId: string,
	scope: "organization" | "tedi",
	subjectKey: string,
) {
	const billingInferencePolicies = coreTable(
		db,
		schemaBillingInferencePolicies,
	);
	return db
		.select()
		.from(billingInferencePolicies)
		.where(
			and(
				eq(billingInferencePolicies.organizationId, organizationId),
				eq(billingInferencePolicies.scope, scope),
				eq(billingInferencePolicies.subjectKey, subjectKey),
			),
		)
		.limit(1);
}

/** Does this tedi belong to this organization? One composable statement. */
export function tediOwnershipQuery(
	db: DbClient,
	organizationId: string,
	tediId: string,
) {
	const tedis = coreTable(db, schemaTedis);
	return db
		.select({ id: tedis.id })
		.from(tedis)
		.where(and(eq(tedis.id, tediId), eq(tedis.organizationId, organizationId)))
		.limit(1);
}

/** The organization-scope policy: model tiers only, no plan default. */
export function organizationInferencePolicy(
	organizationPolicy: InferencePolicyRow | undefined,
): AiGatewayAdmissionPolicy {
	return policyFromRow(organizationPolicy) ?? {};
}

/** Shape the tedi-scope policy, which has no plan default behind it. */
export function tediInferencePolicy(
	tediPolicy: InferencePolicyRow | undefined,
): AiGatewayAdmissionPolicy | undefined {
	return policyFromRow(tediPolicy);
}

/** Resolve explicit organization/tedi policy rows for a billed organization. */
export async function getEffectiveInferencePolicies(
	db: DbClient,
	organizationId: string,
	tediId?: string | null,
): Promise<EffectiveInferencePolicies | null> {
	const billingAccounts = coreTable(db, schemaBillingAccounts);
	const [account] = await db
		.select({ organizationId: billingAccounts.organizationId })
		.from(billingAccounts)
		.where(eq(billingAccounts.organizationId, organizationId))
		.limit(1);
	if (!account) return null;

	const [organizationPolicy] = await inferencePolicyQuery(
		db,
		organizationId,
		"organization",
		"organization",
	);
	const organization = organizationInferencePolicy(organizationPolicy);

	if (tediId == null) return { organization, tediFound: true };
	const [tedi] = await tediOwnershipQuery(db, organizationId, tediId);
	if (!tedi) return { organization, tediFound: false };
	const [tediPolicy] = await inferencePolicyQuery(
		db,
		organizationId,
		"tedi",
		tediId,
	);
	return {
		organization,
		tedi: tediInferencePolicy(tediPolicy),
		tediFound: true,
	};
}
