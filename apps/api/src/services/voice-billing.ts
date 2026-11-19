/**
 * Credit admission for speech-to-text and text-to-speech.
 *
 * Voice is priced by its own unit: audio seconds for transcription, input
 * characters for speech. Its governed rate is a `provider_model_rate_versions`
 * row for the voice model whose input price is USD micros per million units
 * (seconds or characters) and whose output and cache prices are zero, so the
 * shared reserve and settle path prices units exactly as it prices tokens.
 *
 * Each provider attempt reserves credits for an upper bound of its units,
 * then settles the measured units or releases the hold. A voice model with no
 * governed rate is refused with `pricing_unavailable`, Workers AI included:
 * voice settles here from the rate, never from AI Gateway's reported cost.
 * That refusal lets the next provider run; credit refusals end the call.
 */

import { createDbClient } from "@tedix/db/client";
import { resolveDirectProviderUsagePrice } from "@tedix/db/queries/billing/provider-model-rates";
import {
	releaseBillingReservation,
	reserveBillingUsage,
} from "@tedix/db/queries/billing/reservations";
import { settleBillingUsage } from "@tedix/db/queries/billing/settlement";
import type { BillingUsageSource } from "@tedix/db/schema/billing";
import type { RuntimeEntitlementDenialCode } from "@tedix/api-contract/schemas/runtime-entitlements";
import {
	type VoiceBilling,
	type VoiceBillingAttempt,
	type VoiceBillingHold,
	VoiceBillingRefusal,
} from "@tedix/voice/billing";
import { resolveBillingSettlementMode } from "../lib/billing-settlement-mode";
import { resolveStripeEnvironment } from "../lib/stripe-environment";
import { BILLING_POLICY_DENIED_MESSAGE } from "../rpc/routers/kernel/billing-reservation";

/** Same hold lifetime as kernel and runtime inference reservations. */
const VOICE_HOLD_MS = 10 * 60 * 1_000;

export interface VoiceBillingEnv {
	DB: D1Database;
	TEDIX_BILLING_SETTLEMENT_MODE?: string;
	TEDIX_STRIPE_MODE?: string;
}

/**
 * A voice attempt refused by credit admission; the message is the canonical
 * denial. Only `pricing_unavailable` is specific to the attempt's model, so
 * the next provider may still run; every other code refuses the call.
 */
export class VoiceCreditRefusal extends VoiceBillingRefusal {
	constructor(override readonly code: RuntimeEntitlementDenialCode) {
		super(
			code,
			`${BILLING_POLICY_DENIED_MESSAGE}${code}`,
			code === "pricing_unavailable" ? "attempt" : "call",
		);
		this.name = "VoiceCreditRefusal";
	}
}

function priceUnits(
	d1: D1Database,
	attempt: VoiceBillingAttempt,
	quantity: number,
	occurredAt: string,
) {
	return resolveDirectProviderUsagePrice(
		d1,
		{
			provider: attempt.provider,
			modelId: attempt.model,
			deploymentScope: attempt.deploymentScope,
			occurredAt,
		},
		{
			inputTokens: quantity,
			outputTokens: 0,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
		},
	);
}

function assertQuantity(value: number, label: string): void {
	if (!Number.isSafeInteger(value) || value < 1 || value > 10_000_000)
		throw new Error(`Invalid voice ${label}: ${value}`);
}

/**
 * Voice admission for one organization, or `undefined` when this deployment
 * does not settle credits (external or disabled settlement mode).
 */
export function createVoiceBilling(input: {
	env: VoiceBillingEnv;
	organizationId: string;
	tediId?: string | null;
	source: BillingUsageSource;
	nowMs?: () => number;
}): VoiceBilling | undefined {
	if (resolveBillingSettlementMode(input.env) !== "managed") return undefined;
	const d1 = input.env.DB;
	const db = createDbClient(d1);
	const stripeEnvironment = resolveStripeEnvironment(input.env);
	const clock = input.nowMs ?? Date.now;
	const iso = () => new Date(clock()).toISOString();
	return {
		async admit(attempt): Promise<VoiceBillingHold> {
			assertQuantity(attempt.estimatedQuantity, "estimate");
			const admittedAt = iso();
			const quote = await priceUnits(
				d1,
				attempt,
				attempt.estimatedQuantity,
				admittedAt,
			);
			if (quote.costUsd === null || !quote.rateVersionId)
				throw new VoiceCreditRefusal("pricing_unavailable");
			const reservationId = crypto.randomUUID();
			const decision = await reserveBillingUsage(db, {
				id: reservationId,
				organizationId: input.organizationId,
				tediId: input.tediId ?? null,
				source: input.source,
				provider: attempt.provider,
				model: attempt.model,
				deploymentScope: attempt.deploymentScope,
				// Voice rates price units on the input side; see the module note.
				estimatedInputTokens: attempt.estimatedQuantity,
				estimatedOutputTokens: 0,
				idempotencyKey: `voice:${reservationId}`,
				expiresAt: new Date(
					Date.parse(admittedAt) + VOICE_HOLD_MS,
				).toISOString(),
				metadata: {
					usageKind: attempt.usageKind,
					unit: attempt.unit,
					estimatedQuantity: attempt.estimatedQuantity,
					rateVersionId: quote.rateVersionId,
				},
				now: admittedAt,
			});
			if (!decision.allowed) throw new VoiceCreditRefusal(decision.code);

			return {
				async settle(usage) {
					assertQuantity(usage.quantity, "usage");
					// Settle at the rate the call was admitted under.
					const priced = await priceUnits(
						d1,
						attempt,
						usage.quantity,
						admittedAt,
					);
					if (priced.costUsd === null)
						throw new Error(
							`Voice rate no longer resolves for ${attempt.provider}/${attempt.model}: ${priced.reason}`,
						);
					const now = iso();
					await settleBillingUsage(db, {
						stripeEnvironment,
						id: crypto.randomUUID(),
						organizationId: input.organizationId,
						tediId: input.tediId ?? null,
						reservationId,
						providerUsageId: `voice:${reservationId}`,
						provider: attempt.provider,
						model: attempt.model,
						source: input.source,
						// Units are not tokens; the quantity rides the metadata.
						inputTokens: 0,
						outputTokens: 0,
						providerCostMicros: Math.round(priced.costUsd * 1_000_000),
						usageQuality: usage.measured ? "provider_reported" : "estimated",
						providerCostQuality: "estimated",
						meteringReady: true,
						rateCardVersion: priced.rateVersionId,
						occurredAt: now,
						metadata: {
							usageKind: attempt.usageKind,
							unit: attempt.unit,
							quantity: usage.quantity,
							measured: usage.measured,
							deploymentScope: attempt.deploymentScope,
						},
						now,
					});
				},
				async release(reason) {
					await releaseBillingReservation(db, {
						reservationId,
						organizationId: input.organizationId,
						reason,
						now: iso(),
					});
				},
			};
		},
	};
}
