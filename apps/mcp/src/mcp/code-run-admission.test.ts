import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const admitCodeRun = vi.fn();
const getCreditPoolSnapshot = vi.fn();
const reserveBillingUsage = vi.fn();
const releaseBillingReservation = vi.fn();
const recordBillingProviderUsage = vi.fn();
const settleBillingUsage = vi.fn();
vi.mock("@tedix/db/queries/billing/reservations", () => ({
	reserveBillingUsage,
	releaseBillingReservation,
}));
vi.mock("@tedix/db/queries/billing/provider-usage", () => ({
	recordBillingProviderUsage,
}));
vi.mock("@tedix/db/queries/billing/settlement", () => ({ settleBillingUsage }));
vi.mock("@tedix/db/queries/billing/credit-pool", () => ({
	admitCodeRun,
	getCreditPoolSnapshot,
}));
vi.mock("@tedix/db/client", () => ({ createDbClient: () => ({}) }));

const { admitCodeModeRun, codeRunRefusalMessage, executeMeteredCodeMode } =
	await import("./code-run-admission");

const env = {
	DB: {} as D1Database,
	TEDIX_BILLING_SETTLEMENT_MODE: "managed",
};

describe("code run admission", () => {
	beforeEach(() => admitCodeRun.mockReset());

	it("charges one credit per execution to the calling member", async () => {
		admitCodeRun.mockResolvedValue({
			allowed: true,
			replayed: false,
			credits: 1,
		});
		await expect(
			admitCodeModeRun({
				env,
				organizationId: "org-1",
				executionId: "exec-1",
				caller: { authType: "user", userId: "user-1" },
				nowMs: Date.parse("2026-11-19T12:00:00.000Z"),
			}),
		).resolves.toEqual({ allowed: true });
		expect(admitCodeRun).toHaveBeenCalledWith(expect.anything(), {
			organizationId: "org-1",
			executionId: "exec-1",
			tediId: null,
			userId: "user-1",
			credits: 1,
			now: "2026-11-19T12:00:00.000Z",
		});
	});

	it("attributes a tedi caller to the tedi, not a member", async () => {
		admitCodeRun.mockResolvedValue({
			allowed: true,
			replayed: true,
			credits: 1,
		});
		await admitCodeModeRun({
			env,
			organizationId: "org-1",
			executionId: "exec-2",
			caller: { authType: "tedi", tediId: "tedi-1", userId: "owner-1" },
		});
		expect(admitCodeRun.mock.calls[0]![1]).toMatchObject({
			tediId: "tedi-1",
			userId: null,
		});
	});

	it("refuses with the pool's reason and never starts the run", async () => {
		admitCodeRun.mockResolvedValue({
			allowed: false,
			code: "monthly_credit_limit_reached",
		});
		await expect(
			admitCodeModeRun({
				env,
				organizationId: "org-1",
				executionId: "exec-3",
				caller: { authType: "user", userId: "user-1" },
			}),
		).resolves.toEqual({
			allowed: false,
			code: "monthly_credit_limit_reached",
			message: codeRunRefusalMessage("monthly_credit_limit_reached"),
		});
	});

	it("fails closed without an organization or database", async () => {
		await expect(
			admitCodeModeRun({
				env: { TEDIX_BILLING_SETTLEMENT_MODE: "managed" },
				organizationId: "org-1",
				executionId: "exec-4",
				caller: undefined,
			}),
		).resolves.toMatchObject({
			allowed: false,
			code: "billing_not_configured",
		});
		await expect(
			admitCodeModeRun({
				env,
				organizationId: null,
				executionId: "exec-5",
				caller: undefined,
			}),
		).resolves.toMatchObject({
			allowed: false,
			code: "billing_not_configured",
		});
		expect(admitCodeRun).not.toHaveBeenCalled();
	});

	it("starts runs without admission when the installation does not settle billing", async () => {
		for (const mode of ["external", "disabled"]) {
			await expect(
				admitCodeModeRun({
					// A self-hosted installation may have no billing account at all.
					env: { TEDIX_BILLING_SETTLEMENT_MODE: mode },
					organizationId: null,
					executionId: `exec-${mode}`,
					caller: undefined,
				}),
			).resolves.toEqual({ allowed: true });
		}
		expect(admitCodeRun).not.toHaveBeenCalled();
	});

	it("fails closed when the settlement mode is missing or unknown", async () => {
		for (const mode of [undefined, "", "configured-via-private-overlay"]) {
			await expect(
				admitCodeModeRun({
					env: { DB: env.DB, TEDIX_BILLING_SETTLEMENT_MODE: mode },
					organizationId: "org-1",
					executionId: "exec-6",
					caller: { authType: "user", userId: "user-1" },
				}),
			).resolves.toMatchObject({
				allowed: false,
				code: "billing_settlement_mode_missing",
			});
		}
		expect(admitCodeRun).not.toHaveBeenCalled();
	});
});

describe("Code Mode load billing", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		getCreditPoolSnapshot.mockResolvedValue({
			creditFx: { microUsdPerEur: 1_000_000 },
		});
		reserveBillingUsage.mockResolvedValue({
			allowed: true,
			reservation: { id: "reservation-1" },
		});
	});
	const input = {
		env,
		organizationId: "org-1",
		executionId: "exec-metered",
		timeoutMs: 330_000,
		caller: { authType: "user" as const, userId: "member-1" },
	};
	it("reserves before loading and settles a loaded Worker even when user code fails", async () => {
		await expect(
			executeMeteredCodeMode({
				...input,
				execute: async (onLoad) => {
					expect(reserveBillingUsage).toHaveBeenCalledWith(
						expect.anything(),
						expect.objectContaining({
							organizationId: "org-1",
							userId: "member-1",
							credits: 1,
							estimatedInputTokens: 0,
						}),
					);
					onLoad({ method: "load", identity: "anonymous" });
					throw new Error("user code failed");
				},
			}),
		).rejects.toThrow("user code failed");
		expect(recordBillingProviderUsage).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({
				organizationId: "org-1",
				reservationId: "reservation-1",
				quantity: 1,
				providerCostMicros: 2000,
				metadata: {
					surface: "gateway_model_code",
					identity: "anonymous",
					method: "load",
				},
			}),
		);
		expect(settleBillingUsage).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({
				provider: "cloudflare-dynamic-workers",
				providerCostMicros: 2000,
				inputTokens: 0,
				outputTokens: 0,
			}),
		);
		expect(releaseBillingReservation).not.toHaveBeenCalled();
	});
	it("releases without charging when the SDK starts no Worker", async () => {
		await executeMeteredCodeMode({ ...input, execute: async () => "no load" });
		expect(releaseBillingReservation).toHaveBeenCalled();
		expect(recordBillingProviderUsage).not.toHaveBeenCalled();
		expect(settleBillingUsage).not.toHaveBeenCalled();
	});
	it("refuses before executing when credits are exhausted", async () => {
		reserveBillingUsage.mockResolvedValue({
			allowed: false,
			code: "monthly_credit_limit_reached",
		});
		const execute = vi.fn();
		await expect(executeMeteredCodeMode({ ...input, execute })).rejects.toThrow(
			"monthly_credit_limit_reached",
		);
		expect(execute).not.toHaveBeenCalled();
	});
});
