import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const admitCodeRun = vi.fn();
const walletCalls: { route: string; body: Record<string, unknown> }[] = [];
let walletCharge: Record<string, unknown> = {
	allowed: true,
	replayed: false,
	credits: 1,
};
vi.mock("@tedix/db/queries/billing/credit-pool", () => ({ admitCodeRun }));
vi.mock("@tedix/db/client", () => ({ createDbClient: () => ({}) }));
vi.mock("../billing-wallet", () => ({
	walletStub: () => ({
		fetch: async (url: string, init: { body: string }) => {
			const route = url.split("/").pop()!;
			walletCalls.push({ route, body: JSON.parse(init.body) });
			return Response.json(route === "charge" ? walletCharge : { ok: true });
		},
	}),
}));

const { admitCodeModeRun, codeRunRefusalMessage, executeMeteredCodeMode } =
	await import("./code-run-admission");

const env = {
	DB: {} as D1Database,
	MCP_SUBSCRIPTIONS: {} as DurableObjectNamespace,
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
		walletCalls.length = 0;
		walletCharge = { allowed: true, replayed: false, credits: 1 };
	});
	const input = {
		env,
		organizationId: "org-1",
		executionId: "exec-metered",
		caller: {
			authType: "user" as const,
			userId: "member-1",
			requestWorkItemId: "work-1",
		},
	};
	it("charges the wallet before loading and settles loads even when user code fails", async () => {
		await expect(
			executeMeteredCodeMode({
				...input,
				execute: async (onLoad) => {
					expect(walletCalls).toEqual([
						{
							route: "charge",
							body: {
								organizationId: "org-1",
								eventId: "dynamic-worker:exec-metered",
								tediId: null,
								userId: "member-1",
								// Counts against the Work Item's credit budgets.
								workItemId: "work-1",
								agentSessionId: null,
							},
						},
					]);
					onLoad({ method: "load", identity: "anonymous" });
					onLoad({ method: "get", identity: "named" });
					throw new Error("user code failed");
				},
			}),
		).rejects.toThrow("user code failed");
		expect(walletCalls[1]).toEqual({
			route: "settle",
			body: {
				eventId: "dynamic-worker:exec-metered",
				anonymousLoads: 1,
				namedLoads: 1,
			},
		});
	});
	it("refuses before executing when the wallet refuses", async () => {
		walletCharge = { allowed: false, code: "monthly_credit_limit_reached" };
		const execute = vi.fn();
		await expect(executeMeteredCodeMode({ ...input, execute })).rejects.toThrow(
			"monthly_credit_limit_reached",
		);
		expect(execute).not.toHaveBeenCalled();
	});
});
