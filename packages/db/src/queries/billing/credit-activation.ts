/** Account-scoped credit pricing activation. Never publishes a catalog default. */
import type { ConfigureCreditBillingInput } from "@tedix/api-contract/schemas/credit-billing-activation";
import { MonetaryInferenceConfigSchema } from "@tedix/api-contract/schemas/billing";
import { and, eq, getTableColumns, inArray, sql } from "drizzle-orm";
import type { DbClient } from "../../client";
import {
	billingAccounts,
	billingCreditEntries,
	billingPlanVersions,
} from "../../schema/billing";
import { providerModelRateVersions } from "../../schema/provider-model-rates";
import { getBillingEntitlement } from "./plans";

export function includedCreditPeriodKey(
	organizationId: string,
	periodStart: string,
	periodEnd: string,
) {
	return `included-credit:${organizationId}:${periodStart}:${periodEnd}`;
}

/** The SELECT fences the journal insert on the canonical account, including CAS activation. */
export function buildIncludedCreditPeriodGrant(
	db: DbClient,
	input: {
		organizationId: string;
		planVersionId: string;
		periodStart: string;
		periodEnd: string;
		amountMicros: number;
		now: string;
		metadata?: Record<string, unknown>;
	},
) {
	const key = includedCreditPeriodKey(
		input.organizationId,
		input.periodStart,
		input.periodEnd,
	);
	const metadata = JSON.stringify({
		...input.metadata,
		planVersionId: input.planVersionId,
		periodStart: input.periodStart,
		periodEnd: input.periodEnd,
		includedCreditCarryForward: true,
	});
	return db
		.insert(billingCreditEntries)
		.select(sql`SELECT
  ${key}, organization_id, 'grant', ${input.amountMicros}, 'plan_period', ${input.periodStart},
  NULL, ${key}, NULL, 'Included monthly credits (carry forward)', ${metadata}, ${input.now}
  FROM billing_accounts WHERE organization_id = ${input.organizationId}
  AND plan_version_id = ${input.planVersionId} AND period_start = ${input.periodStart}
  AND period_end = ${input.periodEnd} AND status = 'active'`)
		.onConflictDoNothing({ target: billingCreditEntries.idempotencyKey });
}

export async function configureCreditBilling(
	db: DbClient,
	input: ConfigureCreditBillingInput,
	actor: string,
	now: string,
) {
	const entitlement = await getBillingEntitlement(db, input.organizationId);
	if (!entitlement) throw new Error("Billing account not found");
	const { account, plan } = entitlement;
	const request = JSON.stringify(input);
	const activation = account.metadata.creditBillingActivation as
		| { key?: string; request?: string }
		| undefined;
	const response = (alreadyConfigured: boolean) => ({
		organizationId: account.organizationId,
		planVersionId: account.planVersionId,
		entitlementVersion: account.entitlementVersion,
		creditBalanceMicros: account.creditBalanceMicros,
		periodStart: account.periodStart,
		periodEnd: account.periodEnd,
		includedCreditCarryForward: true as const,
		alreadyConfigured,
	});
	if (activation?.key === input.idempotencyKey) {
		if (activation.request !== request)
			throw new Error("Activation key reused with different input");
		return response(true);
	}
	if (plan.metadata.monetaryInference)
		throw new Error(
			"Credit billing is already configured; use a new governed change",
		);
	if (account.entitlementVersion !== input.expectedEntitlementVersion)
		throw new Error("Billing entitlement changed; re-read before activation");
	if (
		account.status !== "active" ||
		plan.currency.toUpperCase() !== "USD" ||
		plan.planKey === "starter"
	)
		throw new Error("Credit activation requires an active paid USD account");
	if (
		Date.parse(account.periodStart) > Date.parse(now) ||
		Date.parse(account.periodEnd) <= Date.parse(now)
	)
		throw new Error("Billing period must be current before activation");
	if (input.perRunBudgetMicros > input.monthlyCapMicros)
		throw new Error("Run budget exceeds monthly cap");
	const ids = input.rateBindings.map((binding) => binding.rateVersionId);
	if (new Set(ids).size !== ids.length)
		throw new Error("Duplicate rate binding");
	const rows = await db
		.select()
		.from(providerModelRateVersions)
		.where(inArray(providerModelRateVersions.id, ids));
	const config = MonetaryInferenceConfigSchema.parse({
		version: 1,
		currency: "USD",
		creditValueMicros: 10_000,
		pricing: "provider_pass_through",
		perRunBudgetMicros: input.perRunBudgetMicros,
		rates: input.rateBindings.map((binding) => {
			const row = rows.find((value) => value.id === binding.rateVersionId);
			if (!row || row.effectiveFrom > now || row.publishedAt > now)
				throw new Error("Published current pricing receipt required");
			if (
				binding.requestModelAliases.some(
					(alias) => alias !== `openai/${row.modelId}`,
				)
			)
				throw new Error("Unsupported model alias");
			const prices = {
				uncachedInput: row.inputMicrousdPerMillion,
				output: row.outputMicrousdPerMillion,
				cacheRead: row.cacheReadMicrousdPerMillion,
				cacheWrite: row.cacheWriteMicrousdPerMillion,
			};
			return {
				schemaVersion: 1,
				id: row.id,
				version: 1,
				provider: row.provider,
				model: row.modelId,
				deploymentScope: row.deploymentScope,
				currency: row.currency,
				funding: "managed",
				effectiveFrom: row.effectiveFrom,
				effectiveUntil: null,
				sourceReceipt: row.evidenceUri,
				providerRates: prices,
				customerRates: prices,
				creditValueMicros: 10_000,
				inputConvention: binding.inputConvention,
				requestModelAliases: binding.requestModelAliases,
				inputTokenMin: row.inputTokenMin,
				inputTokenMax: row.inputTokenMax,
			};
		}),
	});
	const [superseding] = await db
		.select({ id: providerModelRateVersions.id })
		.from(providerModelRateVersions)
		.where(inArray(providerModelRateVersions.supersedesRateVersionId, ids))
		.limit(1);
	if (superseding) throw new Error("Pricing receipt has been superseded");
	const [version] = await db
		.select({ value: sql<number>`COALESCE(MAX(version), 0) + 1` })
		.from(billingPlanVersions)
		.where(eq(billingPlanVersions.planKey, plan.planKey));
	const privateId = `credit-plan:${input.organizationId}:${input.idempotencyKey}`;
	const metadata = {
		...account.metadata,
		creditBillingActivation: {
			key: input.idempotencyKey,
			request,
			actor,
			reason: input.reason,
			previousPlanVersionId: plan.id,
			configuredAt: now,
			includedCreditCarryForward: true,
		},
	};
	const clone = {
		...plan,
		id: privateId,
		version: version!.value,
		status: "retired",
		includedMonthlyTokens: 0,
		includedMonthlyCreditMicros: input.includedMonthlyCreditMicros,
		allowOverage: false,
		metadata: {
			...plan.metadata,
			monetaryInference: config,
			privateOptIn: true,
		},
		effectiveAt: now,
		createdAt: now,
	};
	// The plan insert and account CAS share a fence inside one atomic D1 batch.
	// A stale activation cannot leave an orphan private plan that poisons retries.
	const values = Object.keys(getTableColumns(billingPlanVersions)).map(
		(key) => {
			const value = clone[key as keyof typeof clone];
			return sql`${typeof value === "object" && value !== null ? JSON.stringify(value) : typeof value === "boolean" ? Number(value) : value}`;
		},
	);
	const fence = sql`organization_id = ${input.organizationId} AND entitlement_version = ${account.entitlementVersion}
  AND NOT EXISTS (SELECT 1 FROM billing_usage_reservations WHERE organization_id = ${input.organizationId} AND status = 'reserved' AND expires_at > ${now})`;
	await db.batch([
		db
			.insert(billingPlanVersions)
			.select(
				sql`SELECT ${sql.join(values, sql`, `)} FROM billing_accounts WHERE ${fence}`,
			),
		db
			.update(billingAccounts)
			.set({
				planVersionId: privateId,
				hardSpendLimitMicros: input.monthlyCapMicros,
				overageEnabled: false,
				entitlementVersion: account.entitlementVersion + 1,
				metadata,
				updatedAt: now,
			})
			.where(
				and(
					eq(billingAccounts.organizationId, input.organizationId),
					eq(billingAccounts.entitlementVersion, account.entitlementVersion),
					sql`NOT EXISTS (SELECT 1 FROM billing_usage_reservations WHERE organization_id = ${input.organizationId} AND status = 'reserved' AND expires_at > ${now})`,
				),
			),
		buildIncludedCreditPeriodGrant(db, {
			organizationId: input.organizationId,
			planVersionId: privateId,
			periodStart: account.periodStart,
			periodEnd: account.periodEnd,
			amountMicros: input.includedMonthlyCreditMicros,
			now,
			metadata: { activationKey: input.idempotencyKey, actor },
		}),
	]);
	const updated = await getBillingEntitlement(db, input.organizationId);
	if (updated?.account.planVersionId !== privateId)
		throw new Error(
			"Activation lost its entitlement fence or inference is still reserved; no credits granted",
		);
	return {
		...response(false),
		planVersionId: privateId,
		entitlementVersion: updated.account.entitlementVersion,
		creditBalanceMicros: updated.account.creditBalanceMicros,
	};
}
