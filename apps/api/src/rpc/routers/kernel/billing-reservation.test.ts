/**
 * Kernel billing admission — denial classification contract.
 *
 * A kernel admission denial must carry the canonical
 * `Inference blocked by billing policy: <code>` marker so the platform
 * classifier (billingPolicyDenialCode in apps/tedi-runtime) treats it as a
 * deterministic policy denial. Any other message shape classifies as a
 * retryable transport failure, which re-runs admission forever and hides the
 * denial from the caller.
 */

import { RuntimeEntitlementDenialCodeSchema } from "@tedix/api-contract/schemas/runtime-entitlements";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
	BILLING_POLICY_DENIED_MESSAGE,
	billingPolicyDenialCode,
	reserveKernelBilling,
} from "./billing-reservation";

const authorizeRuntimeInference = vi.hoisted(() => vi.fn());

vi.mock("@tedix/db/client", () => ({
	createDbClient: () => ({}),
}));
vi.mock("../../../services/runtime-entitlement-admission", () => ({
	authorizeRuntimeInference,
}));

// Mirror of the exact marker billingPolicyDenialCode matches in
// apps/tedi-runtime/src/billing-reservation-client.ts.
const CANONICAL_DENIAL_PREFIX = "Inference blocked by billing policy: ";

const env = {
	DB: {} as D1Database,
	TEDIX_BILLING_SETTLEMENT_MODE: "managed",
};

function input(overrides?: Record<string, unknown>) {
	return {
		context: { organizationId: "org-1", runId: "run-1" },
		execution: {
			provider: "azure-openai",
			requestModel: "gpt-test",
			gatewayAccountId: "account",
			gatewayId: "gateway",
			transportKind: "gateway-https",
			apiKind: "azure-chat",
			providerResource: "resource",
			providerOrigin: "https://resource.openai.azure.com",
			deployment: "gpt-test",
		},
		body: JSON.stringify({ max_tokens: 128 }),
		...overrides,
	};
}

beforeEach(() => {
	authorizeRuntimeInference.mockReset();
});

describe("reserveKernelBilling", () => {
	it("throws the canonical policy-denial marker on admission denial", async () => {
		authorizeRuntimeInference.mockResolvedValue({
			allowed: false,
			code: "hard_spend_limit",
		});
		await expect(reserveKernelBilling(env, input())).rejects.toThrow(
			`${CANONICAL_DENIAL_PREFIX}hard_spend_limit`,
		);
	});

	it("classifies every denial code, not just one", async () => {
		for (const code of ["past_due", "payment_required", "period_expired"]) {
			authorizeRuntimeInference.mockResolvedValue({ allowed: false, code });
			const error = await reserveKernelBilling(env, input()).catch(
				(e: unknown) => e,
			);
			expect(error).toBeInstanceOf(Error);
			expect((error as Error).message.startsWith(CANONICAL_DENIAL_PREFIX)).toBe(
				true,
			);
			expect((error as Error).message.endsWith(code)).toBe(true);
		}
	});

	it("returns the context with the reservation id when admitted", async () => {
		authorizeRuntimeInference.mockResolvedValue({
			allowed: true,
			settlementMode: "managed",
			attributionVersion: 3,
			executionId: "12345678-1234-4123-8123-123456789abc",
			sendBefore: "2099-01-01T00:00:00.000Z",
			expiresAt: "2099-01-01T00:00:00.000Z",
			estimatedChargeMicros: 1,
			reservationId: "res-1",
		});
		const result = await reserveKernelBilling(env, input());
		expect(result.billingReservationId).toBe("res-1");
		expect(authorizeRuntimeInference.mock.calls[0][0].plane).toBe(
			"organization_kernel",
		);
		expect(
			authorizeRuntimeInference.mock.calls[0][0].request,
		).not.toHaveProperty("originToken");
		expect(result.organizationId).toBe("org-1");
	});

	it("fails closed without organization attribution (non-policy shape)", async () => {
		await expect(
			reserveKernelBilling(env, input({ context: undefined })),
		).rejects.toThrow(/organization attribution/);
		expect(authorizeRuntimeInference).not.toHaveBeenCalled();
	});

	it("fails closed without the canonical D1 binding (non-policy shape)", async () => {
		await expect(reserveKernelBilling({}, input())).rejects.toThrow(
			/canonical D1 binding/,
		);
		expect(authorizeRuntimeInference).not.toHaveBeenCalled();
	});

	it("returns immutable v3 execution attribution without a reservation in disabled mode", async () => {
		authorizeRuntimeInference.mockResolvedValue({
			allowed: true,
			settlementMode: "disabled",
			attributionVersion: 3,
			executionId: "12345678-1234-4123-8123-123456789abc",
			sendBefore: "2099-01-01T00:00:00.000Z",
			expiresAt: null,
			estimatedChargeMicros: null,
			reservationId: null,
		});
		const result = await reserveKernelBilling(
			{ ...env, TEDIX_BILLING_SETTLEMENT_MODE: "disabled" },
			input({
				context: {
					organizationId: "org-1",
					billingReservationId: "stale-caller-reservation",
					executionId: "stale-caller-execution",
				},
			}),
		);
		expect(result.executionId).toBe("12345678-1234-4123-8123-123456789abc");
		expect(result.billingReservationId).toBeUndefined();
	});

	it.each([
		{ attributionVersion: 1 },
		{ executionId: undefined },
		{ sendBefore: "2000-01-01T00:00:00.000Z" },
		{ settlementMode: "external" },
		{ reservationId: "unexpected" },
	])(
		"rejects malformed allowed decisions before recording a send: %j",
		async (invalid) => {
			authorizeRuntimeInference.mockResolvedValue({
				allowed: true,
				settlementMode: "disabled",
				attributionVersion: 3,
				executionId: "12345678-1234-4123-8123-123456789abc",
				sendBefore: "2099-01-01T00:00:00.000Z",
				expiresAt: null,
				estimatedChargeMicros: null,
				reservationId: null,
				...invalid,
			});
			const executionAttempts: unknown[] = [];
			await expect(
				reserveKernelBilling(
					{ ...env, TEDIX_BILLING_SETTLEMENT_MODE: "disabled" },
					input({ context: { organizationId: "org-1", executionAttempts } }),
				),
			).rejects.toThrow();
			expect(executionAttempts).toEqual([]);
		},
	);

	it("fails closed when settlement mode is missing", async () => {
		await expect(
			reserveKernelBilling({ DB: {} as D1Database }, input()),
		).rejects.toThrow(/TEDIX_BILLING_SETTLEMENT_MODE/);
		expect(authorizeRuntimeInference).not.toHaveBeenCalled();
	});
});

describe("billingPolicyDenialCode", () => {
	it("round-trips the thrown admission denial back to its code", async () => {
		authorizeRuntimeInference.mockResolvedValue({
			allowed: false,
			code: "entitlement_inactive",
		});
		const error = await reserveKernelBilling(env, input()).catch(
			(e: unknown) => e,
		);
		expect(billingPolicyDenialCode(error)).toBe("entitlement_inactive");
	});

	it("classifies every canonical denial code from the contract enum", () => {
		for (const code of RuntimeEntitlementDenialCodeSchema.options) {
			expect(
				billingPolicyDenialCode(
					new Error(`${BILLING_POLICY_DENIED_MESSAGE}${code}`),
				),
			).toBe(code);
		}
	});

	it("returns null for provider/transport failures and unknown codes", () => {
		expect(
			billingPolicyDenialCode(new Error("Azure 500 — upstream failure")),
		).toBeNull();
		expect(
			billingPolicyDenialCode(
				new Error(`${BILLING_POLICY_DENIED_MESSAGE}not_a_real_code`),
			),
		).toBeNull();
		expect(billingPolicyDenialCode(null)).toBeNull();
		expect(billingPolicyDenialCode(undefined)).toBeNull();
	});
});

describe("structured inference token bounds", () => {
	it("uses explicit conservative estimates instead of chat body heuristics", async () => {
		authorizeRuntimeInference.mockResolvedValue({
			allowed: false,
			code: "hard_spend_limit",
		});
		await expect(
			reserveKernelBilling(
				env,
				input({
					body: '{"state":"汉字"}',
					tokenEstimates: { input: 9000, output: 2176 },
				}),
			),
		).rejects.toThrow("hard_spend_limit");
		expect(authorizeRuntimeInference).toHaveBeenCalledWith(
			expect.objectContaining({
				request: expect.objectContaining({
					estimatedInputTokens: 9000,
					estimatedOutputTokens: 2176,
				}),
			}),
		);
	});
	it.each([
		{ input: 0, output: 1 },
		{ input: 1, output: -1 },
		{ input: NaN, output: 1 },
		{ input: 1.5, output: 1 },
		{ input: 1, output: 2_000_001 },
	])(
		"rejects invalid explicit estimates before admission: %j",
		async (tokenEstimates) => {
			await expect(
				reserveKernelBilling(env, input({ tokenEstimates })),
			).rejects.toThrow("Invalid kernel inference token estimates");
			expect(authorizeRuntimeInference).not.toHaveBeenCalled();
		},
	);
});
