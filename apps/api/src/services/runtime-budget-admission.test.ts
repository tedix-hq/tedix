import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
	getInferenceAdmissionReads: vi.fn(),
	reserveBillingUsage: vi.fn(),
	resolveStripeEnvironment: vi.fn(() => "test"),
}));

vi.mock("@tedix/db/queries/runtime-entitlements", () => ({
	runtimeEntitlementIsActive: (entitlement: any, nowMs: number) =>
		nowMs >= Date.parse(entitlement.effectivePeriod.startsAt) &&
		nowMs < Date.parse(entitlement.effectivePeriod.endsAt),
}));
vi.mock("@tedix/db/queries/billing/inference-admission", () => ({
	getInferenceAdmissionReads: mocks.getInferenceAdmissionReads,
}));

/** Both reads now arrive together; the checks on them still run in order. */
function admissionReads(
	entitlementValue: unknown,
	policies: unknown,
): { entitlement: unknown; policies: unknown } {
	return { entitlement: entitlementValue, policies };
}
vi.mock("@tedix/db/queries/billing/reservations", () => ({
	reserveBillingUsage: mocks.reserveBillingUsage,
}));
vi.mock("../lib/stripe-environment", () => ({
	resolveStripeEnvironment: mocks.resolveStripeEnvironment,
}));

import { authorizeRuntimeBudget } from "./runtime-budget-admission";

const nowMs = Date.parse("2026-08-02T12:00:00.000Z");
const entitlement = {
	organizationId: "org-1",
	status: "active",
	effectivePeriod: {
		startsAt: "2026-08-01T00:00:00.000Z",
		endsAt: "2026-09-01T00:00:00.000Z",
	},
	profile: { key: "starter", name: "Developer" },
	limits: {
		includedMonthlyTokens: 100_000,
		maxTedis: 1,
		maxCronJobsPerTedi: 5,
		maxIterationsPerTask: 12,
		defaultDailyTokenLimit: 20_000,
		defaultDailyMessageLimit: 50,
	},
	grants: [],
	source: "installation",
	version: 1,
};

function request(settlementMode: "managed" | "external" | "disabled") {
	return {
		organizationId: "org-1",
		settlementMode,
		source: "operator" as const,
		provider: "workers-ai",
		model: "test",
		estimatedInputTokens: 10,
		estimatedOutputTokens: 20,
		idempotencyKey: "inference:test",
	};
}

beforeEach(() => {
	for (const mock of Object.values(mocks)) mock.mockClear();
	mocks.getInferenceAdmissionReads.mockResolvedValue(
		admissionReads(entitlement, {
			organization: { dailyTokenLimit: 20_000 },
			tediFound: true,
		}),
	);
});

describe("runtime entitlement inference admission", () => {
	it.each(["disabled", "external"] as const)(
		"validates active entitlement without commercial reservation in %s mode",
		async (mode) => {
			const result = await authorizeRuntimeBudget({
				db: {} as never,
				env: {
					TEDIX_BILLING_SETTLEMENT_MODE: mode,
					TEDIX_FLEET_AUTHORITY_MODE: "disabled",
				},
				request: request(mode),
				nowMs,
			});
			expect(result).toMatchObject({
				allowed: true,
				settlementMode: mode,
				reservationId: null,
			});
			expect(mocks.reserveBillingUsage).not.toHaveBeenCalled();
			expect(mocks.resolveStripeEnvironment).not.toHaveBeenCalled();
		},
	);

	it("preserves managed budget reservation behavior", async () => {
		mocks.reserveBillingUsage.mockResolvedValue({
			allowed: true,
			reservation: {
				id: "reservation-1",
				expiresAt: "2026-08-02T12:10:00.000Z",
				estimatedChargeMicros: 0,
			},
		});
		const result = await authorizeRuntimeBudget({
			db: {} as never,
			env: { TEDIX_BILLING_SETTLEMENT_MODE: "managed" },
			request: request("managed"),
			nowMs,
		});
		expect(result).toMatchObject({
			allowed: true,
			settlementMode: "managed",
			reservationId: "reservation-1",
		});
		expect(mocks.reserveBillingUsage).toHaveBeenCalledTimes(1);
	});

	it("fails closed on missing or mismatched deployment mode", async () => {
		await expect(
			authorizeRuntimeBudget({
				db: {} as never,
				env: {},
				request: request("disabled"),
				nowMs,
			}),
		).rejects.toThrow(/TEDIX_BILLING_SETTLEMENT_MODE/);
		await expect(
			authorizeRuntimeBudget({
				db: {} as never,
				env: { TEDIX_BILLING_SETTLEMENT_MODE: "managed" },
				request: request("external"),
				nowMs,
			}),
		).rejects.toThrow(/mode mismatch/);
		expect(mocks.reserveBillingUsage).not.toHaveBeenCalled();
	});

	it("denies a model outside the intersected D1 tier boundary", async () => {
		mocks.getInferenceAdmissionReads.mockResolvedValue(
			admissionReads(entitlement, {
				organization: { allowedModelTiers: ["economy"] },
				tediFound: true,
			}),
		);
		const result = await authorizeRuntimeBudget({
			db: {} as never,
			env: { TEDIX_BILLING_SETTLEMENT_MODE: "managed" },
			request: {
				...request("managed"),
				provider: "azure-openai",
				model: "gpt-5.6-sol",
			},
			nowMs,
		});
		expect(result).toMatchObject({
			allowed: false,
			code: "model_tier_not_allowed",
		});
		expect(mocks.reserveBillingUsage).not.toHaveBeenCalled();
	});

	// Hoisting the reads into one batch makes both results available at once. If
	// the policy result were consulted before the entitlement checks, every one
	// of these clean denials would become the `policy_unresolved` throw, which
	// the runtime maps to a billing_service_error — a 500 class where a denial
	// belongs. The batched read returns `policies: null` for an organization
	// with no billing account, which is precisely the shape that would throw.
	it.each([
		[
			"an organization with no billing account",
			null,
			null,
			"entitlement_not_configured",
		],
		[
			"a suspended entitlement",
			{ ...entitlement, status: "suspended" },
			null,
			"entitlement_inactive",
		],
		[
			"an entitlement outside its period",
			{
				...entitlement,
				effectivePeriod: {
					startsAt: "2026-06-01T00:00:00.000Z",
					endsAt: "2026-07-01T00:00:00.000Z",
				},
			},
			null,
			"entitlement_period_inactive",
		],
	])(
		"denies %s rather than failing the policy check",
		async (_case, entitlementValue, policies, code) => {
			mocks.getInferenceAdmissionReads.mockResolvedValue(
				admissionReads(entitlementValue, policies),
			);
			const result = await authorizeRuntimeBudget({
				db: {} as never,
				env: { TEDIX_BILLING_SETTLEMENT_MODE: "managed" },
				request: request("managed"),
				nowMs,
			});
			expect(result).toMatchObject({ allowed: false, code });
			expect(mocks.reserveBillingUsage).not.toHaveBeenCalled();
		},
	);

	it("fails closed when attributed tedi policy cannot be resolved", async () => {
		mocks.getInferenceAdmissionReads.mockResolvedValue(
			admissionReads(entitlement, {
				organization: { dailyTokenLimit: 20_000 },
				tediFound: false,
			}),
		);
		await expect(
			authorizeRuntimeBudget({
				db: {} as never,
				env: { TEDIX_BILLING_SETTLEMENT_MODE: "managed" },
				request: { ...request("managed"), tediId: "missing" },
				nowMs,
			}),
		).rejects.toThrow(/does not resolve in D1/);
	});
});
it("passes the original execution guard and deadline through managed reservation retries", async () => {
	const execution = {
		billingReservationId: "original-reservation",
		sendBefore: "2026-08-02T12:00:30.000Z",
	} as never;
	const guard = { kind: "provider_execution_admission" as const };
	mocks.reserveBillingUsage.mockResolvedValue({
		allowed: true,
		reservation: {
			id: "original-reservation",
			expiresAt: "2026-08-02T12:00:30.000Z",
			estimatedChargeMicros: 0,
		},
	});
	await authorizeRuntimeBudget({
		db: {} as never,
		env: { TEDIX_BILLING_SETTLEMENT_MODE: "managed" },
		request: request("managed"),
		execution,
		executionGuard: guard,
		nowMs,
	});
	expect(mocks.reserveBillingUsage.mock.calls[0][1]).toMatchObject({
		id: "original-reservation",
		execution,
		executionGuard: guard,
		expiresAt: "2026-08-02T12:00:30.000Z",
	});
});
