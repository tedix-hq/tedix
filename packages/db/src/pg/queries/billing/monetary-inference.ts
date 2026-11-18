import {
	monetaryInferenceConfig,
	estimateMonetaryInference,
} from "../../../queries/billing/monetary-inference";
import type { MonetaryInferenceConfig } from "@tedix/api-contract/schemas/billing";
import { billingAccounts, type BillingPlanVersion } from "../../schema/billing";
import { and, eq, sql } from "drizzle-orm";
import type { PgQueryClient } from "../../query-client";
import type { BillingBalanceSnapshot } from "../../../queries/billing/credits";
import { providerModelRateVersions } from "../../schema/provider-model-rates";

/** Monetary EUR spend in the current reservation accounting window. */
export function monetaryPeriodSpendSql() {
	return sql`COALESCE((SELECT SUM(charge.credit_applied_micros + charge.customer_charge_micros)
	FROM billing_usage_charges AS charge
	JOIN billing_usage_reservations AS held ON held.id=charge.reservation_id
	WHERE charge.organization_id=account.organization_id AND charge.occurred_at>=account.period_start
	AND held.period_start=account.period_start AND held.period_end=account.period_end
	AND charge.metadata #> '{monetaryQuote,schemaVersion}' IN ('1'::jsonb, 'true'::jsonb)
	AND (charge.metadata #>> '{monetaryQuote,rateSnapshot,customerCurrency}')='EUR'),0)`;
}

export async function verifyMonetaryQuoteReceipt(
	db: PgQueryClient,
	quote: ReturnType<typeof estimateMonetaryInference>,
	deploymentScope?: string,
) {
	const snapshot =
		quote.rateSnapshot as MonetaryInferenceConfig["rates"][number];
	const [receipt] = await db
		.select()
		.from(providerModelRateVersions)
		.where(eq(providerModelRateVersions.id, snapshot.id))
		.limit(1);
	if (
		!receipt ||
		receipt.provider !== snapshot.provider ||
		receipt.modelId !== snapshot.model ||
		receipt.currency !== snapshot.currency ||
		receipt.deploymentScope !== snapshot.deploymentScope ||
		(deploymentScope !== undefined &&
			receipt.deploymentScope !== deploymentScope) ||
		receipt.effectiveFrom !== snapshot.effectiveFrom ||
		receipt.evidenceUri !== snapshot.sourceReceipt ||
		receipt.inputTokenMin !== snapshot.inputTokenMin ||
		receipt.inputTokenMax !== snapshot.inputTokenMax ||
		receipt.inputMicrousdPerMillion !== snapshot.providerRates.uncachedInput ||
		receipt.outputMicrousdPerMillion !== snapshot.providerRates.output ||
		receipt.cacheReadMicrousdPerMillion !== snapshot.providerRates.cacheRead ||
		receipt.cacheWriteMicrousdPerMillion !== snapshot.providerRates.cacheWrite
	)
		throw new Error(
			"Monetary pricing does not match its published provider receipt",
		);
}

/** Never enables cash overage or changes a token plan's financial contract. */
export async function setMonetaryCreditBudget(
	db: PgQueryClient,
	input: {
		organizationId: string;
		monthlyCapMicros: number | null;
		now: string;
	},
) {
	return db
		.update(billingAccounts)
		.set({ hardSpendLimitMicros: input.monthlyCapMicros, updatedAt: input.now })
		.where(
			and(
				eq(billingAccounts.organizationId, input.organizationId),
				sql`EXISTS (SELECT 1 FROM billing_plan_versions WHERE id = ${billingAccounts.planVersionId} AND currency='eur' AND metadata #> '{monetaryInference,version}' IN ('1'::jsonb, 'true'::jsonb))`,
			),
		)
		.returning({ organizationId: billingAccounts.organizationId });
}

/** Dispatch readiness only: paid calls still require their own exact execution scope. */
export async function preflightMonetaryInference(
	db: PgQueryClient,
	plan: BillingPlanVersion,
	snapshot: BillingBalanceSnapshot,
	input: {
		provider: string;
		model: string;
		estimatedInputTokens: number;
		estimatedOutputTokens: number;
		now: string;
	},
) {
	const config = monetaryInferenceConfig(plan);
	if (!config) return null;
	if (!["active", "trial"].includes(snapshot.status))
		return { allowed: false as const, code: "subscription_inactive" as const };
	if (input.now < snapshot.periodStart || input.now >= snapshot.periodEnd)
		return {
			allowed: false as const,
			code: "billing_period_inactive" as const,
		};
	try {
		const quote = estimateMonetaryInference(config, input);
		await verifyMonetaryQuoteReceipt(db, quote);
		if (snapshot.availableCreditMicros < quote.customerChargeMicros)
			return {
				allowed: false as const,
				code: "credit_allowance_exhausted" as const,
			};
		if (
			(snapshot.hardSpendLimitMicros !== null &&
				(snapshot.monetarySpentMicros ?? 0) +
					snapshot.reservedChargeMicros +
					quote.customerChargeMicros >
					snapshot.hardSpendLimitMicros) ||
			(config.perRunBudgetMicros !== undefined &&
				quote.customerChargeMicros > config.perRunBudgetMicros)
		)
			return { allowed: false as const, code: "hard_spend_limit" as const };
		return {
			allowed: true as const,
			estimatedChargeMicros: quote.customerChargeMicros,
		};
	} catch {
		return { allowed: false as const, code: "pricing_unavailable" as const };
	}
}
