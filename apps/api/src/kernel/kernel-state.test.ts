import { describe, expect, it, vi } from "vite-plus/test";
import {
	boundKernelActiveTurn,
	extractRunUsage,
	MAX_ACTIVE_TURN_STAGE_LENGTH,
	MAX_ACTIVE_TURN_DETAIL_LENGTH,
	MAX_ACTIVE_TURN_ANSWER_LENGTH,
} from "./kernel-state";
const CONVERSATION_ID = "home:main";
function metadataWithUsage(opts: {
	inputTokens?: number | null;
	outputTokens?: number | null;
	reasoningTokens?: number | null;
	totalCostUsd?: number | null;
}): Record<string, unknown> {
	return {
		bodyExecutionResult: {
			usage: {
				provider: "azure",
				model: "gpt-4o",
				inputTokens: opts.inputTokens ?? null,
				outputTokens: opts.outputTokens ?? null,
				reasoningTokens: opts.reasoningTokens ?? null,
				cacheReadTokens: null,
				cacheWriteTokens: null,
			},
			cost: {
				billingType: "included",
				biller: "kernel",
				modelCostUsd: opts.totalCostUsd ?? null,
				toolCostUsd: null,
				totalCostUsd: opts.totalCostUsd ?? null,
			},
		},
	};
}

describe("boundKernelActiveTurn", () => {
	it("truncates stage and detail to their bounds and preserves the rest", () => {
		const bounded = boundKernelActiveTurn({
			runId: "run-1",
			conversationId: CONVERSATION_ID,
			stage: "s".repeat(MAX_ACTIVE_TURN_STAGE_LENGTH + 20),
			detail: "d".repeat(MAX_ACTIVE_TURN_DETAIL_LENGTH + 20),
			at: "2026-06-11T00:00:00.000Z",
		});
		expect(bounded).toEqual({
			runId: "run-1",
			conversationId: CONVERSATION_ID,
			stage: "s".repeat(MAX_ACTIVE_TURN_STAGE_LENGTH),
			detail: "d".repeat(MAX_ACTIVE_TURN_DETAIL_LENGTH),
			at: "2026-06-11T00:00:00.000Z",
		});
	});

	it("omits detail when absent (keeps the payload minimal)", () => {
		const bounded = boundKernelActiveTurn({
			runId: "run-1",
			conversationId: CONVERSATION_ID,
			stage: "Planning route",
			at: "2026-06-11T00:00:00.000Z",
		});
		expect("detail" in bounded).toBe(false);
	});

	it("carries the streamed answer through and truncates it to its bound", () => {
		const bounded = boundKernelActiveTurn({
			runId: "run-1",
			conversationId: CONVERSATION_ID,
			stage: "Answering",
			answer: "a".repeat(MAX_ACTIVE_TURN_ANSWER_LENGTH + 50),
			at: "2026-06-11T00:00:00.000Z",
		});
		expect(bounded.answer).toBe("a".repeat(MAX_ACTIVE_TURN_ANSWER_LENGTH));
	});

	it("omits answer when absent (coarse milestones carry no answer field)", () => {
		const bounded = boundKernelActiveTurn({
			runId: "run-1",
			conversationId: CONVERSATION_ID,
			stage: "Planning route",
			at: "2026-06-11T00:00:00.000Z",
		});
		expect("answer" in bounded).toBe(false);
	});
});

describe("extractRunUsage — usage extraction from metadata.bodyExecutionResult", () => {
	it("extracts inputTokens, outputTokens, totalTokens, and costUsd from a well-formed metadata blob", () => {
		const metadata = metadataWithUsage({
			inputTokens: 1200,
			outputTokens: 300,
			reasoningTokens: 50,
			totalCostUsd: 0.0042,
		});
		const usage = extractRunUsage(metadata);
		expect(usage).toEqual({
			pricing: null,
			inputTokens: 1200,
			outputTokens: 300,
			reasoningTokens: 50,
			totalTokens: 1500,
			costUsd: 0.0042,
		});
	});

	it("computes totalTokens as the sum of input + output", () => {
		const usage = extractRunUsage(
			metadataWithUsage({ inputTokens: 500, outputTokens: 200 }),
		);
		expect(usage?.totalTokens).toBe(700);
	});

	it("leaves totalTokens null when either input or output is null", () => {
		const onlyInput = extractRunUsage(
			metadataWithUsage({ inputTokens: 500, outputTokens: null }),
		);
		expect(onlyInput?.totalTokens).toBeNull();

		const onlyOutput = extractRunUsage(
			metadataWithUsage({ inputTokens: null, outputTokens: 200 }),
		);
		expect(onlyOutput?.totalTokens).toBeNull();
	});

	it("returns undefined (field omitted) when no meaningful fields are present", () => {
		// All nulls → nothing to report.
		expect(
			extractRunUsage(
				metadataWithUsage({
					inputTokens: null,
					outputTokens: null,
					totalCostUsd: null,
				}),
			),
		).toBeUndefined();
	});

	it("returns undefined for null/undefined/missing metadata", () => {
		expect(extractRunUsage(null)).toBeUndefined();
		expect(extractRunUsage(undefined)).toBeUndefined();
		expect(extractRunUsage({})).toBeUndefined();
	});

	it("returns undefined when bodyExecutionResult is absent or non-object", () => {
		expect(extractRunUsage({ bodyExecutionResult: null })).toBeUndefined();
		expect(
			extractRunUsage({ bodyExecutionResult: "not-an-object" }),
		).toBeUndefined();
		expect(extractRunUsage({ bodyExecutionResult: 42 })).toBeUndefined();
	});

	it("returns a partial result when only costUsd is present (tokens null but cost finite)", () => {
		const usage = extractRunUsage(
			metadataWithUsage({
				inputTokens: null,
				outputTokens: null,
				totalCostUsd: 0.001,
			}),
		);
		expect(usage).toEqual({
			pricing: null,
			inputTokens: null,
			outputTokens: null,
			reasoningTokens: null,
			totalTokens: null,
			costUsd: 0.001,
		});
	});

	it("ignores non-finite numbers and non-number token values", () => {
		const usage = extractRunUsage({
			bodyExecutionResult: {
				usage: {
					inputTokens: Number.NaN,
					outputTokens: Number.POSITIVE_INFINITY,
					cacheReadTokens: null,
					cacheWriteTokens: null,
				},
				cost: { totalCostUsd: "not-a-number" },
			},
		});
		// All degenerate → undefined (nothing meaningful).
		expect(usage).toBeUndefined();
	});
});

describe("durable kernel turn lifecycle", () => {
	it("retains organization before async dispatch and clears progress on failure", async () => {
		const { KernelDOv4 } = await import("./kernel-do");
		const states: Array<Record<string, unknown>> = [];
		const pending: Promise<unknown>[] = [];
		const end = vi.fn(async () => {});
		const cancelSchedule = vi.fn(async () => {});
		const fake = {
			state: { organizationId: null, activeTurn: null },
			env: { KERNEL_ASYNC_PLANNER: "true" },
			setState(state: Record<string, unknown>) {
				this.state = state as typeof this.state;
				states.push(state);
			},
			abortIfStaleCode: vi.fn(),
			startIngressRecall: () => undefined,
			schedule: vi.fn(async () => ({ id: "watchdog" })),
			turnContext: async () => ({}),
			startTurnProgress: () => ({
				onProgress: () => {},
				flush: async () => {},
				end,
			}),
			turnAbortControllers: new Map(),
			cancelSchedule,
			ctx: { waitUntil: (promise: Promise<unknown>) => pending.push(promise) },
			afterTurnMaintenance: vi.fn(async () => {}),
			onTurnEnded: vi.fn(async () => {}),
		};
		type TurnInput = Parameters<typeof KernelDOv4.prototype.processTurn>[0];
		const input = {
			organizationId: "org-1",
			runId: "run-1",
			conversationId: "home:main",
			runRowMetadata: {},
			content: "hello",
		} as TurnInput;
		const process = KernelDOv4.prototype.processTurn as unknown as (
			this: typeof fake,
			input: TurnInput,
		) => Promise<unknown>;
		await process.call(fake, input);
		expect(states[0]).toMatchObject({ organizationId: "org-1" });
		expect(fake.schedule).toHaveBeenCalledWith(0, "runPlannerStep", input);
		lifecycleWork.mockRejectedValueOnce(new Error("turn failure"));
		const run = KernelDOv4.prototype.runPlannerStep as unknown as (
			this: typeof fake,
			input: TurnInput,
		) => Promise<unknown>;
		await expect(run.call(fake, input)).rejects.toThrow("turn failure");
		expect(end).toHaveBeenCalledOnce();
		expect(cancelSchedule).toHaveBeenCalledWith("watchdog");
		expect(fake.turnAbortControllers.size).toBe(0);
		lifecycleWork.mockResolvedValueOnce({ status: "completed" });
		await expect(run.call(fake, input)).resolves.toEqual({
			status: "completed",
		});
		await Promise.all(pending);
		expect(fake.afterTurnMaintenance).toHaveBeenCalledWith("org-1");
		expect(fake.onTurnEnded).toHaveBeenCalledWith("home:main");
		expect(end).toHaveBeenCalledTimes(2);
	});
});

const lifecycleWork = vi.hoisted(() => vi.fn());
vi.mock("@cloudflare/ai-chat", () => ({ AIChatAgent: class {} }));
vi.mock("agents", () => ({ isDurableObjectMemoryLimitReset: () => false }));
vi.mock("@tedix/provisioning", () => ({ injectAgentMessage: vi.fn() }));
vi.mock("./kernel-lazy", () => ({
	loadTurnWork: async () => ({ runKernelTurnWork: lifecycleWork }),
	loadKernelTurnDelegation: async () => ({
		buildKernelTurnWorkDeps: () => ({}),
	}),
}));
