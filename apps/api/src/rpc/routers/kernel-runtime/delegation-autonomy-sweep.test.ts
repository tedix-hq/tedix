import { createRouterClient } from "@orpc/server";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { BaseContext } from "../../orpc";

const mocks = vi.hoisted(() => ({
	rows: [] as Array<{
		id: string;
		status: string;
		organizationId: string;
		createdAt: string;
		metadata?: unknown;
	}>,
	release: vi.fn(),
	workstation: vi.fn(),
	audit: vi.fn(),
	member: vi.fn(),
}));
vi.mock("@tedix/db/queries/organization-members", () => ({
	getMemberByUserId: mocks.member,
}));
vi.mock("@tedix/db/queries/kernel-runtime-runs", () => ({
	listPendingDelegationRuns: vi.fn(async () =>
		mocks.rows.filter((row) => row.status === "requires_approval"),
	),
}));
vi.mock("@tedix/db/queries/audit", () => ({ insertAuditEvent: mocks.audit }));
vi.mock("./delegation-autonomy-review", () => ({
	reviewDelegationAutonomy: vi.fn(async (_context, run) => ({
		allowed: run.id === "research" || run.id === "workstation",
		workstation: run.id === "workstation",
		reason:
			run.id === "research"
				? "autonomy v1: medium risk"
				: "human-reserved: external_message",
	})),
}));
vi.mock("./approval-control", () => ({
	respondKernelDelegationRecommendationApprovalCore: mocks.release,
}));
vi.mock("./delegation-autonomy-workstation", () => ({
	releaseWorkstationDelegationAutonomy: mocks.workstation,
}));

import { sweepDelegationAutonomyRoute } from "./delegation-autonomy-sweep";

describe("pending delegation policy sweep", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.rows = ["research", "critical"].map((id) => ({
			id,
			status: "requires_approval",
			organizationId: "org",
			createdAt: "2026-10-19T12:00:00.000Z",
		}));
		mocks.member.mockResolvedValue({ role: "owner", status: "active" });
		mocks.release.mockImplementation(async (_context, input) => {
			input.run.status = "queued";
			return {};
		});
	});
	const client = () =>
		createRouterClient(
			{ sweep: sweepDelegationAutonomyRoute },
			{
				context: {
					authType: "service-binding",
					descopeUserId: "owner",
					organizationId: "org",
					headers: new Headers({
						"X-Service-Binding": "true",
						"X-Tedix-Tedi-Scopes": "mcp:tedis.write",
					}),
					env: { ENVIRONMENT: "test" },
					db: {},
					rateLimiter: { limit: async () => ({ success: true }) },
					url: new URL("https://api/rpc/kernelRuntime"),
				} as BaseContext,
			},
		);
	it("releases eligible work once, keeps critical holds, and attributes resolution to policy", async () => {
		const first = await client().sweep({ limit: 10 });
		expect(first.dispatched).toEqual(["research"]);
		expect(first.held).toEqual([
			{ runId: "critical", reason: "human-reserved: external_message" },
		]);
		expect(mocks.release.mock.calls[0][1].resolvedBy).toEqual({
			type: "policy",
			id: "delegation-autonomy.v1",
		});
		const second = await client().sweep({ limit: 10 });
		expect(second.dispatched).toEqual([]);
		expect(mocks.release).toHaveBeenCalledTimes(1);
		expect(mocks.audit).toHaveBeenCalledTimes(2);
	});
	it("retains operator-excluded resources and records the constraint on every sweep", async () => {
		mocks.rows[0].metadata = {
			workOrder: { resourceId: "protected-resource-0001" },
		};
		for (let attempt = 0; attempt < 2; attempt++) {
			const result = await client().sweep({
				limit: 10,
				excludeReferences: ["protected-resource-0001"],
			});
			expect(result.dispatched).toEqual([]);
			expect(result.held).toContainEqual({
				runId: "research",
				reason: "operator-excluded reference",
			});
		}
		expect(mocks.release).not.toHaveBeenCalled();
		expect(mocks.workstation).not.toHaveBeenCalled();
		expect(mocks.rows[0].status).toBe("requires_approval");
		expect(mocks.audit.mock.calls[0][1].metadata.excludeReferences).toEqual([
			"protected-resource-0001",
		]);
	});
	it("rejects a non-owner and retains a hold when the resolution latch fails", async () => {
		mocks.member.mockResolvedValueOnce({ role: "member", status: "active" });
		await expect(client().sweep({ limit: 10 })).rejects.toThrow("owner/admin");
		expect(mocks.release).not.toHaveBeenCalled();
		mocks.release.mockRejectedValueOnce(
			new Error("delegation changed; reload"),
		);
		const result = await client().sweep({ limit: 10 });
		expect(result.dispatched).toEqual([]);
		expect(result.held[0].reason).toContain("changed");
	});
});
