import { errorMessage } from "@tedix/worker-kit/error-message";
import type {
	LearningStageMetrics,
	LearningStageName,
	LearningTelemetry,
} from "./learning-telemetry";

/** Outer cap for one post-turn learning pass (`onBridgeTurn`). */
export const LEARNING_BRIDGE_TIMEOUT_MS = 25_000;

/**
 * Optional stages stop this long before the outer cap, so a slow projection
 * ends as its own `timed_out` instead of aborting the whole pass.
 */
export const LEARNING_SETTLE_MARGIN_MS = 1_000;

/** Below this, an optional stage is skipped rather than started. */
const MIN_STAGE_BUDGET_MS = 500;

/**
 * Per-stage caps for the optional projections. They run after the essential
 * observer -> fact bridge, and each is also capped by what remains of the pass.
 * Rationale gets the most: it does a MemoryGraph search (two recall model
 * calls, p50 ~6s) before its record write.
 */
export const OPTIONAL_LEARNING_STAGE_BUDGET_MS = {
	rationale: 12_000,
	crystallizer: 8_000,
	task_promotion: 8_000,
	artifact: 8_000,
	trace_bundle: 8_000,
} as const satisfies Partial<Record<LearningStageName, number>>;

export type OptionalLearningStage =
	keyof typeof OPTIONAL_LEARNING_STAGE_BUDGET_MS;

class LearningStageTimeout extends Error {
	constructor(stage: OptionalLearningStage, budgetMs: number) {
		super(`learning stage ${stage} timed out (${budgetMs}ms)`);
		this.name = "LearningStageTimeout";
	}
}

export interface LearningStageContext {
	/** The pass's outer signal; its abort still fails the pass as before. */
	signal: AbortSignal;
	/** Absolute time (on `now`) by which every optional stage must settle. */
	deadlineAt: number;
	/** Strict (admitted) runs propagate any non-completed stage outcome. */
	strict: boolean;
	telemetry: Pick<LearningTelemetry, "stages">;
	now?: () => number;
}

/** The deadline optional stages work against, for a pass started at `startedAt`. */
export function learningStageDeadline(startedAt: number): number {
	return startedAt + LEARNING_BRIDGE_TIMEOUT_MS - LEARNING_SETTLE_MARGIN_MS;
}

/**
 * Run one optional learning stage under its own budget and abort signal.
 * Resolves `undefined` when the stage fails, times out or is skipped; the
 * outcome lands in `telemetry.stages[stage]`. Outer aborts and strict-mode
 * outcomes other than `completed` throw.
 */
export async function runLearningStage<T>(
	ctx: LearningStageContext,
	stage: OptionalLearningStage,
	run: (signal: AbortSignal) => Promise<T>,
): Promise<T | undefined> {
	ctx.signal.throwIfAborted();
	const now = ctx.now ?? (() => performance.now());
	const started = now();
	const budgetMs = Math.max(
		0,
		Math.floor(
			Math.min(
				OPTIONAL_LEARNING_STAGE_BUDGET_MS[stage],
				ctx.deadlineAt - started,
			),
		),
	);
	const record = (status: LearningStageMetrics["status"]) => {
		ctx.telemetry.stages[stage] = {
			status,
			durationMs: Math.max(0, Math.round(now() - started)),
			budgetMs,
		};
	};
	if (budgetMs < MIN_STAGE_BUDGET_MS) {
		record("skipped");
		if (ctx.strict)
			throw new Error(`learning stage ${stage} skipped: budget exhausted`);
		console.warn(`[isolate-learning] ${stage} skipped: budget exhausted`);
		return undefined;
	}

	const controller = new AbortController();
	const timeout = new LearningStageTimeout(stage, budgetMs);
	const onOuterAbort = () => controller.abort(ctx.signal.reason);
	ctx.signal.addEventListener("abort", onOuterAbort, { once: true });
	const stopped = new Promise<never>((_, reject) => {
		controller.signal.addEventListener(
			"abort",
			() => reject(controller.signal.reason),
			{ once: true },
		);
	});
	stopped.catch(() => {});
	const timer = setTimeout(() => controller.abort(timeout), budgetMs);
	// A stage that ignores its signal keeps running detached; never let its
	// late rejection surface as unhandled.
	const work = Promise.resolve().then(() => run(controller.signal));
	work.catch(() => {});
	let status: LearningStageMetrics["status"] = "failed";
	try {
		const value = await Promise.race([work, stopped]);
		status = "completed";
		return value;
	} catch (err) {
		if (ctx.signal.aborted) throw ctx.signal.reason ?? err;
		if (controller.signal.reason === timeout) status = "timed_out";
		if (ctx.strict) throw err;
		console.warn(`[isolate-learning] ${stage} ${status}:`, errorMessage(err));
		return undefined;
	} finally {
		clearTimeout(timer);
		ctx.signal.removeEventListener("abort", onOuterAbort);
		record(status);
	}
}

/** Final status: only the outer abort or a failed observer fails the pass. */
export function learningPassStatus(input: {
	aborted: boolean;
	observerStatus: LearningTelemetry["observer"]["status"];
}): "completed" | "failed" {
	return input.aborted || input.observerStatus === "failed"
		? "failed"
		: "completed";
}
