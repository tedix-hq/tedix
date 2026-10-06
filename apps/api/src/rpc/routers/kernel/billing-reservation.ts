import type { ProviderExecutionIdentity } from "@tedix/api-contract/schemas/provider-execution";
import { createDbClient } from "@tedix/db/client";
import type { AuthorizeRuntimeInferenceInput } from "@tedix/api-contract/schemas/runtime-entitlements";
import {
	AuthorizeRuntimeInferenceResponseSchema,
	RuntimeEntitlementDenialCodeSchema,
} from "@tedix/api-contract/schemas/runtime-entitlements";
import type { z } from "zod";
import { resolveBillingSettlementMode } from "../../../lib/billing-settlement-mode";
import { authorizeRuntimeInference } from "../../../services/runtime-entitlement-admission";
import type { KernelGatewayContext } from "./gateway-attribution";

/**
 * Canonical policy-denial marker. `billingPolicyDenialCode` in
 * apps/tedi-runtime/src/billing-reservation-client.ts classifies exactly this
 * prefix as a deterministic denial; {@link billingPolicyDenialCode} below is
 * the apps/api mirror of that classification. Any other error shape is a
 * retryable transport failure.
 */
export const BILLING_POLICY_DENIED_MESSAGE =
	"Inference blocked by billing policy: ";

export type BillingPolicyDenialCode = z.infer<
	typeof RuntimeEntitlementDenialCodeSchema
>;

/**
 * Classify an error as a deterministic billing/entitlement admission denial.
 *
 * MIRROR of `billingPolicyDenialCode` in
 * apps/tedi-runtime/src/billing-reservation-client.ts (same prefix, same code
 * extraction) — do not invent a second classification. The code allowlist is
 * the canonical `RuntimeEntitlementDenialCodeSchema` enum, so a new admission
 * denial code classifies here the moment the contract learns it.
 *
 * Returns the denial code, or `null` for anything that is not a policy denial
 * (those stay classified as retryable provider/transport failures).
 */
export function billingPolicyDenialCode(
	error: unknown,
): BillingPolicyDenialCode | null {
	const message =
		error instanceof Error
			? error.message
			: error &&
				  typeof error === "object" &&
				  typeof (error as { message?: unknown }).message === "string"
				? (error as { message: string }).message
				: String(error);
	const marker = message.indexOf(BILLING_POLICY_DENIED_MESSAGE);
	if (marker === -1) return null;
	const candidate = message
		.slice(marker + BILLING_POLICY_DENIED_MESSAGE.length)
		.match(/^[a-z_]+/)?.[0];
	const parsed = RuntimeEntitlementDenialCodeSchema.safeParse(candidate);
	return parsed.success ? parsed.data : null;
}

function estimate(body: BodyInit | null | undefined): {
	input: number;
	output: number;
} {
	if (typeof body !== "string") return { input: 1, output: 4_096 };
	let output = 4_096;
	try {
		const parsed = JSON.parse(body) as Record<string, unknown>;
		const requested =
			parsed.max_completion_tokens ??
			parsed.max_tokens ??
			parsed.max_output_tokens;
		if (
			typeof requested === "number" &&
			Number.isSafeInteger(requested) &&
			requested > 0
		) {
			output = Math.min(requested, 2_000_000);
		}
	} catch {
		// Byte-derived input estimate remains valid.
	}
	return { input: Math.max(1, Math.ceil(body.length / 3)), output };
}

export async function reserveKernelBilling(
	env:
		| CloudflareEnv
		| { DB?: D1Database; TEDIX_BILLING_SETTLEMENT_MODE?: string },
	input: {
		context: KernelGatewayContext | string | undefined;
		execution: ProviderExecutionIdentity;
		body: BodyInit | null | undefined;
		source?: AuthorizeRuntimeInferenceInput["source"];
		/** Structured providers supply conservative token bounds instead of chat-body heuristics. */
		tokenEstimates?: { input: number; output: number };
	},
): Promise<KernelGatewayContext> {
	const context: KernelGatewayContext =
		typeof input.context === "string"
			? { organizationId: input.context }
			: (input.context ?? {});
	if (!context.organizationId) {
		throw new Error("Kernel paid inference requires organization attribution");
	}
	if (!env.DB) {
		throw new Error("Kernel paid inference requires the canonical D1 binding");
	}
	const tokens = input.tokenEstimates ?? estimate(input.body);
	if (
		[tokens.input, tokens.output].some(
			(value) => !Number.isSafeInteger(value) || value < 1 || value > 2_000_000,
		)
	) {
		throw new Error("Invalid kernel inference token estimates");
	}
	const idempotencyKey = `kernel-inference:${crypto.randomUUID()}`;
	const settlementMode = resolveBillingSettlementMode(env);
	const decision = await authorizeRuntimeInference({
		db: createDbClient(env.DB),
		env,
		plane: "organization_kernel",
		request: {
			organizationId: context.organizationId,
			tediId: context.tediId ?? null,
			settlementMode,
			source: input.source ?? "kernel",
			execution: input.execution,
			workItemId: context.workItemId ?? null,
			estimatedInputTokens: tokens.input,
			estimatedOutputTokens: tokens.output,
			runId: context.runId,
			traceId: context.sessionKey,
			idempotencyKey,
			metadata: { source: context.source ?? "kernel" },
		},
	});
	if (!decision.allowed) {
		// Canonical policy-denial marker (see BILLING_POLICY_DENIED_MESSAGE) —
		// classified as a deterministic denial by billingPolicyDenialCode here and
		// in apps/tedi-runtime/src/billing-reservation-client.ts. Any other shape
		// is treated as a retryable transport failure and re-runs admission on
		// every retry.
		throw new Error(`${BILLING_POLICY_DENIED_MESSAGE}${decision.code}`);
	}
	AuthorizeRuntimeInferenceResponseSchema.parse(decision);
	if (
		decision.settlementMode !== settlementMode ||
		Date.parse(decision.sendBefore) <= Date.now()
	) {
		throw new Error("Invalid or expired kernel execution admission");
	}
	context.executionAttempts?.push({
		identity: input.execution,
		occurredAt: new Date().toISOString(),
		executionId: decision.executionId,
	});
	return {
		...context,
		executionId: decision.executionId,
		billingReservationId: decision.reservationId ?? undefined,
	};
}
