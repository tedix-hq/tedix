/**
 * AI admission against the organization credit pool.
 *
 * Before a provider call, the estimated provider cost (governed provider
 * rates, USD) is converted to EUR at the plan's pinned reference rate and
 * doubled: credits = ceil(cost in EUR x 2 / EUR 0.01). Those credits are held
 * on the reservation until settlement replaces them with the actual cost.
 */

import type { JsonValue } from "@tedix/api-contract/schemas/common";
import {
	autoRoutedPricingIdentity,
	readProviderExecutionIdentity,
} from "@tedix/api-contract/schemas/provider-execution";
import { aiCreditsForProviderCost } from "@tedix/api-contract/utils/credit-pricing";
import { and, asc, desc, eq, inArray, lte, sql } from "drizzle-orm";
import type { DbClient } from "../../client";
import {
	type BillingReservationStatus,
	type BillingUsageReservation,
	type BillingUsageSource,
	anyBillingReservation,
	billingAccounts,
	billingPlanVersions,
	billingUsageReservations,
} from "../../schema/billing";
import type { NewProviderExecutionAttemptRow } from "../../schema/provider-executions";
import { computeCostMicros } from "../../utils/model-pricing";
import {
	buildProviderExecutionInsertStatement,
	type ProviderExecutionAdmissionGuard,
	providerExecutionGuardPredicate,
	providerExecutionRetryPredicate,
} from "../provider-executions";
import {
	type CreditPoolSnapshot,
	type CreditRefusalCode,
	buildCreditCapacitySelect,
	buildCreditPoolSelect,
	creditAdmissionPredicate,
	creditRefusalReason,
	getCreditPoolSnapshot,
	parseCreditFx,
} from "./credit-pool";
import { findProviderModelRates } from "./provider-model-rates";

export async function listBillingUsageReservations(
	db: DbClient,
	params: {
		organizationId: string;
		status?: BillingReservationStatus;
		limit?: number;
	},
): Promise<BillingUsageReservation[]> {
	return db
		.select()
		.from(billingUsageReservations)
		.where(
			and(
				eq(billingUsageReservations.organizationId, params.organizationId),
				params.status
					? eq(billingUsageReservations.status, params.status)
					: undefined,
			),
		)
		.orderBy(desc(billingUsageReservations.createdAt))
		.limit(params.limit ?? 100);
}

export type BillingReservationDecision =
	| {
			allowed: true;
			reservation: Pick<
				BillingUsageReservation,
				"id" | "planVersionId" | "expiresAt" | "credits"
			>;
	  }
	| {
			allowed: false;
			code: CreditRefusalCode | "pricing_unavailable";
			snapshot: CreditPoolSnapshot | null;
	  };

export interface BillingReservationFreshness {
	/** Newest admitted inference reservation in the last 30 days. */
	maxCreatedAt: string | null;
}

/**
 * Activity side of the Gateway-metering freshness comparison. Reservations
 * are written before provider inference, so they are the durable proof that
 * the Gateway ledger should subsequently advance. Rejected admission creates
 * no row and therefore cannot produce a false metering-dark signal.
 *
 * Reads one row: the last entry of idx_billing_reservation_newest.
 */
export async function getBillingReservationFreshness(
	db: DbClient,
	nowMs: number,
): Promise<BillingReservationFreshness> {
	const iso30d = new Date(nowMs - 30 * 24 * 60 * 60 * 1000).toISOString();
	const rows = await db
		.select({ maxCreatedAt: billingUsageReservations.createdAt })
		.from(billingUsageReservations)
		.where(
			and(
				anyBillingReservation,
				sql`${billingUsageReservations.createdAt} >= ${iso30d}`,
			),
		)
		.orderBy(desc(billingUsageReservations.createdAt))
		.limit(1);
	return { maxCreatedAt: rows[0]?.maxCreatedAt ?? null };
}

export interface BillingReservationPreflightInput {
	organizationId: string;
	idempotencyKey: string;
	executionGuard?: ProviderExecutionAdmissionGuard;
}

export interface BillingReservationPreflight extends BillingReservationPreflightInput {
	existing: BillingUsageReservation | undefined;
	plan: { id: string; creditFx: unknown } | undefined;
}

/** Compose fresh replay and pricing reads into the caller's admission batch. */
export function buildBillingReservationPreflightStatements(
	db: DbClient,
	input: BillingReservationPreflightInput,
) {
	// Scoped by organization as well as key: an unscoped read could hand one
	// organization another's reservation and admit without reserving anything.
	const existingStatement = db
		.select()
		.from(billingUsageReservations)
		.where(
			and(
				eq(billingUsageReservations.idempotencyKey, input.idempotencyKey),
				eq(billingUsageReservations.organizationId, input.organizationId),
				input.executionGuard
					? sql`EXISTS (WITH __provider_replay(billing_reservation_id) AS MATERIALIZED
 (SELECT billing_reservation_id FROM provider_execution_attempts WHERE ${providerExecutionRetryPredicate(input.executionGuard)})
 SELECT 1 FROM __provider_replay WHERE billing_reservation_id=billing_usage_reservations.id)`
					: undefined,
			),
		)
		.limit(1);
	const planStatement = db
		.select({
			id: billingPlanVersions.id,
			creditFx: billingPlanVersions.creditFx,
		})
		.from(billingAccounts)
		.innerJoin(
			billingPlanVersions,
			eq(billingAccounts.planVersionId, billingPlanVersions.id),
		)
		.where(eq(billingAccounts.organizationId, input.organizationId))
		.limit(1);
	return [existingStatement, planStatement] as const;
}

/**
 * Estimated provider cost of one call in USD micros from the one governed
 * rate that applies. Input tokens are priced at the dearer of uncached input
 * and cache write until the provider reports the real split.
 */
export async function estimateProviderCostMicros(
	db: DbClient,
	input: {
		provider: string;
		modelId: string;
		deploymentScope: string;
		estimatedInputTokens: number;
		estimatedOutputTokens: number;
		now: string;
	},
): Promise<number> {
	const rates = await findProviderModelRates(db, {
		provider: input.provider,
		modelId: input.modelId,
		deploymentScope: input.deploymentScope,
		occurredAt: input.now,
		inputTokens: input.estimatedInputTokens,
	});
	if (rates.length !== 1)
		throw new Error("Provider pricing is unavailable or ambiguous");
	const rate = rates[0]!;
	const cost = computeCostMicros(rate, {
		inputTokens: input.estimatedInputTokens,
		outputTokens: input.estimatedOutputTokens,
		cacheReadTokens: 0,
		cacheWriteTokens:
			rate.cacheWriteMicrousdPerMillion > rate.inputMicrousdPerMillion
				? input.estimatedInputTokens
				: 0,
	});
	if (cost === null) throw new Error("Provider cost estimate is invalid");
	return Number(cost);
}

/** Credits to hold for one AI call, or null when it cannot be priced. */
export async function estimateAiCredits(
	db: DbClient,
	input: {
		creditFx: unknown;
		provider: string;
		model: string;
		execution?: NewProviderExecutionAttemptRow;
		deploymentScope?: string;
		estimatedInputTokens: number;
		estimatedOutputTokens: number;
		now: string;
	},
): Promise<number | null> {
	try {
		const fx = parseCreditFx(input.creditFx);
		if (!fx) return null;
		const autoRouted = input.execution
			? autoRoutedPricingIdentity(
					readProviderExecutionIdentity(input.execution),
				)
			: null;
		if (input.model === "cloudflare/auto" && !autoRouted) return null;
		const deploymentScope =
			autoRouted?.deploymentScope ??
			input.execution?.deploymentScope ??
			input.deploymentScope;
		if (!deploymentScope) return null;
		const cost = await estimateProviderCostMicros(db, {
			provider: input.provider,
			modelId: autoRouted?.modelId ?? input.model,
			deploymentScope,
			estimatedInputTokens: input.estimatedInputTokens,
			estimatedOutputTokens: input.estimatedOutputTokens,
			now: input.now,
		});
		return aiCreditsForProviderCost(cost, fx.microUsdPerEur);
	} catch {
		return null;
	}
}

/** Atomically checks the credit pool and reserves one provider inference. */
export async function reserveBillingUsage(
	db: DbClient,
	input: {
		execution?: NewProviderExecutionAttemptRow;
		executionGuard?: ProviderExecutionAdmissionGuard;
		preflight?: BillingReservationPreflight;
		id: string;
		organizationId: string;
		tediId?: string | null;
		userId?: string | null;
		source: BillingUsageSource;
		provider: string;
		model: string;
		deploymentScope?: string;
		estimatedInputTokens: number;
		estimatedOutputTokens: number;
		runId?: string | null;
		traceId?: string | null;
		idempotencyKey: string;
		expiresAt: string;
		metadata?: Record<string, JsonValue>;
		now: string;
		/** Credits the caller already priced; otherwise priced here from the plan's rate. */
		credits?: number;
	},
): Promise<BillingReservationDecision> {
	if (
		input.execution &&
		(input.execution.billingReservationId !== input.id ||
			input.execution.organizationId !== input.organizationId ||
			input.execution.idempotencyKey !== input.idempotencyKey)
	)
		throw new Error("Execution/reservation identity mismatch");
	if (input.executionGuard && !input.execution)
		throw new Error("Guarded reservation requires execution identity");
	const capturedPredicate = input.execution
		? providerExecutionGuardPredicate(input.execution, input.executionGuard)
		: sql`1=1`;
	const eligibility = input.executionGuard
		? sql`__provider_eligibility(eligible) AS MATERIALIZED ${capturedPredicate},`
		: sql``;
	const executionPredicate = input.executionGuard
		? sql`(SELECT eligible FROM __provider_eligibility)`
		: capturedPredicate;
	const estimatedTokens =
		input.estimatedInputTokens + input.estimatedOutputTokens;
	if (
		!Number.isSafeInteger(estimatedTokens) ||
		estimatedTokens <= 0 ||
		input.estimatedInputTokens < 0 ||
		input.estimatedOutputTokens < 0
	)
		throw new Error("Estimated billing tokens must be positive safe integers");

	const preflight = input.preflight;
	if (
		preflight &&
		(preflight.organizationId !== input.organizationId ||
			preflight.idempotencyKey !== input.idempotencyKey ||
			preflight.executionGuard !== input.executionGuard)
	)
		throw new Error("Reservation preflight scope mismatch");
	// Caller-owned preflight comes from this admission's policy batch, never a cache.
	const [existing, plans] = preflight
		? [[preflight.existing], [preflight.plan]]
		: await db.batch(buildBillingReservationPreflightStatements(db, input));
	const plan = plans[0];
	const subject = { tediId: input.tediId, userId: input.userId };
	const snapshot = () =>
		getCreditPoolSnapshot(db, {
			organizationId: input.organizationId,
			now: input.now,
			subject,
		});
	if (existing[0]) {
		return (existing[0].status === "reserved" &&
			existing[0].expiresAt > input.now) ||
			existing[0].status === "settled"
			? { allowed: true, reservation: existing[0] }
			: {
					allowed: false,
					code: "monthly_credit_limit_reached",
					snapshot: await snapshot(),
				};
	}
	if (!plan && input.credits === undefined)
		return { allowed: false, code: "billing_not_configured", snapshot: null };

	const credits =
		input.credits ??
		(await estimateAiCredits(db, {
			creditFx: plan?.creditFx ?? null,
			provider: input.provider,
			model: input.model,
			execution: input.execution,
			deploymentScope: input.deploymentScope,
			estimatedInputTokens: input.estimatedInputTokens,
			estimatedOutputTokens: input.estimatedOutputTokens,
			now: input.now,
		}));
	if (credits === null || !Number.isSafeInteger(credits) || credits < 0)
		return {
			allowed: false,
			code: "pricing_unavailable",
			snapshot: await snapshot(),
		};

	const poolQuery = buildCreditPoolSelect(db, {
		organizationId: input.organizationId,
		now: input.now,
		subject,
	});
	const pool = db.$with("pool").as(poolQuery);
	const capacityQuery = buildCreditCapacitySelect(db, pool, {
		now: input.now,
		subject,
	});
	const capacity = db.$with("capacity").as(capacityQuery);
	// Raw: the eligibility CTE is AS MATERIALIZED, which Drizzle $with cannot
	// emit; the pool and capacity CTEs are the shared credit-admission builders.
	const reservationStatement = db.all(sql`
		WITH ${eligibility} pool AS ${poolQuery},
		capacity AS ${capacityQuery}
		INSERT INTO billing_usage_reservations (
			id, organization_id, plan_version_id, tedi_id, user_id, status, source,
			provider, model, estimated_input_tokens, estimated_output_tokens,
			estimated_charge_micros, credits, period_start, period_end, run_id,
			trace_id, idempotency_key, rejection_code, expires_at, metadata,
			created_at, updated_at
		)
		SELECT
			${input.id}, capacity.organization_id, capacity.plan_version_id,
			${input.tediId ?? null}, ${input.userId ?? null}, 'reserved',
			${input.source}, ${input.provider}, ${input.model},
			${input.estimatedInputTokens}, ${input.estimatedOutputTokens},
			0, ${credits}, capacity.period_start, capacity.period_end,
			${input.runId ?? null}, ${input.traceId ?? null},
			${input.idempotencyKey}, NULL, ${input.expiresAt},
			${JSON.stringify(input.metadata ?? {})}, ${input.now}, ${input.now}
		FROM capacity
		WHERE capacity.plan_version_id = ${plan?.id ?? null}
			AND ${input.expiresAt} > ${input.now}
			AND ${creditAdmissionPredicate(capacity, { now: input.now, credits })}
			AND ${executionPredicate}
		ON CONFLICT(idempotency_key) DO NOTHING
		RETURNING
			id,
			plan_version_id AS planVersionId,
			expires_at AS expiresAt,
			credits
	`);
	const inserted = (
		input.execution
			? (
					await db.batch([
						reservationStatement,
						buildProviderExecutionInsertStatement(
							db,
							input.execution,
							input.executionGuard,
						),
					])
				)[0]
			: await reservationStatement
	) as Array<
		Pick<
			BillingUsageReservation,
			"id" | "planVersionId" | "expiresAt" | "credits"
		>
	>;
	if (inserted[0]) return { allowed: true, reservation: inserted[0] };

	const current = await snapshot();
	return {
		allowed: false,
		code:
			creditRefusalReason(current, { now: input.now, credits }) ??
			unclassifiedRefusal(input.organizationId, credits),
		snapshot: current,
	};
}

/**
 * The INSERT refused but the pool snapshot admits the credits: a race with
 * another reservation or an expired hold. Name the pool limit and record the
 * shape so drift between the two copies stays visible.
 */
function unclassifiedRefusal(
	organizationId: string,
	credits: number,
): CreditRefusalCode {
	try {
		console.log(
			JSON.stringify({
				_tr: "admission_refusal_unclassified",
				organizationId,
				credits,
			}),
		);
	} catch {
		/* a diagnostic must never fail an admission decision */
	}
	return "monthly_credit_limit_reached";
}

export async function releaseBillingReservation(
	db: DbClient,
	input: {
		reservationId: string;
		organizationId: string;
		reason: string;
		now: string;
	},
): Promise<BillingUsageReservation | null> {
	const [row] = await db
		.update(billingUsageReservations)
		.set({
			status: "released",
			rejectionCode: input.reason,
			releasedAt: input.now,
			updatedAt: input.now,
		})
		.where(
			and(
				eq(billingUsageReservations.id, input.reservationId),
				eq(billingUsageReservations.organizationId, input.organizationId),
				eq(billingUsageReservations.status, "reserved"),
			),
		)
		.returning();
	return row ?? null;
}

export async function expireBillingReservations(
	db: DbClient,
	now: string,
): Promise<number> {
	const rows = await db
		.update(billingUsageReservations)
		.set({ status: "expired", updatedAt: now })
		.where(
			// bound-params: a subquery, not a bound list.
			inArray(
				billingUsageReservations.id,
				db
					.select({ id: billingUsageReservations.id })
					.from(billingUsageReservations)
					.where(
						and(
							eq(billingUsageReservations.status, "reserved"),
							lte(billingUsageReservations.expiresAt, now),
						),
					)
					.orderBy(asc(billingUsageReservations.expiresAt))
					.limit(500),
			),
		)
		.returning({ id: billingUsageReservations.id });
	return rows.length;
}
