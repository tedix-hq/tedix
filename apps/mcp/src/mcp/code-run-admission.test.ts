import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const admitCodeRun = vi.fn();
vi.mock("@tedix/db/queries/billing/credit-pool", () => ({ admitCodeRun }));
vi.mock("@tedix/db/client", () => ({ createDbClient: () => ({}) }));

const { admitCodeModeRun, codeRunRefusalMessage } =
	await import("./code-run-admission");

const env = { DB: {} as D1Database };

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
				env: {},
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
});
