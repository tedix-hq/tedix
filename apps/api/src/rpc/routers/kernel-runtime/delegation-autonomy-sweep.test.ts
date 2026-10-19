import { createRouterClient } from "@orpc/server";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { BaseContext } from "../../orpc";

const mocks = vi.hoisted(() => ({
	rows: [] as Array<{
		id: string;
		status: string;
		organizationId: string;
		createdAt: string;
		updatedAt: string;
		metadata?: unknown;
	}>,
	release: vi.fn(),
	workstation: vi.fn(),
	audit: vi.fn(),
	member: vi.fn(),
	transition: vi.fn(),
	event: vi.fn(),
}));
vi.mock("@tedix/db/queries/organization-members", () => ({
	getMemberByUserId: mocks.member,
}));
vi.mock("@tedix/db/queries/kernel-runtime-runs", () => ({
	listPendingDelegationRuns: vi.fn(async () =>
		mocks.rows.filter((row) => row.status === "requires_approval"),
	),
	transitionKernelRuntimeRunStatus: mocks.transition,
}));
vi.mock("@tedix/db/queries/audit", () => ({ insertAuditEvent: mocks.audit }));
vi.mock("./delegation-autonomy-review", () => ({
	reviewDelegationAutonomy: vi.fn(async (_context, run) => ({
		allowed: run.id === "research" || run.id === "workstation",
		workstation: run.id === "workstation",
		executionBlocked: run.id === "blocked",
		reason:
			run.id === "blocked"
				? "capability gap: email.draft"
				: run.id === "research"
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
vi.mock("../kernel/run-store", async (importOriginal) => ({
	...(await importOriginal<typeof import("../kernel/run-store")>()),
	insertKernelRuntimeEvent: mocks.event,
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
			updatedAt: "2026-10-19T12:00:00.000Z",
		}));
		mocks.audit.mockReset().mockResolvedValue(undefined);
		mocks.transition.mockReset().mockImplementation(async (_db, input) => {
			const run = mocks.rows.find((row) => row.id === input.id);
			if (
				!run ||
				run.status !== input.fromStatus ||
				run.updatedAt !== input.expectedUpdatedAt
			)
				return false;
			Object.assign(run, input.patch);
			return true;
		});
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
		expect(mocks.audit).toHaveBeenCalledTimes(4);
		expect(
			mocks.audit.mock.calls.map((call) => call[1].metadata.phase),
		).toEqual(["started", "completed", "started", "completed"]);
		expect(mocks.audit.mock.calls[0][1].metadata.sweepId).toBe(first.sweepId);
		expect(mocks.audit.mock.calls[1][1].metadata.sweepId).toBe(first.sweepId);
		expect(mocks.audit.mock.calls[0][1].metadata.dispatched).toEqual([]);
		expect(mocks.audit.mock.calls[1][1].metadata.dispatched).toEqual([
			"research",
		]);
		expect(second.sweepId).not.toBe(first.sweepId);
	});
	it("defaults to one item so short transports can keep the continuation cursor", async () => {
		const first = await client().sweep({});
		expect(first.dispatched).toEqual(["research"]);
		expect(first.held).toEqual([]);
		expect(first.nextCursor?.id).toBe("research");
	});
	it("closes non-critical execution blockers without dispatch or an approval card", async () => {
		mocks.rows[0].id = "blocked";
		const first = await client().sweep({ limit: 10 });
		expect(first.blocked).toEqual([
			{ runId: "blocked", reason: "capability gap: email.draft" },
		]);
		expect(mocks.rows[0].status).toBe("failed");
		expect(mocks.rows[1].status).toBe("requires_approval");
		expect(mocks.release).not.toHaveBeenCalled();
		expect(mocks.workstation).not.toHaveBeenCalled();
		expect(mocks.event.mock.calls.map((call) => call[1].kind)).toEqual([
			"run.failed",
			"message.completed",
		]);
		expect(mocks.event.mock.calls[1][1].payload.content).toContain(
			"allowed by your approval policy",
		);
		const second = await client().sweep({ limit: 10 });
		expect(second.blocked).toEqual([]);
		expect(mocks.transition).toHaveBeenCalledTimes(1);
	});
	it("preserves a changed execution blocker and stops before an unaudited dispatch", async () => {
		mocks.rows[0].id = "blocked";
		mocks.transition.mockResolvedValueOnce(false);
		const result = await client().sweep({ limit: 10 });
		expect(result.blocked).toEqual([]);
		expect(result.held[0].reason).toContain("changed");
		expect(mocks.event).not.toHaveBeenCalled();
		mocks.rows[0].id = "research";
		mocks.audit.mockRejectedValueOnce(new Error("audit unavailable"));
		await expect(client().sweep({ limit: 10 })).rejects.toThrow(
			"audit unavailable",
		);
		expect(mocks.release).not.toHaveBeenCalled();
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
