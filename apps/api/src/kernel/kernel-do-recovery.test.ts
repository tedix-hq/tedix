import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { KernelTurnProgress } from "../rpc/routers/kernel/turn-work-context";

const body = vi.hoisted(() => vi.fn());
const liveEvents = vi.hoisted(() => ({
	recordHomeAnswerDelta: vi.fn(async () => undefined),
	recordHomeRationaleDelta: vi.fn(async () => undefined),
	recordHomePhaseEvent: vi.fn(async () => undefined),
}));
vi.mock("@cloudflare/ai-chat", () => ({ AIChatAgent: class {} }));
vi.mock("agents", () => ({ isDurableObjectMemoryLimitReset: () => false }));
vi.mock("./kernel-lazy", () => ({
	loadHomeLiveEvents: async () => liveEvents,
	loadTurnWork: async () => ({ runKernelTurnWork: body }),
	loadKernelTurnDelegation: async () => ({
		buildKernelTurnWorkDeps: () => ({}),
	}),
}));

async function fixture(realProgress = false) {
	const { KernelDOv4 } = await import("./kernel-do");
	const pending: Promise<unknown>[] = [];
	const maintenance = vi.fn(async () => undefined);
	const end = vi.fn(async () => undefined);
	const fake = {
		env: {},
		state: {},
		setState: vi.fn(),
		startIngressRecall: vi.fn(),
		turnContext: async () => ({}),
		readPreviousRelevanceRecall: async () => null,
		readPersistedHistoryCheckpoint: async () => null,
		readInventorySnapshot: async () => null,
		startTurnProgress: realProgress
			? KernelDOv4.prototype["startTurnProgress"]
			: () => ({
					end,
					onProgress: vi.fn(),
					flush: vi.fn(),
					holdAfterSettle: vi.fn(),
				}),
		turnAbortControllers: new Map(),
		afterTurnMaintenance: maintenance,
		onTurnEnded: vi.fn(async () => undefined),
		cancelSchedule: vi.fn(async () => undefined),
		ctx: { waitUntil: (promise: Promise<unknown>) => pending.push(promise) },
	};
	const input = {
		organizationId: "fictional-org",
		conversationId: "fictional-conversation",
		runId: "fictional-run",
		ingressWatchdogId: "existing-watchdog",
		runRowMetadata: {},
	};
	return {
		invoke: () =>
			KernelDOv4.prototype.runPlannerStep.call(fake as never, input as never),
		fake,
		maintenance,
		pending,
		end,
	};
}

describe("planner exception recovery scheduling", () => {
	beforeEach(() => {
		body.mockReset();
	});
	it("arms existing maintenance on a thrown body without replacing the original error", async () => {
		const failure = new Error("fictional planner failure");
		body.mockRejectedValue(failure);
		const f = await fixture();
		await expect(f.invoke()).rejects.toBe(failure);
		await Promise.all(f.pending);
		expect(f.maintenance).toHaveBeenCalledExactlyOnceWith("fictional-org");
		expect(f.end).toHaveBeenCalledTimes(1);
		expect(f.fake.cancelSchedule).not.toHaveBeenCalled();
		expect(f.fake.turnAbortControllers.size).toBe(0);
	});
	it("preserves the planner error if recovery wake registration also throws", async () => {
		const failure = new Error("fictional planner failure");
		body.mockRejectedValue(failure);
		const f = await fixture();
		f.fake.ctx.waitUntil = () => {
			throw new Error("fictional registration failure");
		};
		await expect(f.invoke()).rejects.toBe(failure);
		expect(f.maintenance).toHaveBeenCalledTimes(1);
		expect(f.end).toHaveBeenCalledTimes(1);
		expect(f.fake.turnAbortControllers.size).toBe(0);
	});
	it("arms maintenance once for a successful body and cancels its watchdog", async () => {
		body.mockResolvedValue({ run: { metadata: {} } });
		const f = await fixture();
		await expect(f.invoke()).resolves.toEqual({ run: { metadata: {} } });
		await Promise.all(f.pending);
		expect(f.maintenance).toHaveBeenCalledTimes(1);
		expect(f.end).toHaveBeenCalledTimes(1);
		expect(f.fake.cancelSchedule).toHaveBeenCalledExactlyOnceWith(
			"existing-watchdog",
		);
	});
});

describe("durable kernel progress", () => {
	it("persists answer, rationale and phase events without an environment flag", async () => {
		for (const record of Object.values(liveEvents)) record.mockClear();
		body.mockImplementation(
			async (deps: {
				onProgress: (progress: KernelTurnProgress) => void;
				flushStreamedProgress: () => void;
			}) => {
				deps.onProgress({
					stage: "Planning route",
					phase: "planning",
					rationaleDelta: "Checking ",
				});
				deps.onProgress({
					stage: "Planning route",
					phase: "planning",
					rationaleDelta: "the request",
				});
				deps.onProgress({
					stage: "Writing answer",
					phase: "generating",
					answerDelta: "Hello ",
				});
				deps.onProgress({ stage: "Writing answer", answerDelta: "there" });
				deps.flushStreamedProgress();
				return { run: { metadata: {} } };
			},
		);
		const f = await fixture(true);
		await f.invoke();
		await Promise.all(f.pending);
		const identity = {
			organizationId: "fictional-org",
			conversationId: "fictional-conversation",
			runId: "fictional-run",
			createdAt: expect.any(String),
		};
		for (const [record, chunks] of [
			[liveEvents.recordHomeAnswerDelta, ["Hello ", "there"]],
			[liveEvents.recordHomeRationaleDelta, ["Checking ", "the request"]],
		] as const) {
			expect(record).toHaveBeenCalledTimes(2);
			chunks.forEach((delta, sequence) => {
				expect(record).toHaveBeenNthCalledWith(
					sequence + 1,
					{},
					{
						...identity,
						delta,
						sequence,
					},
				);
			});
		}
		expect(liveEvents.recordHomePhaseEvent).toHaveBeenCalledTimes(2);
		["planning", "generating"].forEach((phase, index) => {
			expect(liveEvents.recordHomePhaseEvent).toHaveBeenNthCalledWith(
				index + 1,
				{},
				{ ...identity, phase, sequence: index + 1 },
			);
		});
		expect(f.fake.setState).toHaveBeenLastCalledWith({ activeTurn: null });
	});
});
