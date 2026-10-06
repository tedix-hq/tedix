/**
 * The kernel's `WorkersAiClient` — the two app-owned seams of
 * `@tedix/workers-ai` bound to this Worker's own policy.
 *
 * The shared transport owns gateway-vs-binding, wire shapes, and tool-call
 * recovery, and branches on nothing app-specific. What it does NOT own, and
 * deliberately requires the caller to supply, is:
 *
 *   - AUTHORIZATION — `reserveKernelBilling`: every paid kernel inference is
 *     admitted and metered against the org's entitlement BEFORE it leaves the
 *     Worker. It throws the canonical `Inference blocked by billing policy:
 *     <code>` marker on a deterministic denial (classified by
 *     `billingPolicyDenialCode`, rethrown by the callers rather than folded
 *     into a provider-outage result).
 *   - ATTRIBUTION — `kernelGatewayMetadata`: the kernel's AI Gateway encoder,
 *     pinned byte-for-byte by `gateway-attribution.golden.test.ts`. It is
 *     applied to the context RETURNED by the reservation, so the minted
 *     reservation id rides along in the `cf-aig-metadata` tag.
 *
 * `kernelGatewayMetadata` always emits a populated record, so every kernel
 * Workers AI call is tagged on both the gateway and the binding path — the
 * behaviour the two deleted app-local transport copies had.
 */

import type { BillingUsageSource } from "@tedix/db/schema/billing";
import type {
	WorkersAiClient,
	WorkersAiTransportEnv,
} from "@tedix/workers-ai/transport";
import { reserveKernelBilling } from "./billing-reservation";
import {
	type KernelGatewayContext,
	kernelGatewayMetadata,
} from "./gateway-attribution";

/** Env the kernel's Workers AI client reads: the transport's, plus D1 for billing. */
export interface KernelWorkersAiEnv extends WorkersAiTransportEnv {
	DB?: D1Database;
	TEDIX_BILLING_SETTLEMENT_MODE?: string;
}

/**
 * Bind one kernel Workers AI client: correlation context in, an authorizer that
 * reserves billing and returns the kernel attribution out.
 *
 * `context` is the immutable per-turn correlation (org, run, work item, session
 * key, source); `billingSource` overrides the financial usage category for
 * non-kernel surfaces that ride the same transport (e.g. MCP evaluation).
 */
export function kernelWorkersAiClient(
	env: KernelWorkersAiEnv,
	context?: KernelGatewayContext | string,
	billingSource?: BillingUsageSource,
): WorkersAiClient {
	return {
		env,
		authorize: async ({ execution, body }) => {
			const reserved = await reserveKernelBilling(env, {
				context,
				execution,
				body,
				source: billingSource,
			});
			return { attribution: kernelGatewayMetadata(reserved) };
		},
	};
}
