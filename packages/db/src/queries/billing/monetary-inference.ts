import {
	MonetaryInferenceConfigSchema,
	type MonetaryInferenceConfig,
} from "@tedix/api-contract/schemas/billing";
import {
	quoteInferenceCredits,
	type InferenceCreditQuote,
} from "@tedix/api-contract/utils/inference-credit-quote";
import type { JsonValue } from "@tedix/api-contract/schemas/common";
import {
	billingAccounts,
	type BillingPlanVersion,
	type BillingUsageReservation,
	type BillingUsagePeriod,
} from "../../schema/billing";
import { and, eq, sql } from "drizzle-orm";
import type { DbClient } from "../../client";
import type { BillingBalanceSnapshot } from "./credits";
import { providerModelRateVersions } from "../../schema/provider-model-rates";

/** Canonical monetary-only spend; legacy token charges remain historical. */
export function monetaryPeriodSpendSql() {
	return sql`COALESCE((SELECT SUM(charge.credit_applied_micros + charge.customer_charge_micros)
	FROM billing_usage_charges AS charge JOIN billing_usage_reservations AS held ON held.id=charge.reservation_id
	WHERE charge.organization_id=account.organization_id AND held.period_start=account.period_start AND held.period_end=account.period_end
	AND json_extract(charge.metadata,'$.monetaryQuote.schemaVersion')=1),0)`;
}

export async function verifyMonetaryQuoteReceipt(
	db: DbClient,
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

export function monetaryInferenceConfig(
	plan: Pick<BillingPlanVersion, "currency" | "metadata">,
): MonetaryInferenceConfig | null {
	const raw = plan.metadata.monetaryInference;
	if (raw === undefined) return null;
	const config = MonetaryInferenceConfigSchema.parse(raw);
	if (plan.currency.toLowerCase() !== "usd")
		throw new Error(
			"Monetary inference wallet requires USD; no implicit FX conversion",
		);
	for (const rate of config.rates) {
		for (const bucket of [
			"uncachedInput",
			"cacheRead",
			"cacheWrite",
			"output",
		] as const) {
			if (rate.customerRates[bucket] !== rate.providerRates[bucket])
				throw new Error(
					"Pass-through rates must match published provider prices",
				);
		}
	}
	return config;
}

export function estimateMonetaryInference(
	config: MonetaryInferenceConfig,
	input: {
		provider: string;
		model: string;
		estimatedInputTokens: number;
		estimatedOutputTokens: number;
		now: string;
	},
) {
	const at = Date.parse(input.now);
	const rates = config.rates.filter(
		(rate) =>
			rate.provider === input.provider &&
			(rate.model === input.model ||
				rate.requestModelAliases.includes(input.model)) &&
			input.estimatedInputTokens >= rate.inputTokenMin &&
			(rate.inputTokenMax === null ||
				input.estimatedInputTokens < rate.inputTokenMax) &&
			Date.parse(rate.effectiveFrom) <= at &&
			(rate.effectiveUntil === null || at < Date.parse(rate.effectiveUntil)),
	);
	if (rates.length !== 1)
		throw new Error("Monetary inference pricing is unavailable or ambiguous");
	const rate = rates[0]!;
	// Cache writes may be more expensive. Reserve the most expensive input
	// bucket until the provider supplies authoritative disjoint usage.
	const inputBucket = (
		["uncachedInput", "cacheRead", "cacheWrite"] as const
	).reduce(
		(highest, key) =>
			rate.customerRates[key] > rate.customerRates[highest] ? key : highest,
		"uncachedInput",
	);
	const quote = quoteInferenceCredits({
		rate,
		occurredAt: input.now,
		usageKind: "estimate",
		funding: "managed",
		tokens: {
			uncachedInput: 0,
			cacheRead: 0,
			cacheWrite: 0,
			output: input.estimatedOutputTokens,
			[inputBucket]: input.estimatedInputTokens,
		},
	});
	return {
		...quote,
		inputConvention: rate.inputConvention,
		requestModelAliases: rate.requestModelAliases,
		inputTokenMin: rate.inputTokenMin,
		inputTokenMax: rate.inputTokenMax,
	};
}

export function observedMonetaryInference(
	reservation: BillingUsageReservation,
	input: {
		provider: string;
		model: string;
		inputTokens: number;
		outputTokens: number;
		occurredAt: string;
		metadata?: Record<string, JsonValue>;
	},
): Readonly<InferenceCreditQuote> | null {
	const raw = reservation.metadata.monetaryQuote;
	if (raw === undefined) return null;
	if (raw === null || typeof raw !== "object" || Array.isArray(raw))
		throw new Error("Invalid pinned monetary quote");
	const snapshot = raw.rateSnapshot;
	const config = MonetaryInferenceConfigSchema.parse({
		version: 1,
		currency: "USD",
		creditValueMicros: 10_000,
		pricing: "provider_pass_through",
		rates: [
			{
				...(snapshot as object),
				inputConvention: raw.inputConvention,
				requestModelAliases: raw.requestModelAliases,
				inputTokenMin: raw.inputTokenMin,
				inputTokenMax: raw.inputTokenMax,
			},
		],
	});
	const rate = config.rates[0]!;
	if (
		rate.provider !== input.provider ||
		(rate.model !== input.model &&
			!rate.requestModelAliases.includes(input.model))
	)
		throw new Error(
			"Settlement provider/model differs from reserved monetary price",
		);
	const cacheRead = input.metadata?.cacheReadTokens ?? 0;
	const cacheWrite = input.metadata?.cacheWriteTokens ?? 0;
	if (typeof cacheRead !== "number" || typeof cacheWrite !== "number")
		throw new Error("Invalid provider cache counters");
	const uncachedInput =
		rate.inputConvention === "inclusive"
			? input.inputTokens - cacheRead - cacheWrite
			: input.inputTokens;
	const inclusive = uncachedInput + cacheRead + cacheWrite;
	if (
		inclusive < rate.inputTokenMin ||
		(rate.inputTokenMax !== null && inclusive >= rate.inputTokenMax)
	)
		throw new Error("Observed input is outside the reserved pricing tier");
	// The tariff was accepted at admission; a late receipt cannot reprice it.
	return quoteInferenceCredits({
		rate,
		occurredAt: reservation.createdAt,
		usageKind: "observed",
		funding: "managed",
		tokens: {
			uncachedInput,
			cacheRead,
			cacheWrite,
			output: input.outputTokens,
		},
	});
}

export function monetaryCreditOverview(
	plan: BillingPlanVersion,
	snapshot: BillingBalanceSnapshot,
	period: BillingUsagePeriod | null,
) {
	if (!monetaryInferenceConfig(plan)) return undefined;
	const used = snapshot.monetarySpentMicros ?? 0;
	return {
		billingMode: "monetary" as const,
		currency: "usd" as const,
		creditValueMicros: 10_000 as const,
		includedMicros: plan.includedMonthlyCreditMicros,
		usedIncludedMicros: Math.min(used, plan.includedMonthlyCreditMicros),
		remainingIncludedMicros: Math.max(
			plan.includedMonthlyCreditMicros - used,
			0,
		),
		walletBalanceMicros: snapshot.creditBalanceMicros,
		reservedMicros: snapshot.reservedChargeMicros,
		availableMicros: snapshot.availableCreditMicros,
		spentMicros: used,
		monthlyCapMicros: snapshot.hardSpendLimitMicros,
	};
}

/** Never enables cash overage or changes a token plan's financial contract. */
export async function setMonetaryCreditBudget(
	db: DbClient,
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
				sql`EXISTS (SELECT 1 FROM billing_plan_versions WHERE id = ${billingAccounts.planVersionId} AND currency='usd' AND json_extract(metadata,'$.monetaryInference.version')=1)`,
			),
		)
		.returning({ organizationId: billingAccounts.organizationId });
}

/** Dispatch readiness only: paid calls still require their own exact execution scope. */
export async function preflightMonetaryInference(
	db: DbClient,
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
