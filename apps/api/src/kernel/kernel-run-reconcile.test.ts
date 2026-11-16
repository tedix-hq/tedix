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
	claim: vi.fn(async () => true),
	startAttempt: vi.fn(async () => ({})),
	schedule: vi.fn(async () => undefined),
	settle: vi.fn(async () => undefined),
	read: vi.fn(),
}));

vi.mock("@tedix/db/queries/kernel-do-storage", () => ({
	listKernelRunsByStatus: async () => [],
	getKernelRunForRecovery: async () => state.run,
	transitionKernelRunForRecovery: (...args: unknown[]) =>
		state.transition(...args),
	claimUnroutedKernelRunForRedrive: (...args: unknown[]) =>
		state.claim(...args),
}));
vi.mock("@tedix/db/queries/runtime-submissions/attempts", () => ({
	startAttempt: (...args: unknown[]) => state.startAttempt(...args),
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

describe("unrouted Home run recovery", () => {
	const redriveInput = {
		organizationId: "org-test",
		conversationId: "home:test",
		runId: "parent",
		userMessageId: "user-message",
		assistantMessageId: "assistant-message",
		content: "Close out the steward work",
	};
	beforeEach(() => {
		vi.clearAllMocks();
		state.claim.mockResolvedValue(true);
		state.observation = { readAvailable: true, summary: null };
		state.run = {
			id: "parent",
			conversationId: "home:test",
			status: "running",
			delegatedTediId: null,
			childRunId: null,
			updatedAt: "2000-01-01T00:00:00.000Z",
			metadata: { kernelRoute: null, redriveInput },
		};
		state.submission = {
			id: "submission",
			subjectKind: "kernel",
			runId: "parent",
			conversationId: "home:test",
			currentAttemptId: "attempt",
			updatedAt: "2000-01-01T00:00:00.000Z",
			abortRequestedAt: null,
			attemptCount: 1,
			maxRetry: 10,
		};
	});
	async function sweep() {
		await reconcileRuns(
			{
				turnContext: async () => ({ db: {} }) as BaseContext,
				schedule: state.schedule,
				ensureReconciliationSchedule: vi.fn(),
			},
			{ organizationId: "org-test" },
		);
	}
	function expectNoRedrive() {
		expect(state.claim).not.toHaveBeenCalled();
		expect(state.startAttempt).not.toHaveBeenCalled();
		expect(state.schedule).not.toHaveBeenCalled();
	}
	function expectFailed() {
		expectNoRedrive();
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
	}

	it("re-drives the same run when the stored route marker is null", async () => {
		await sweep();
		expect(state.claim).toHaveBeenCalledTimes(1);
		expect(state.claim).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({
				id: "parent",
				organizationId: "org-test",
				expectedStatus: "running",
				patch: expect.objectContaining({
					metadata: expect.objectContaining({
						kernelRoute: null,
						redriveCount: 1,
					}),
				}),
			}),
		);
		expect(state.startAttempt).toHaveBeenCalledTimes(1);
		expect(state.startAttempt).toHaveBeenCalledWith(expect.anything(), {
			submissionId: "submission",
			organizationId: "org-test",
			recovered: true,
		});
		expect(state.schedule).toHaveBeenCalledTimes(1);
		expect(state.schedule).toHaveBeenCalledWith(
			0,
			"runPlannerStep",
			expect.objectContaining({
				...redriveInput,
				runRowMetadata: expect.objectContaining({ redriveCount: 1 }),
			}),
		);
		expect(state.transition).not.toHaveBeenCalled();
		expect(state.settle).not.toHaveBeenCalled();
	});
	it("fails a run whose route marker is absent instead of re-driving it", async () => {
		state.run.metadata = { redriveInput };
		await sweep();
		expectFailed();
	});
	it("fails a routed run instead of re-driving it", async () => {
		state.run.metadata = { kernelRoute: { kind: "delegate" }, redriveInput };
		await sweep();
		expectFailed();
	});
	it("fails a run with a child instead of re-driving it", async () => {
		state.run.childRunId = "child";
		await sweep();
		expectFailed();
	});
	it("fails a run that recorded a delegation decision instead of re-driving it", async () => {
		state.run.metadata = {
			kernelRoute: null,
			redriveInput,
			homeDelegation: { resolutionStatus: "pending" },
		};
		await sweep();
		expectFailed();
	});
	it("leaves a run that is waiting for approval untouched", async () => {
		state.run.status = "requires_approval";
		await sweep();
		expectNoRedrive();
		expect(state.transition).not.toHaveBeenCalled();
		expect(state.settle).not.toHaveBeenCalled();
	});
	it("settles a finished run without re-driving it", async () => {
		state.run.status = "completed";
		await sweep();
		expectNoRedrive();
		expect(state.transition).not.toHaveBeenCalled();
		expect(state.settle).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({ outcome: "settled" }),
		);
	});
	it("cancels an aborted run instead of re-driving it", async () => {
		state.submission.abortRequestedAt = "2026-01-01T00:00:00.000Z";
		await sweep();
		expectNoRedrive();
		expect(state.settle).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({ outcome: "canceled" }),
		);
	});
	it("fails a run whose retry budget is spent", async () => {
		state.submission.attemptCount = 10;
		await sweep();
		expectFailed();
	});
	it("does nothing when the run is routed or finished while the sweep runs", async () => {
		state.claim.mockResolvedValue(false);
		await sweep();
		expect(state.claim).toHaveBeenCalledTimes(1);
		expect(state.startAttempt).not.toHaveBeenCalled();
		expect(state.schedule).not.toHaveBeenCalled();
		expect(state.transition).not.toHaveBeenCalled();
		expect(state.settle).not.toHaveBeenCalled();
	});
});
