import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { BaseContext } from "../rpc/context";
import { reconcileRuns } from "./kernel-run-reconcile";

const state = vi.hoisted(() => ({
	run: {} as Record<string, unknown>,
	submission: {} as Record<string, unknown>,
	observation: {
		readAvailable: false,
		summary: null as Record<string, unknown> | null,
	},
	transition: vi.fn(async () => true),
	settle: vi.fn(async () => undefined),
	read: vi.fn(),
}));

vi.mock("@tedix/db/queries/kernel-do-storage", () => ({
	listKernelRunsByStatus: async () => [],
	getKernelRunForRecovery: async () => state.run,
	transitionKernelRunForRecovery: (...args: unknown[]) =>
		state.transition(...args),
}));
vi.mock("@tedix/db/queries/runtime-submissions/read-models", () => ({
	listStaleRunningSubmissions: async () => [state.submission],
	listPendingReservedSubmissions: async () => [],
}));
vi.mock("./kernel-lazy", async (importOriginal) => ({
	...(await importOriginal<typeof import("./kernel-lazy")>()),
	loadRuntimeSubmissionBridge: async () => ({
		...(await import("./runtime-submission-bridge")),
		settleKernelSubmission: state.settle,
	}),
	loadKernelChildRunReads: async () => ({
		readSingleChildRunObservation: async (...args: unknown[]) => {
			state.read(...args);
			return state.observation;
		},
	}),
}));

describe("delegated submission recovery observation", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		state.run = {
			id: "parent",
			conversationId: "home:test",
			status: "running",
			delegatedTediId: "tedi-test",
			childRunId: "child",
			updatedAt: "2000-01-01T00:00:00.000Z",
			metadata: {},
		};
		state.submission = {
			id: "submission",
			subjectKind: "kernel",
			runId: "parent",
			conversationId: "home:test",
			currentAttemptId: "attempt",
			updatedAt: "2000-01-01T00:00:00.000Z",
			abortRequestedAt: null,
		};
		state.observation = { readAvailable: false, summary: null };
	});
	async function sweep() {
		await reconcileRuns(
			{
				turnContext: async () => ({ db: {} }) as BaseContext,
				schedule: vi.fn(),
				ensureReconciliationSchedule: vi.fn(),
			},
			{ organizationId: "org-test" },
		);
	}
	it("does not fail or settle a delegated parent while its child ledger is unavailable", async () => {
		await sweep();
		expect(state.read).toHaveBeenCalledWith(expect.anything(), {
			organizationId: "org-test",
			tediId: "tedi-test",
			runId: "child",
		});
		expect(state.transition).not.toHaveBeenCalled();
		expect(state.settle).not.toHaveBeenCalled();
		state.observation.readAvailable = true;
		await sweep();
		expect(state.transition).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({
				patch: expect.objectContaining({ status: "failed" }),
			}),
		);
		expect(state.settle).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({ outcome: "failed" }),
		);
	});
	it("honors operator abort despite an unavailable child ledger", async () => {
		state.submission.abortRequestedAt = "2026-01-01T00:00:00.000Z";
		await sweep();
		expect(state.transition).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({
				patch: expect.objectContaining({ status: "canceled" }),
			}),
		);
		expect(state.settle).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({ outcome: "canceled", attemptId: "attempt" }),
		);
	});
	it("settles an already completed parent despite an unavailable ledger", async () => {
		state.run.status = "completed";
		await sweep();
		expect(state.read).not.toHaveBeenCalled();
		expect(state.transition).not.toHaveBeenCalled();
		expect(state.settle).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({ outcome: "settled" }),
		);
	});
	it("uses a real child completion once the ledger recovers", async () => {
		state.observation = {
			readAvailable: true,
			summary: {
				childRunStatus: "completed",
				childRunPreview: "Result verified.",
			},
		};
		await sweep();
		expect(state.transition).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({
				patch: expect.objectContaining({ status: "completed" }),
			}),
		);
		expect(state.settle).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({ outcome: "settled" }),
		);
	});
});
