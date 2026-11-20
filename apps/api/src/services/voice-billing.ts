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

import { createDbClient, type DbClient } from "@tedix/db/client";
import { resolveDirectProviderUsagePrice } from "@tedix/db/queries/billing/provider-model-rates";
import {
	getVoiceBillingReservation,
	releaseBillingReservation,
	reserveBillingUsage,
} from "@tedix/db/queries/billing/reservations";
import { settleBillingUsage } from "@tedix/db/queries/billing/settlement";
import type { BillingUsageSource } from "@tedix/db/schema/billing";
import type { RuntimeEntitlementDenialCode } from "@tedix/api-contract/schemas/runtime-entitlements";
import {
	type VoiceBilling,
	type VoiceBillingAttempt,
	type VoiceUsageMeasurement,
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

interface VoiceBillingSubject {
	organizationId: string;
	tediId?: string | null;
	userId?: string;
	source: BillingUsageSource;
}

/** Reserve one provider attempt and retain the inputs needed to price it. */
export async function reserveVoiceUsage(
	env: VoiceBillingEnv,
	subject: VoiceBillingSubject,
	attempt: VoiceBillingAttempt,
	admittedAt: string,
) {
	if (resolveBillingSettlementMode(env) !== "managed")
		throw new Error("Voice credit admission requires managed settlement");
	assertQuantity(attempt.estimatedQuantity, "estimate");
	const quote = await priceUnits(
		env.DB,
		attempt,
		attempt.estimatedQuantity,
		admittedAt,
	);
	if (quote.costUsd === null || !quote.rateVersionId)
		throw new VoiceCreditRefusal("pricing_unavailable");

	const reservationId = crypto.randomUUID();
	const decision = await reserveBillingUsage(createDbClient(env.DB), {
		organizationId: subject.organizationId,
		tediId: subject.tediId ?? null,
		userId: subject.userId,
		source: subject.source,
		id: reservationId,
		provider: attempt.provider,
		model: attempt.model,
		deploymentScope: attempt.deploymentScope,
		estimatedInputTokens: attempt.estimatedQuantity,
		estimatedOutputTokens: 0,
		idempotencyKey: `voice:${reservationId}`,
		expiresAt: new Date(Date.parse(admittedAt) + VOICE_HOLD_MS).toISOString(),
		metadata: { ...attempt, rateVersionId: quote.rateVersionId },
		now: admittedAt,
	});
	if (!decision.allowed) throw new VoiceCreditRefusal(decision.code);
	return reservationId;
}

async function settleVoiceUsage(
	env: VoiceBillingEnv,
	db: DbClient,
	subject: Omit<VoiceBillingSubject, "userId">,
	reservationId: string,
	attempt: VoiceBillingAttempt,
	admittedAt: string,
	usage: VoiceUsageMeasurement,
	now: string,
) {
	assertQuantity(usage.quantity, "usage");
	const priced = await priceUnits(env.DB, attempt, usage.quantity, admittedAt);
	if (priced.costUsd === null)
		throw new Error(
			`Voice rate no longer resolves for ${attempt.provider}/${attempt.model}: ${priced.reason}`,
		);
	await settleBillingUsage(db, {
		stripeEnvironment: resolveStripeEnvironment(env),
		id: crypto.randomUUID(),
		organizationId: subject.organizationId,
		tediId: subject.tediId ?? null,
		reservationId,
		providerUsageId: `voice:${reservationId}`,
		provider: attempt.provider,
		model: attempt.model,
		source: subject.source,
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
}

export async function finishRuntimeVoiceUsage(
	env: VoiceBillingEnv,
	input: import("@tedix/voice/billing").RuntimeVoiceCompletion,
): Promise<void> {
	const db = createDbClient(env.DB);
	const reservation = await getVoiceBillingReservation(db, input);
	if (!reservation) throw new Error("Voice reservation not found");
	const now = new Date().toISOString();
	if ("reason" in input) {
		await releaseBillingReservation(db, {
			organizationId: input.organizationId,
			reservationId: input.reservationId,
			reason: input.reason,
			now,
		});
		return;
	}
	const {
		provider,
		model,
		deploymentScope,
		usageKind,
		unit,
		estimatedQuantity,
	} = reservation.metadata;
	if (
		(provider !== "azure-openai" && provider !== "workers-ai") ||
		typeof model !== "string" ||
		typeof deploymentScope !== "string" ||
		typeof estimatedQuantity !== "number" ||
		!(
			(usageKind === "voice_stt" && unit === "seconds") ||
			(usageKind === "voice_tts" && unit === "characters")
		)
	)
		throw new Error("Invalid voice reservation metadata");
	await settleVoiceUsage(
		env,
		db,
		reservation,
		reservation.id,
		{ provider, model, deploymentScope, usageKind, unit, estimatedQuantity },
		reservation.createdAt,
		input.usage,
		now,
	);
}

/** Voice admission for deployments that settle managed credits. */
export function createVoiceBilling(
	input: VoiceBillingSubject & { env: VoiceBillingEnv; nowMs?: () => number },
): VoiceBilling | undefined {
	if (resolveBillingSettlementMode(input.env) !== "managed") return undefined;
	const db = createDbClient(input.env.DB);
	const clock = input.nowMs ?? Date.now;
	const iso = () => new Date(clock()).toISOString();
	return {
		async admit(attempt) {
			const admittedAt = iso();
			const reservationId = await reserveVoiceUsage(
				input.env,
				input,
				attempt,
				admittedAt,
			);
			return {
				settle: (usage) =>
					settleVoiceUsage(
						input.env,
						db,
						input,
						reservationId,
						attempt,
						admittedAt,
						usage,
						iso(),
					),
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
