import type {
	HomeChildRunEvidence,
	HomePlan,
	HomePlanAssignment,
} from "@tedix/api-contract/schemas/kernel-runtime";
import type { kernelRuntimeRuns } from "@tedix/db/schema";
import { describe, expect, it } from "vite-plus/test";
import {
	approvedHomePlanStatus,
	homeRunStatusFromPlanStatus,
	planAssignmentStatusFromChildStatus,
	readOptionalHomePlanFromRun,
	workItemStatusFromPlanAssignmentStatus,
} from "./home-plan";

type RunRow = typeof kernelRuntimeRuns.$inferSelect;

function makeAssignment(
	overrides: Partial<HomePlanAssignment> = {},
): HomePlanAssignment {
	return {
		id: "assignment-1",
		ownerTediId: "tedi-cto",
		ownerLabel: "CTO",
		routeKind: "agent",
		objective: "ship the thing",
		expectedEvidence: [],
		risk: "low",
		confidence: 0.9,
		requiresApproval: true,
		required: true,
		status: "proposed",
		...overrides,
	};
}

function makePlan(overrides: Partial<HomePlan> = {}): HomePlan {
	return {
		id: "plan-1",
		status: "proposed",
		summary: "a plan",
		source: "kernelRuntime.plan.v0",
		createdAt: "2026-07-01T00:00:00.000Z",
		assignments: [],
		attentionRoutes: [],
		dependencies: [],
		...overrides,
	};
}

function makeRunRow(overrides: Partial<RunRow> = {}): RunRow {
	const now = "2026-07-01T00:00:00.000Z";
	return {
		id: "run-1",
		organizationId: "org-1",
		conversationId: "home:main",
		status: "running",
		startedAt: now,
		updatedAt: now,
		createdAt: now,
		metadata: {},
		runtimeMetadata: {},
		...overrides,
	} as unknown as RunRow;
}

describe("approvedHomePlanStatus", () => {
	it("returns failed when any assignment failed (wins over everything)", () => {
		expect(
			approvedHomePlanStatus(
				makePlan({
					assignments: [
						makeAssignment({ status: "failed" }),
						makeAssignment({ status: "completed" }),
					],
				}),
			),
		).toBe("failed");
	});

	it("allows optional branch failures once every branch is terminal", () => {
		expect(
			approvedHomePlanStatus(
				makePlan({
					assignments: [
						makeAssignment({ status: "completed", required: true }),
						makeAssignment({ status: "failed", required: false }),
					],
				}),
			),
		).toBe("completed");
	});

	it("fails when a required branch is canceled", () => {
		expect(
			approvedHomePlanStatus(
				makePlan({
					assignments: [makeAssignment({ status: "canceled", required: true })],
				}),
			),
		).toBe("failed");
	});

	it("waits for active sibling branches before settling a required failure", () => {
		expect(
			approvedHomePlanStatus(
				makePlan({
					assignments: [
						makeAssignment({ status: "failed", required: true }),
						makeAssignment({ status: "running", required: true }),
					],
				}),
			),
		).toBe("dispatching");
	});

	it("returns dispatching when any assignment is queued or running", () => {
		expect(
			approvedHomePlanStatus(
				makePlan({
					assignments: [
						makeAssignment({ status: "running" }),
						makeAssignment({ status: "completed" }),
					],
				}),
			),
		).toBe("dispatching");
		expect(
			approvedHomePlanStatus(
				makePlan({ assignments: [makeAssignment({ status: "queued" })] }),
			),
		).toBe("dispatching");
	});

	it("returns completed only when every assignment completed", () => {
		expect(
			approvedHomePlanStatus(
				makePlan({
					assignments: [
						makeAssignment({ status: "completed" }),
						makeAssignment({ status: "completed" }),
					],
				}),
			),
		).toBe("completed");
	});

	it("returns approved when some approved/completed but not all completed", () => {
		expect(
			approvedHomePlanStatus(
				makePlan({
					assignments: [
						makeAssignment({ status: "approved" }),
						makeAssignment({ status: "proposed" }),
					],
				}),
			),
		).toBe("approved");
		expect(
			approvedHomePlanStatus(
				makePlan({
					assignments: [
						makeAssignment({ status: "completed" }),
						makeAssignment({ status: "proposed" }),
					],
				}),
			),
		).toBe("approved");
	});

	it("returns proposed for an empty or all-proposed plan", () => {
		expect(approvedHomePlanStatus(makePlan({ assignments: [] }))).toBe(
			"proposed",
		);
		expect(
			approvedHomePlanStatus(
				makePlan({ assignments: [makeAssignment({ status: "proposed" })] }),
			),
		).toBe("proposed");
	});
});

describe("homeRunStatusFromPlanStatus", () => {
	it("maps every plan status to its run status", () => {
		expect(homeRunStatusFromPlanStatus("completed")).toBe("completed");
		expect(homeRunStatusFromPlanStatus("failed")).toBe("failed");
		expect(homeRunStatusFromPlanStatus("canceled")).toBe("canceled");
		expect(homeRunStatusFromPlanStatus("dispatching")).toBe("running");
		expect(homeRunStatusFromPlanStatus("proposed")).toBe("requires_approval");
		expect(homeRunStatusFromPlanStatus("approved")).toBe("queued");
	});
});

describe("planAssignmentStatusFromChildStatus", () => {
	it("maps terminal child statuses through unchanged", () => {
		expect(planAssignmentStatusFromChildStatus("completed")).toBe("completed");
		expect(planAssignmentStatusFromChildStatus("failed")).toBe("failed");
		expect(planAssignmentStatusFromChildStatus("canceled")).toBe("canceled");
	});

	it("collapses active child statuses to running", () => {
		const active: Array<HomeChildRunEvidence["status"]> = [
			"running",
			"streaming",
			"requires_approval",
		];
		for (const status of active) {
			expect(planAssignmentStatusFromChildStatus(status)).toBe("running");
		}
	});

	it("keeps queued as queued", () => {
		expect(planAssignmentStatusFromChildStatus("queued")).toBe("queued");
	});
});

describe("workItemStatusFromPlanAssignmentStatus", () => {
	it("maps each assignment status to its work-item status", () => {
		expect(workItemStatusFromPlanAssignmentStatus("completed")).toBe("done");
		expect(workItemStatusFromPlanAssignmentStatus("failed")).toBe("blocked");
		expect(workItemStatusFromPlanAssignmentStatus("canceled")).toBe(
			"cancelled",
		);
		expect(workItemStatusFromPlanAssignmentStatus("running")).toBe(
			"in_progress",
		);
		expect(workItemStatusFromPlanAssignmentStatus("queued")).toBe("accepted");
		expect(workItemStatusFromPlanAssignmentStatus("approved")).toBe("accepted");
		expect(workItemStatusFromPlanAssignmentStatus("proposed")).toBe(
			"candidate",
		);
	});
});

describe("readOptionalHomePlanFromRun", () => {
	it("rejects a persisted Home plan without explicit dependencies", () => {
		const { dependencies: _dependencies, ...incompletePlan } = makePlan();
		expect(
			readOptionalHomePlanFromRun(
				makeRunRow({ metadata: { homePlan: incompletePlan } }),
			),
		).toBeNull();
	});

	it("rejects a persisted homePlan with the unsupported isolate route kind", () => {
		const plan = {
			...makePlan(),
			assignments: [{ ...makeAssignment(), routeKind: "isolate" }],
		};
		const parsed = readOptionalHomePlanFromRun(
			makeRunRow({ metadata: { homePlan: plan } }),
		);
		expect(parsed).toBeNull();
	});

	it("rejects assignments without required", () => {
		const assignment = makeAssignment();
		const { required: _required, ...historicalAssignment } = assignment;
		const parsed = readOptionalHomePlanFromRun(
			makeRunRow({
				metadata: {
					homePlan: makePlan({
						assignments: [historicalAssignment as HomePlanAssignment],
					}),
				},
			}),
		);
		expect(parsed).toBeNull();
	});

	it("returns null when metadata is null", () => {
		expect(
			readOptionalHomePlanFromRun(makeRunRow({ metadata: null })),
		).toBeNull();
	});

	it("returns null when there is no homePlan key", () => {
		expect(
			readOptionalHomePlanFromRun(makeRunRow({ metadata: {} })),
		).toBeNull();
	});

	it("returns null when the persisted homePlan fails schema validation", () => {
		expect(
			readOptionalHomePlanFromRun(
				makeRunRow({ metadata: { homePlan: { id: 42, assignments: "nope" } } }),
			),
		).toBeNull();
	});
});
