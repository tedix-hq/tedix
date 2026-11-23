import {
	modelCatalogEntry,
	modelCatalogConfig,
} from "@tedix/api-contract/test/model-catalog";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
	getInferenceAdmissionReads: vi.fn(),
	estimateAiCredits: vi.fn(),
	insertExecution: vi.fn(),
	wallet: vi.fn(),
	resolveStripeEnvironment: vi.fn(() => "test"),
}));

vi.mock("@tedix/db/queries/model-catalog", () => ({
	getModelCatalogConfig: async () =>
		modelCatalogConfig([
			modelCatalogEntry("workers-ai/test"),
			modelCatalogEntry("azure-openai/gpt-5.6-sol", { tier: "balanced" }),
		]),
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
	estimateAiCredits: mocks.estimateAiCredits,
	// Managed admission reads rates first and applies the plan's FX rate after.
	prepareAiCreditEstimate: async (db: unknown) => (creditFx: unknown) =>
		mocks.estimateAiCredits(db, { creditFx }),
}));
vi.mock("@tedix/db/queries/provider-executions", () => ({
	buildProviderExecutionInsertStatement: mocks.insertExecution,
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
		maxTedis: 1,
		maxCronJobsPerTedi: 5,
		maxIterationsPerTask: 12,
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

const plan = { id: "plan-1", creditFx: { microUsdPerEur: 1 } };
/** Managed admission talks to the organization wallet over this binding. */
const managedEnv = {
	TEDIX_BILLING_SETTLEMENT_MODE: "managed",
	MCP_SERVICE: { wallet: mocks.wallet },
};

beforeEach(() => {
	for (const mock of Object.values(mocks)) mock.mockReset();
	mocks.resolveStripeEnvironment.mockReturnValue("test");
	mocks.getInferenceAdmissionReads.mockResolvedValue({
		...admissionReads(entitlement, {
			organization: { dailyTokenLimit: 20_000 },
			tediFound: true,
		}),
		reservationPreflight: { existing: undefined, plan },
	});
	mocks.estimateAiCredits.mockReturnValue(3);
	mocks.insertExecution.mockResolvedValue({ meta: { changes: 1 } });
	mocks.wallet.mockImplementation(
		async (_org: string, route: string, body: any) =>
			route === "hold"
				? {
						allowed: true,
						holdId: body.holdId,
						credits: body.credits,
						expiresAt: body.expiresAt,
						replayed: false,
					}
				: { released: true },
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
			expect(mocks.wallet).not.toHaveBeenCalled();
			expect(mocks.resolveStripeEnvironment).not.toHaveBeenCalled();
		},
	);

	it.each([
		["a member started the turn", "user-1", "user-1"],
		["no member (scheduled or autonomous)", undefined, null],
	] as const)(
		"holds plan-priced credits for the tedi and member when %s",
		async (_label, userId, expected) => {
			const result = await authorizeRuntimeBudget({
				db: {} as never,
				env: managedEnv,
				request: {
					...request("managed"),
					tediId: "tedi-1",
					...(userId ? { userId } : {}),
				},
				nowMs,
			});
			expect(mocks.getInferenceAdmissionReads).toHaveBeenCalledWith(
				{},
				"org-1",
				"tedi-1",
				{ idempotencyKey: "inference:test", executionGuard: undefined },
			);
			expect(mocks.estimateAiCredits).toHaveBeenCalledWith(
				{},
				expect.objectContaining({ creditFx: plan.creditFx }),
			);
			const hold = mocks.wallet.mock.calls[0];
			expect(hold).toEqual([
				"org-1",
				"hold",
				{
					organizationId: "org-1",
					holdId: expect.any(String),
					idempotencyKey: "inference:test",
					tediId: "tedi-1",
					userId: expected,
					credits: 3,
					runId: null,
					metadata: undefined,
					expiresAt: "2026-08-02T12:10:00.000Z",
				},
			]);
			expect(result).toEqual({
				allowed: true,
				settlementMode: "managed",
				reservationId: hold[2].holdId,
				expiresAt: "2026-08-02T12:10:00.000Z",
				estimatedCredits: 3,
			});
		},
	);

	it.each([
		"member_monthly_credit_cap_reached",
		"tedi_monthly_credit_cap_reached",
		"monthly_credit_limit_reached",
	] as const)("returns the wallet refusal %s unchanged", async (code) => {
		mocks.wallet.mockResolvedValueOnce({ allowed: false, code });
		const result = await authorizeRuntimeBudget({
			db: {} as never,
			env: managedEnv,
			request: { ...request("managed"), userId: "user-1" },
			execution: { billingReservationId: "hold-1" } as never,
			nowMs,
		});
		expect(result).toMatchObject({ allowed: false, code });
		expect(mocks.insertExecution).not.toHaveBeenCalled();
	});

	it.each([
		["reserved and unexpired", "reserved", "2026-08-02T12:05:00.000Z", true],
		["settled", "settled", "2026-08-02T11:00:00.000Z", true],
		["reserved but expired", "reserved", "2026-08-02T11:00:00.000Z", false],
	] as const)(
		"replays a pre-wallet D1 reservation that is %s without holding again",
		async (_label, status, expiresAt, allowed) => {
			mocks.getInferenceAdmissionReads.mockResolvedValueOnce({
				...admissionReads(entitlement, { organization: {}, tediFound: true }),
				reservationPreflight: {
					existing: { id: "legacy-1", status, expiresAt, credits: 4 },
					plan,
				},
			});
			const result = await authorizeRuntimeBudget({
				db: {} as never,
				env: managedEnv,
				request: request("managed"),
				nowMs,
			});
			expect(result).toMatchObject(
				allowed
					? { allowed: true, reservationId: "legacy-1", estimatedCredits: 4 }
					: { allowed: false, code: "monthly_credit_limit_reached" },
			);
			expect(mocks.wallet).not.toHaveBeenCalled();
		},
	);

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
		expect(mocks.wallet).not.toHaveBeenCalled();
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
		expect(mocks.wallet).not.toHaveBeenCalled();
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
			expect(mocks.wallet).not.toHaveBeenCalled();
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
describe("managed execution fence", () => {
	const execution = {
		billingReservationId: "original-hold",
		sendBefore: "2026-08-02T12:00:30.000Z",
	} as never;
	const guard = { kind: "provider_execution_admission" as const };
	const admit = () =>
		authorizeRuntimeBudget({
			db: {} as never,
			env: managedEnv,
			request: request("managed"),
			execution,
			executionGuard: guard,
			nowMs,
		});

	it("holds under the execution's hold id and deadline, then writes its guarded fence", async () => {
		expect(await admit()).toMatchObject({
			allowed: true,
			reservationId: "original-hold",
			expiresAt: "2026-08-02T12:00:30.000Z",
		});
		expect(mocks.wallet.mock.calls[0][2]).toMatchObject({
			holdId: "original-hold",
			expiresAt: "2026-08-02T12:00:30.000Z",
		});
		expect(mocks.insertExecution).toHaveBeenCalledWith({}, execution, guard);
		expect(mocks.wallet).toHaveBeenCalledTimes(1);
	});

	it("does not fence or release again when the wallet replays an earlier hold", async () => {
		mocks.wallet.mockResolvedValueOnce({
			allowed: true,
			holdId: "earlier-hold",
			credits: 2,
			expiresAt: "2026-08-02T12:00:20.000Z",
			replayed: true,
		});
		expect(await admit()).toMatchObject({
			allowed: true,
			reservationId: "earlier-hold",
		});
		expect(mocks.insertExecution).not.toHaveBeenCalled();
		expect(mocks.wallet).toHaveBeenCalledTimes(1);
	});

	it.each([
		["refuses the fence", () => Promise.resolve({ meta: { changes: 0 } })],
		["throws", () => Promise.reject(new Error("D1 unavailable"))],
	] as const)(
		"releases the hold when the guarded insert %s",
		async (_label, insert) => {
			mocks.insertExecution.mockImplementationOnce(insert);
			await admit().catch(() => undefined);
			expect(mocks.wallet).toHaveBeenLastCalledWith("org-1", "release", {
				holdId: "original-hold",
			});
		},
	);
});

it("refuses an unregistered model before reserving spend even without tier restrictions", async () => {
	const result = await authorizeRuntimeBudget({
		db: {} as never,
		env: { TEDIX_BILLING_SETTLEMENT_MODE: "managed" },
		request: { ...request("managed"), model: "unregistered" },
		nowMs,
	});
	expect(result).toMatchObject({
		allowed: false,
		code: "model_tier_not_allowed",
	});
	expect(mocks.wallet).not.toHaveBeenCalled();
});
