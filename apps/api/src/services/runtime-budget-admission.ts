import type {
	AuthorizeRuntimeInferenceInput,
	AuthorizeRuntimeInferenceResponse,
} from "@tedix/api-contract/schemas/runtime-entitlements";
import type { ProviderExecutionAdmissionGuard } from "@tedix/db/queries/provider-executions";
import type { NewProviderExecutionAttemptRow } from "@tedix/db/schema/provider-executions";
import type { DbClient } from "@tedix/db/client";
import { getInferenceAdmissionReads } from "@tedix/db/queries/billing/inference-admission";
import { reserveBillingUsage } from "@tedix/db/queries/billing/reservations";
import { runtimeEntitlementIsActive } from "@tedix/db/queries/runtime-entitlements";
import { toJsonRecord } from "@tedix/db/utils/json";
import { resolveBillingSettlementMode } from "../lib/billing-settlement-mode";
import { resolveStripeEnvironment } from "../lib/stripe-environment";
import {
	aiGatewayModelTierAllowed,
	aiGatewayReservationLimits,
	resolveAiGatewayAdmissionPolicy,
} from "./ai-gateway-admission-policy";

/**
 * Content-free phase timing for inference admission.
 *
 * The runtime's `inference_authorize` marker measured this RPC at 505-1469ms
 * per provider request, awaited before EVERY model round, and showed the cost
 * does not track payload size — so it is handler latency, not runtime work.
 * This names which part of it is responsible. Join to the runtime marker on
 * `runId`.
 *
 * `readMs` replaced the separate `entitlementMs`/`policyMs` spans when those
 * reads became one batch. Keeping two fields would have reported the whole
 * batch under whichever await was wrapped first and ~0 for the other, which
 * reads as "the policy cost vanished" when only the phase boundary moved.
 * Against the serial baseline (187ms entitlement + 713ms policies, totalMs
 * 1321-1388) the honest comparison is `readMs` against their sum, and `totalMs`
 * against `totalMs`.
 *
 * Identifiers and durations only; never the request body or its token estimates.
 */
function markAdmission(input: {
	runId: string | null;
	organizationId: string;
	mode: string;
	outcome: string;
	readMs: number;
	stripeMs: number;
	reserveMs: number;
	totalMs: number;
}): void {
	try {
		console.log(JSON.stringify({ _tr: "authorize_inference_api", ...input }));
	} catch {
		/* marker is best-effort */
	}
}

export async function authorizeRuntimeBudget(input: {
	db: DbClient;
	env: CloudflareEnv | { TEDIX_BILLING_SETTLEMENT_MODE?: string };
	request: Omit<
		AuthorizeRuntimeInferenceInput,
		"execution" | "workItemId" | "originToken"
	> & {
		provider: string;
		model: string;
	};
	execution?: NewProviderExecutionAttemptRow;
	executionGuard?: ProviderExecutionAdmissionGuard;
	nowMs?: number;
}): Promise<RuntimeBudgetDecision> {
	const mode = resolveBillingSettlementMode(input.env);
	if (mode !== input.request.settlementMode) {
		throw new Error(
			`Runtime settlement mode mismatch: caller=${input.request.settlementMode} api=${mode}`,
		);
	}
	const nowMs = input.nowMs ?? Date.now();
	const admissionAt = Date.now();
	let readMs = 0;
	let stripeMs = 0;
	let reserveMs = 0;
	const done = (outcome: string) =>
		markAdmission({
			runId: input.request.runId ?? null,
			organizationId: input.request.organizationId,
			mode,
			outcome,
			readMs,
			stripeMs,
			reserveMs,
			totalMs: Date.now() - admissionAt,
		});
	// The reads are hoisted into one batch; the CHECKS below keep their original
	// order deliberately. Deciding the policy outcome before the entitlement
	// early-returns would turn a clean `entitlement_not_configured` denial into
	// the `policy_unresolved` throw, which the runtime maps to a
	// billing_service_error — a 500 class where a denial belongs.
	const readAt = Date.now();
	const { entitlement, policies: policySources } =
		await getInferenceAdmissionReads(
			input.db,
			input.request.organizationId,
			input.request.tediId,
		);
	readMs = Date.now() - readAt;
	if (!entitlement) {
		done("entitlement_not_configured");
		return {
			allowed: false,
			code: "entitlement_not_configured",
			entitlement: null,
		};
	}
	if (entitlement.status !== "trial" && entitlement.status !== "active") {
		done("entitlement_inactive");
		return { allowed: false, code: "entitlement_inactive", entitlement };
	}
	if (!runtimeEntitlementIsActive(entitlement, nowMs)) {
		done("entitlement_period_inactive");
		return {
			allowed: false,
			code: "entitlement_period_inactive",
			entitlement,
		};
	}
	if (!policySources || !policySources.tediFound) {
		// A slow FAILING admission is exactly as interesting as a slow successful
		// one; emit before throwing so this path is not a hole in the timing.
		done("policy_unresolved");
		throw new Error("AI Gateway policy attribution does not resolve in D1");
	}
	const aiGatewayPolicy = resolveAiGatewayAdmissionPolicy(policySources);
	if (
		!aiGatewayModelTierAllowed(
			input.request.provider,
			input.request.model,
			aiGatewayPolicy,
		)
	) {
		done("model_tier_not_allowed");
		return {
			allowed: false,
			code: "model_tier_not_allowed",
			entitlement,
		};
	}
	if (mode !== "managed") {
		done("allowed_unmanaged");
		return {
			allowed: true,
			settlementMode: mode,

			reservationId: null,
			expiresAt: null,
			estimatedChargeMicros: null,
		};
	}

	const stripeAt = Date.now();
	const stripeEnvironment = resolveStripeEnvironment(
		input.env as Parameters<typeof resolveStripeEnvironment>[0],
	);
	stripeMs = Date.now() - stripeAt;
	const reserveAt = Date.now();
	const decision = await reserveBillingUsage(input.db, {
		id: input.execution?.billingReservationId ?? crypto.randomUUID(),
		execution: input.execution,
		executionGuard: input.executionGuard,
		organizationId: input.request.organizationId,
		tediId: input.request.tediId,
		source: input.request.source,
		provider: input.request.provider,
		model: input.request.model,
		estimatedInputTokens: input.request.estimatedInputTokens,
		estimatedOutputTokens: input.request.estimatedOutputTokens,
		runId: input.request.runId,
		traceId: input.request.traceId,
		idempotencyKey: input.request.idempotencyKey,
		expiresAt:
			input.execution?.sendBefore ??
			new Date(nowMs + 10 * 60 * 1_000).toISOString(),
		metadata:
			input.request.metadata === undefined
				? undefined
				: toJsonRecord(input.request.metadata),
		now: new Date(nowMs).toISOString(),
		stripeEnvironment,
		aiGatewayLimits: aiGatewayReservationLimits(aiGatewayPolicy),
	});
	reserveMs = Date.now() - reserveAt;
	if (!decision.allowed) {
		done(decision.code);
		return { allowed: false, code: decision.code, entitlement };
	}
	done("allowed");
	return {
		allowed: true,
		settlementMode: mode,

		reservationId: decision.reservation.id,
		expiresAt: decision.reservation.expiresAt,
		estimatedChargeMicros: decision.reservation.estimatedChargeMicros,
	};
}

export type RuntimeBudgetDecision =
	| Extract<AuthorizeRuntimeInferenceResponse, { allowed: false }>
	| Omit<
			Extract<AuthorizeRuntimeInferenceResponse, { allowed: true }>,
			"executionId" | "sendBefore" | "attributionVersion"
	  >;
