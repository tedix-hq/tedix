/**
 * Per-stage first-token latency instrumentation for kernel Home turns.
 *
 * A 21-sample Tedix OS measurement (min 334ms / median 2.477s / p95 9.938s) could
 * not say WHERE the p95 tail lives — batching cadence, serial pre-answer work
 * (route planner, write-proposal planner, dispatch), or cold-isolate CPU. This
 * collector produces those numbers: `runKernelTurnWork` marks each real stage
 * boundary as the turn passes it, and the finished snapshot rides the run row's
 * EXISTING terminal metadata write (`metadata.kernelTurnTimings`) — zero extra
 * D1 writes, no new telemetry channel, readable wherever run metadata already
 * surfaces (readRun → Tedix OS `loadHomeRun`).
 *
 * Instrumentation only: this module observes; it changes no timing constant,
 * no batching interval, no cadence.
 *
 * Pure module (answer-delta-batcher convention): no agents-SDK /
 * `cloudflare:workers` imports; the clock is injectable so it is unit-testable
 * under plain vitest. Module-evaluation cost is one `Date.now()` — nothing that
 * moves the startup-CPU floor.
 */

/**
 * Stage marks, in canonical turn order. Streaming marks
 * (`plannerFirstProgress`, `firstAnswerDelta`, `firstAnswerDeltaFlush`) land
 * WHILE `routePlan` is in flight — the planner pass is also the answer pass —
 * so their canonical slot is inside the routePlan window, not after it.
 *
 * - `workStarted` — `runKernelTurnWork` entry (collector creation). The gap to
 *   `enqueuedAt` (persist-first run insert) covers edge→DO dispatch and any
 *   cold-isolate wait.
 * - `routePlanStarted`/`routePlanEnded` — around the single `deps.kernel`
 *   call: context assembly + route-planner LLM + (flag-dependent) answer
 *   stream. The llm-guard abort wrappers live INSIDE this window; they are
 *   not a serial stage.
 * - `plannerFirstProgress` — first advisory progress from inside the kernel
 *   (in practice the post-context-assembly "thinking" milestone), so context
 *   assembly is separable from the LLM call.
 * - `firstAnswerDelta` — first streamed answer token produced by the turn.
 * - `firstAnswerDeltaFlush` — the answer-delta batcher's immediate first flush
 *   (KernelDO path only; ordered against `firstAnswerDelta`, not the serial chain).
 *   Joins
 *   Tedix OS-side drain reads via the `message.delta` ledger row the flush writes.
 * - `writeProposalPlanStarted`/`writeProposalPlanEnded` — around
 *   `planAndParkKernelWriteProposal` (≈0ms on non-write routes).
 * - `dispatchStarted`/`dispatchEnded` — around the auto-delegation dispatch
 *   call (delegated turns only).
 */
export const KERNEL_TURN_STAGE_ORDER = [
	"workStarted",
	"routePlanStarted",
	"plannerFirstProgress",
	"firstAnswerDelta",
	"firstAnswerDeltaFlush",
	"routePlanEnded",
	"writeProposalPlanStarted",
	"writeProposalPlanEnded",
	"dispatchStarted",
	"dispatchEnded",
] as const;

export type KernelTurnStage = (typeof KERNEL_TURN_STAGE_ORDER)[number];

/**
 * The stages the turn body passes STRICTLY in sequence — each present mark is
 * ≥ its present predecessors. The streaming marks are excluded because they are
 * only partially ordered: `plannerFirstProgress` ≤ `firstAnswerDelta` land
 * inside the routePlan window, and `firstAnswerDeltaFlush` is guaranteed only
 * to be ≥ `firstAnswerDelta`.
 * @internal
 */
export const KERNEL_TURN_SERIAL_STAGE_ORDER = [
	"workStarted",
	"routePlanStarted",
	"routePlanEnded",
	"writeProposalPlanStarted",
	"writeProposalPlanEnded",
	"dispatchStarted",
	"dispatchEnded",
] as const satisfies readonly KernelTurnStage[];

/** Route-derived turn classification for the latency split. */
export type KernelTurnType = "answer" | "write_proposal" | "delegated";

export interface KernelTurnStageTimingsSnapshot {
	v: 1;
	turnType: KernelTurnType;
	/** Cold/warm isolate tag: `cold` = the FIRST instrumented turn this isolate
	 * ran (it paid module-graph evaluation); `ageMs` = ms since that first turn
	 * started (0 on the cold turn); `turnSequence` = 1-based instrumented-turn
	 * count in this isolate. */
	isolate: { tag: "cold" | "warm"; ageMs: number; turnSequence: number };
	/** Persist-first run-insert wall clock (`KernelTurnWorkInput.createdAt`). */
	enqueuedAt: string;
	/** Turn-body start wall clock — the zero point for `stages` offsets. */
	workStartedAt: string;
	/** enqueue → turn-body-start latency (edge/DO dispatch + isolate wait). */
	enqueueToWorkMs: number | null;
	/** ms offsets from `workStartedAt`, first occurrence only; unmarked stages
	 * are absent (e.g. no `firstAnswerDelta` on a non-streaming turn). */
	stages: Partial<Record<Exclude<KernelTurnStage, "workStarted">, number>>;
	/** workStarted → settle (the injected `nowIso` settle clock). */
	totalMs: number | null;
}

export interface KernelTurnStageTimings {
	/** Record a stage boundary. First occurrence wins; later calls no-op. */
	mark(stage: KernelTurnStage): void;
	/** Assemble the JSON-safe snapshot attached to the run's terminal metadata
	 * write. Callable once the turn settles; marks arriving later are dropped
	 * with the turn (advisory data, never a second write). */
	snapshot(input: {
		enqueuedAt: string;
		settledAt: string;
		turnType: KernelTurnType;
	}): KernelTurnStageTimingsSnapshot;
}

/**
 * The isolate-age zero point: the start of the first instrumented turn. It
 * cannot be module-evaluation time — Workers freeze `Date.now()` at 0 outside
 * a request, so a module-scope stamp made every row report an age of ~1.79e12.
 */
let isolateFirstTurnAtMs: number | null = null;
/** Instrumented turns started in this isolate (1 ⇒ cold). */
let isolateTurnSequence = 0;

function elapsedSince(baseMs: number, iso: string): number | null {
	const parsed = Date.parse(iso);
	if (!Number.isFinite(parsed)) return null;
	return parsed - baseMs;
}

export function createKernelTurnStageTimings(options?: {
	/** Injectable epoch-ms clock (tests). Default `Date.now`. */
	now?: () => number;
}): KernelTurnStageTimings {
	const now = options?.now ?? Date.now;
	const startedAtMs = now();
	isolateFirstTurnAtMs ??= startedAtMs;
	const ageMs = Math.max(0, startedAtMs - isolateFirstTurnAtMs);
	isolateTurnSequence += 1;
	const turnSequence = isolateTurnSequence;
	const marks = new Map<KernelTurnStage, number>([
		["workStarted", startedAtMs],
	]);
	return {
		mark(stage) {
			if (!marks.has(stage)) marks.set(stage, now());
		},
		snapshot({ enqueuedAt, settledAt, turnType }) {
			const stages: KernelTurnStageTimingsSnapshot["stages"] = {};
			for (const stage of KERNEL_TURN_STAGE_ORDER) {
				if (stage === "workStarted") continue;
				const at = marks.get(stage);
				if (at !== undefined) stages[stage] = Math.max(0, at - startedAtMs);
			}
			const enqueueToWorkMs = (() => {
				const enqueuedMs = Date.parse(enqueuedAt);
				if (!Number.isFinite(enqueuedMs)) return null;
				return Math.max(0, startedAtMs - enqueuedMs);
			})();
			const totalMs = (() => {
				const elapsed = elapsedSince(startedAtMs, settledAt);
				return elapsed === null ? null : Math.max(0, elapsed);
			})();
			return {
				v: 1,
				turnType,
				isolate: {
					tag: turnSequence === 1 ? "cold" : "warm",
					ageMs,
					turnSequence,
				},
				enqueuedAt,
				workStartedAt: new Date(startedAtMs).toISOString(),
				enqueueToWorkMs,
				stages,
				totalMs,
			};
		},
	};
}
