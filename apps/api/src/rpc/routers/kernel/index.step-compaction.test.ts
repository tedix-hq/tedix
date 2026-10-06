/**
 * `runKernel` pass loop — compaction is re-checked after every step, not once
 * per turn.
 *
 * The turn used to assemble ONCE, hydrate the attachment bodies into the replay
 * AFTER that measurement, and prompt. Anything that grew the prompt in between —
 * the hydrated bodies, or whatever the provider actually charged for the LAST
 * persisted step — was discovered only when the provider threw, so the overflow
 * retry became the routine path instead of the backstop.
 *
 * These pin the replacement:
 *   - a step whose measured prompt crosses the trigger folds BEFORE the model
 *     is prompted (the pass ends without prompting; the reload folds),
 *   - a provider that reported no usage triggers a reload-and-remeasure so the
 *     turn-start estimator measures the whole prompt,
 *   - the reactive overflow arm still catches an estimator miss,
 *   - an operator cancel ends the turn AHEAD of compaction.
 */

import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { KernelContext } from "./context-assembly";
import type { KernelRouteDecision } from "./route-schema";

vi.mock("./context-assembly", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./context-assembly")>();
	return { ...actual, assembleHomeContext: vi.fn() };
});
vi.mock("./route-planner", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./route-planner")>();
	return { ...actual, planKernelRoute: vi.fn() };
});
vi.mock("./attachment-content", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./attachment-content")>();
	return { ...actual, hydrateHomeHistory: vi.fn() };
});

const { assembleHomeContext } = await import("./context-assembly");
const { planKernelRoute } = await import("./route-planner");
const { hydrateHomeHistory } = await import("./attachment-content");
const { runKernel } = await import("./index");

const assemble = vi.mocked(assembleHomeContext);
const plan = vi.mocked(planKernelRoute);
const hydrate = vi.mocked(hydrateHomeHistory);

/**
 * Workers AI is the lane a kernel with `env.AI` and no Azure configuration
 * serves: a 24 000-token window minus the 2 000-token completion reserve.
 * Input budget 88 000 chars; the 0.85 trigger sits at 74 800.
 */
const LANE_BUDGET_TOKENS = 22_000;
const TRIGGER_CHARS = 74_800;

const ROUTE: KernelRouteDecision = {
	routeKind: "answer_in_home",
	rationale: "Answer directly.",
	risk: "low",
	confidence: 0.9,
	effortClass: "single_read",
	answer: "Folded, then answered.",
	targetTediId: null,
	targetTediLabel: null,
	toolIntent: null,
	workflowHint: null,
	clarifyingQuestion: null,
	evidenceExpectation: null,
};

function context(overrides?: Partial<KernelContext>): KernelContext {
	return {
		workspace: null,
		tedis: [],
		apps: [],
		workflows: [],
		conversationCapabilities: [],
		conversationArtifactPins: [],
		workItems: [],
		facts: [],
		rationale: [],
		speaker: null,
		history: [
			{ role: "user", content: "earlier ask" },
			{ role: "assistant", content: "earlier answer" },
		],
		promptCharsEstimate: 5_000,
		lastStepPromptTokens: null,
		...overrides,
	} as KernelContext;
}

/** Ordered trace of what the turn did, so "before the model call" is provable. */
let trace: string[] = [];

function call(index: number) {
	return assemble.mock.calls[index]?.[2] as
		| {
				maxPromptTokens?: number;
				forceCompaction?: boolean;
				extraPromptChars?: number;
				measuredPromptTokens?: number | null;
		  }
		| undefined;
}

async function run(args?: { abortSignal?: AbortSignal }) {
	return runKernel({
		db: {} as never,
		// `env.AI` alone keeps the kernel active (Workers AI lane); no Azure
		// configuration means no model, so no summarizer is wired either.
		env: {
			AI: {},
			KERNEL_MODEL_REF: "workers-ai/@cf/openai/gpt-oss-120b",
		} as never,
		organizationId: "org-step",
		conversationId: "home:step",
		content: "ship the compaction fix",
		...(args?.abortSignal ? { abortSignal: args.abortSignal } : {}),
	});
}

beforeEach(() => {
	trace = [];
	assemble.mockReset();
	plan.mockReset();
	hydrate.mockReset();
	hydrate.mockImplementation(async (history) => [...history]);
	plan.mockImplementation(async () => {
		trace.push("plan");
		return { ...ROUTE, usage: null } as never;
	});
});

describe("runKernel — per-step compaction re-check", () => {
	it("a step whose MEASURED prompt crosses the trigger folds before the next model call", async () => {
		// 21 000 measured prompt tokens = 84 000 chars ≥ the 74 800 trigger, while
		// the turn-start estimator measured only 5 000 chars.
		assemble.mockImplementation(async () => {
			trace.push("assemble");
			return context({ lastStepPromptTokens: 21_000 });
		});

		const result = await run();

		expect(result?.assistantContent).toContain("Folded, then answered.");
		// The first pass ended WITHOUT prompting: assemble, assemble, then plan.
		expect(trace).toEqual(["assemble", "assemble", "plan"]);
		expect(assemble).toHaveBeenCalledTimes(2);
		expect(plan).toHaveBeenCalledTimes(1);
		// The reload is told to fold, and carries the measurement forward so it
		// does not re-derive a number it already holds.
		expect(call(0)?.forceCompaction).toBeUndefined();
		expect(call(1)?.forceCompaction).toBe(true);
		expect(call(1)?.measuredPromptTokens).toBe(21_000);
		expect(call(1)?.maxPromptTokens).toBe(LANE_BUDGET_TOKENS);
	});

	it("a measured step under the trigger prompts on the first pass", async () => {
		assemble.mockImplementation(async () => {
			trace.push("assemble");
			return context({ lastStepPromptTokens: 1_000 });
		});

		await run();

		expect(trace).toEqual(["assemble", "plan"]);
		expect(assemble).toHaveBeenCalledTimes(1);
	});

	it("a provider that reported no usage triggers a reload-and-remeasure", async () => {
		// Nothing to project from, and hydration inlined attachment bodies into
		// the replay AFTER assembly measured it — so reload and let the turn-start
		// estimator measure the WHOLE prompt.
		assemble.mockImplementation(async () => {
			trace.push("assemble");
			return context({ lastStepPromptTokens: null });
		});
		hydrate.mockImplementation(async (history) => [
			...history,
			{ role: "user" as const, content: "x".repeat(40_000) },
		]);

		await run();

		expect(trace).toEqual(["assemble", "assemble", "plan"]);
		// A reload, not a forced fold: the estimator, not a measurement, decides.
		expect(call(1)?.forceCompaction).toBeUndefined();
		expect(call(1)?.measuredPromptTokens).toBeNull();
		// The hydrated bodies are declared so the reloaded pass measures them.
		expect(call(1)?.extraPromptChars).toBe(40_020);
	});

	it("does not reload when nothing was appended after the measurement", async () => {
		assemble.mockImplementation(async () => {
			trace.push("assemble");
			return context({ lastStepPromptTokens: null });
		});

		await run();

		expect(trace).toEqual(["assemble", "plan"]);
	});

	it("an unmeasured step whose hydrated prompt crosses the trigger still folds", async () => {
		// The estimator, not a measurement, is the verdict here: assembly's own
		// published estimate plus the hydrated bodies is over the trigger.
		assemble.mockImplementation(async () => {
			trace.push("assemble");
			return context({
				lastStepPromptTokens: null,
				promptCharsEstimate: TRIGGER_CHARS,
			});
		});
		hydrate.mockImplementation(async (history) => [
			...history,
			{ role: "user" as const, content: "x".repeat(1_000) },
		]);

		await run();

		expect(trace).toEqual(["assemble", "assemble", "plan"]);
		expect(call(1)?.forceCompaction).toBe(true);
	});

	it("an operator cancel ends the turn ahead of compaction", async () => {
		// A turn nobody is waiting for must not pay a summarizer call.
		assemble.mockImplementation(async () => {
			trace.push("assemble");
			return context({ lastStepPromptTokens: 21_000 });
		});
		const controller = new AbortController();
		controller.abort();

		await run({ abortSignal: controller.signal });

		expect(assemble).toHaveBeenCalledTimes(1);
		expect(call(0)?.forceCompaction).toBeUndefined();
	});

	it("the reactive overflow arm still catches an estimator miss", async () => {
		// Measured and estimated both clear the trigger, and the provider throws
		// anyway. The backstop refolds at half the lane budget and retries ONCE.
		assemble.mockImplementation(async () => {
			trace.push("assemble");
			return context({ lastStepPromptTokens: 1_000 });
		});
		plan.mockImplementationOnce(async () => {
			trace.push("plan");
			throw new Error("This model's maximum context length is 24000 tokens");
		});

		const result = await run();

		expect(result?.assistantContent).toContain("Folded, then answered.");
		expect(trace).toEqual(["assemble", "plan", "assemble", "plan"]);
		expect(call(1)?.maxPromptTokens).toBe(LANE_BUDGET_TOKENS / 2);
		expect(call(1)?.forceCompaction).toBe(true);
		expect(result?.contextManifest.budgetTokens).toBe(LANE_BUDGET_TOKENS / 2);
	});

	it("a second overflow is a real failure, not an estimator miss", async () => {
		assemble.mockImplementation(async () => context({}));
		plan.mockImplementation(async () => {
			throw new Error("prompt is too long");
		});

		await expect(run()).rejects.toThrow("prompt is too long");
		expect(plan).toHaveBeenCalledTimes(2);
	});

	it("a non-overflow provider error is never retried", async () => {
		assemble.mockImplementation(async () => context({}));
		plan.mockImplementation(async () => {
			throw new Error("429 rate limited");
		});

		await expect(run()).rejects.toThrow("429 rate limited");
		expect(plan).toHaveBeenCalledTimes(1);
		expect(assemble).toHaveBeenCalledTimes(1);
	});
});
