/** D1-owned effective inference-admission policies. */

import type { AiGatewayAdmissionPolicy } from "@tedix/api-contract/schemas/tedi";
import { and, eq, sql } from "drizzle-orm";
import type { DbClient } from "../../client";
import {
	billingAccounts,
	billingInferencePolicies,
	billingPlanVersions,
} from "../../schema/billing";
import { tedis } from "../../schema/tedis";

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
): Promise<typeof billingInferencePolicies.$inferSelect> {
	const now = new Date().toISOString();
	const values = {
		id: crypto.randomUUID(),
		organizationId: params.organizationId,
		scope: "tedi" as const,
		subjectKey: params.tediId,
		tediId: params.tediId,
		allowedModelTiers: params.policy.allowedModelTiers ?? null,
		dailyTokenLimit: params.policy.dailyTokenLimit ?? null,
		dailySpendLimitMicros: params.policy.dailySpendLimitMicros ?? null,
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
				dailyTokenLimit: values.dailyTokenLimit,
				dailySpendLimitMicros: values.dailySpendLimitMicros,
				updatedAt: sql`CURRENT_TIMESTAMP`,
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
	row: typeof billingInferencePolicies.$inferSelect | undefined,
): AiGatewayAdmissionPolicy | undefined {
	if (!row) return undefined;
	return {
		...(row.allowedModelTiers === null
			? {}
			: { allowedModelTiers: row.allowedModelTiers }),
		...(row.dailyTokenLimit === null
			? {}
			: { dailyTokenLimit: row.dailyTokenLimit }),
		...(row.dailySpendLimitMicros === null
			? {}
			: { dailySpendLimitMicros: row.dailySpendLimitMicros }),
	};
}

type InferencePolicyRow = typeof billingInferencePolicies.$inferSelect;

/** The explicit policy row for one scope, as a composable statement. */
export function inferencePolicyQuery(
	db: DbClient,
	organizationId: string,
	scope: "organization" | "tedi",
	subjectKey: string,
) {
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
	return db
		.select({ id: tedis.id })
		.from(tedis)
		.where(and(eq(tedis.id, tediId), eq(tedis.organizationId, organizationId)))
		.limit(1);
}

/**
 * Merge the plan default with an explicit organization policy row.
 *
 * Kept separate from the reads so the batched admission path composes the same
 * precedence rather than a second copy of it.
 */
export function organizationInferencePolicy(
	defaultDailyTokenLimit: number,
	organizationPolicy: InferencePolicyRow | undefined,
): AiGatewayAdmissionPolicy {
	const explicit = policyFromRow(organizationPolicy);
	return {
		dailyTokenLimit: explicit?.dailyTokenLimit ?? defaultDailyTokenLimit,
		...(explicit?.dailySpendLimitMicros === undefined
			? {}
			: { dailySpendLimitMicros: explicit.dailySpendLimitMicros }),
		...(explicit?.allowedModelTiers === undefined
			? {}
			: { allowedModelTiers: explicit.allowedModelTiers }),
	};
}

/** Shape the tedi-scope policy, which has no plan default behind it. */
export function tediInferencePolicy(
	tediPolicy: InferencePolicyRow | undefined,
): AiGatewayAdmissionPolicy | undefined {
	return policyFromRow(tediPolicy);
}

/** Resolve plan defaults plus explicit organization/tedi policy rows. */
export async function getEffectiveInferencePolicies(
	db: DbClient,
	organizationId: string,
	tediId?: string | null,
): Promise<EffectiveInferencePolicies | null> {
	const [entitlement] = await db
		.select({
			defaultDailyTokenLimit: billingPlanVersions.defaultDailyTokenLimit,
		})
		.from(billingAccounts)
		.innerJoin(
			billingPlanVersions,
			eq(billingAccounts.planVersionId, billingPlanVersions.id),
		)
		.where(eq(billingAccounts.organizationId, organizationId))
		.limit(1);
	if (!entitlement) return null;

	const [organizationPolicy] = await inferencePolicyQuery(
		db,
		organizationId,
		"organization",
		"organization",
	);
	const organization = organizationInferencePolicy(
		entitlement.defaultDailyTokenLimit,
		organizationPolicy,
	);

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
