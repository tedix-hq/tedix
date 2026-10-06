import type { HomeRunTrace } from "@tedix/api-contract/schemas/kernel-runtime";
import { describe, expect, it } from "vite-plus/test";
import {
	evaluateHomeRunConvergenceHealth,
	isTerminalHomeRunTraceBranchStatus,
} from "./home-run-health";

function trace(overrides: Partial<HomeRunTrace> = {}): HomeRunTrace {
	return {
		version: "home-run-trace.v1",
		organizationId: "org-1",
		conversationId: "home:main",
		homeRunId: "home-1",
		traceBundleId: "bundle-1",
		harnessVersionId: "harness-1",
		status: "completed",
		parentEventIds: ["parent-completed"],
		branches: [],
		wakeReceipts: [],
		synthesis: [],
		latency: {
			parentElapsedMs: 60_000,
			maxWakeQueueMs: null,
			finalWakeToSynthesisMs: null,
		},
		eventIds: { kernel: ["parent-completed"], tedi: [] },
		artifactIds: [],
		complete: true,
		gaps: [],
		assembledAt: "2026-07-12T12:00:00.000Z",
		sources: ["kernel_runtime_events"],
		...overrides,
	};
}

function branch(overrides: Partial<HomeRunTrace["branches"][number]> = {}) {
	return {
		childRunId: "child-1",
		delegatedTediId: "tedi-1",
		workItemId: "work-item-1",
		status: "completed" as const,
		observedRunIds: ["child-1", "runtime-child-1"],
		eventIds: ["child-message", "child-completed"],
		toolEventIds: [],
		workstationEventIds: [],
		artifactIds: [],
		finalMessageEventId: "child-message",
		terminalEventId: "child-completed",
		latestEventAt: "2026-07-12T11:59:00.000Z",
		evidenceAvailable: true,
		truncated: false,
		...overrides,
	};
}

describe("evaluateHomeRunConvergenceHealth", () => {
	it("uses one terminal-status definition for partial and final outcomes", () => {
		expect(isTerminalHomeRunTraceBranchStatus("partial")).toBe(true);
		expect(isTerminalHomeRunTraceBranchStatus("completed")).toBe(true);
		expect(isTerminalHomeRunTraceBranchStatus("failed")).toBe(true);
		expect(isTerminalHomeRunTraceBranchStatus("canceled")).toBe(true);
		expect(isTerminalHomeRunTraceBranchStatus("running")).toBe(false);
	});

	it("accepts a fully converged terminal branch", () => {
		const result = evaluateHomeRunConvergenceHealth({
			trace: trace({
				branches: [branch()],
				wakeReceipts: [
					{
						id: "wake-1",
						childRunId: "child-1",
						childStatus: "completed",
						queuedAt: "2026-07-12T11:59:00.000Z",
						ackedAt: "2026-07-12T11:59:30.000Z",
						queueLatencyMs: 30_000,
					},
				],
				synthesis: [
					{
						runId: "wake-run-1",
						eventId: "synthesis-1",
						childRunIds: ["child-1"],
						contentPreview: "Done",
						createdAt: "2026-07-12T12:00:00.000Z",
					},
				],
			}),
			workstationReferences: [{ id: "lease-1", childRunId: "runtime-child-1" }],
		});

		expect(result).toEqual({
			status: "healthy",
			findings: [],
			counts: { errors: 0, warnings: 0 },
		});
	});

	it("finds a terminal child without a wake and missing or truncated evidence", () => {
		const result = evaluateHomeRunConvergenceHealth({
			trace: trace({
				branches: [
					branch({
						evidenceAvailable: false,
						eventIds: [],
						terminalEventId: null,
						truncated: true,
					}),
				],
			}),
		});

		expect(result.status).toBe("unhealthy");
		expect(result.findings.map((finding) => finding.code)).toEqual([
			"terminal_child_without_wake",
			"child_evidence_missing",
			"child_evidence_truncated",
		]);
		expect(result.counts).toEqual({ errors: 2, warnings: 1 });
	});

	it("treats a partial child as terminal for wake integrity", () => {
		const result = evaluateHomeRunConvergenceHealth({
			trace: trace({
				branches: [branch({ status: "partial" })],
			}),
		});
		expect(result.findings.map((finding) => finding.code)).toContain(
			"terminal_child_without_wake",
		);
	});

	it("finds acknowledged wakes without synthesis and repeated synthesis failure", () => {
		const result = evaluateHomeRunConvergenceHealth({
			trace: trace({
				branches: [branch(), branch({ childRunId: "child-2" })],
				wakeReceipts: ["child-1", "child-2"].map((childRunId) => ({
					id: `wake-${childRunId}`,
					childRunId,
					childStatus: "completed",
					queuedAt: "2026-07-12T11:59:00.000Z",
					ackedAt: "2026-07-12T11:59:30.000Z",
				})),
			}),
		});

		expect(result.findings.map((finding) => finding.code)).toEqual([
			"acknowledged_wake_without_synthesis",
			"acknowledged_wake_without_synthesis",
			"repeated_synthesis_failures",
		]);
	});

	it("accepts an acknowledged branch wake while another required branch is active", () => {
		const result = evaluateHomeRunConvergenceHealth({
			trace: trace({
				status: "running",
				branches: [
					branch({ childRunId: "completed-child" }),
					branch({ childRunId: "active-child", status: "running" }),
				],
				wakeReceipts: [
					{
						id: "wake-completed-child",
						childRunId: "completed-child",
						childStatus: "completed",
						queuedAt: "2026-07-12T11:59:00.000Z",
						ackedAt: "2026-07-12T11:59:05.000Z",
					},
				],
			}),
		});

		expect(result).toEqual({
			status: "healthy",
			findings: [],
			counts: { errors: 0, warnings: 0 },
		});
	});

	it("accepts canceled parent and child branches without a wake or synthesis", () => {
		const result = evaluateHomeRunConvergenceHealth({
			trace: trace({
				status: "canceled",
				branches: [branch({ status: "canceled" })],
			}),
		});

		expect(result).toEqual({
			status: "healthy",
			findings: [],
			counts: { errors: 0, warnings: 0 },
		});
	});

	it("finds a completed parent with an active required child only", () => {
		const result = evaluateHomeRunConvergenceHealth({
			trace: trace({
				branches: [
					branch({ childRunId: "required", status: "running" }),
					branch({ childRunId: "optional", status: "running" }),
				],
			}),
			requiredChildRunIds: ["required"],
		});

		expect(
			result.findings.filter(
				(finding) =>
					finding.code === "parent_completed_with_required_child_active",
			),
		).toEqual([expect.objectContaining({ childRunId: "required" })]);
	});

	it("joins workstation references by observed run id or Work Item", () => {
		const result = evaluateHomeRunConvergenceHealth({
			trace: trace({ branches: [branch()] }),
			workstationReferences: [
				{ id: "by-run", childRunId: "runtime-child-1" },
				{ id: "by-work-item", workItemId: "work-item-1" },
				{ id: "orphan", childRunId: "missing", workItemId: "missing" },
			],
		});

		expect(
			result.findings.filter(
				(finding) => finding.code === "orphaned_workstation_reference",
			),
		).toEqual([
			expect.objectContaining({ referenceId: "orphan", childRunId: "missing" }),
		]);
	});

	it("flags persisted repeated synthesis and redrive failures at a configurable floor", () => {
		const result = evaluateHomeRunConvergenceHealth({
			trace: trace(),
			synthesisFailureCount: 3,
			redriveCount: 4,
			repeatedFailureThreshold: 3,
		});

		expect(result.findings.map((finding) => finding.code)).toEqual([
			"repeated_synthesis_failures",
			"repeated_redrive_failures",
		]);
	});

	it("treats one retry as healthy and clamps thresholds below two", () => {
		const result = evaluateHomeRunConvergenceHealth({
			trace: trace(),
			synthesisFailureCount: 1,
			redriveCount: 1,
			repeatedFailureThreshold: 1,
		});

		expect(result.status).toBe("healthy");
	});
});
