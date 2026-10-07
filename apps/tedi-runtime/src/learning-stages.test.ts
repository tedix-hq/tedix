import assert from "node:assert/strict";
import {
	learningPassStatus,
	OPTIONAL_LEARNING_STAGE_BUDGET_MS,
	runLearningStage,
} from "./learning-stages";
import {
	createLearningTelemetry,
	type LearningTelemetryEvent,
} from "./learning-telemetry";

const events: LearningTelemetryEvent[] = [];
const newTelemetry = () =>
	createLearningTelemetry(
		{
			runId: "run-fictional-1",
			userChars: 12,
			assistantChars: 40,
		},
		{ emit: (event) => events.push(event) },
	);

/** Never settles on its own; resolves only when the stage signal aborts. */
const hangUntilAborted = (signal: AbortSignal, honorSignal: boolean) =>
	new Promise<never>((_, reject) => {
		if (honorSignal)
			signal.addEventListener("abort", () => reject(signal.reason), {
				once: true,
			});
	});

// 1. A slow optional stage times out alone: facts are bridged first, the
//    other stages complete, and the pass ends `completed`.
{
	const telemetry = newTelemetry();
	const outer = new AbortController();
	const writtenFacts: string[] = [];
	telemetry.observer.status = "completed";

	// Essential path (do.ts runs `bridgeObservations` before any stage).
	writtenFacts.push("Fictional Co invoices close on the 5th");

	const started = performance.now();
	const ctx = {
		signal: outer.signal,
		deadlineAt: started + 700,
		strict: false,
		telemetry,
	};
	let lateSignalAborted = false;
	const [rationale, crystallizer, artifact] = await Promise.all([
		runLearningStage(ctx, "rationale", async () => ({ recordIds: ["rr-1"] })),
		runLearningStage(ctx, "crystallizer", async (signal) => {
			signal.addEventListener("abort", () => {
				lateSignalAborted = true;
			});
			// Ignores its signal entirely: the runner must still stop waiting.
			return hangUntilAborted(signal, false);
		}),
		runLearningStage(ctx, "artifact", async () => "artifact-1"),
	]);
	const elapsed = performance.now() - started;
	telemetry.finish(
		learningPassStatus({
			aborted: outer.signal.aborted,
			observerStatus: telemetry.observer.status,
		}),
	);

	assert.deepEqual(writtenFacts, ["Fictional Co invoices close on the 5th"]);
	assert.deepEqual(rationale, { recordIds: ["rr-1"] });
	assert.equal(crystallizer, undefined);
	assert.equal(artifact, "artifact-1");
	assert.ok(lateSignalAborted, "the slow stage's own signal is aborted");
	assert.ok(!outer.signal.aborted, "a stage timeout never aborts the pass");
	assert.ok(elapsed < 2_000, `stage waited past its budget (${elapsed}ms)`);
	const event = events.at(-1);
	assert.equal(event?.status, "completed");
	assert.equal(event?.stages.crystallizer?.status, "timed_out");
	assert.ok((event?.stages.crystallizer?.budgetMs ?? 0) <= 700);
	assert.equal(event?.stages.rationale?.status, "completed");
	assert.equal(event?.stages.artifact?.status, "completed");
	assert.equal(event?.stages.trace_bundle, undefined);
}

// 2. Each stage is capped by its own budget even with time to spare.
{
	const telemetry = newTelemetry();
	await runLearningStage(
		{
			signal: new AbortController().signal,
			deadlineAt: performance.now() + 60_000,
			strict: false,
			telemetry,
		},
		"trace_bundle",
		async () => undefined,
	);
	assert.equal(
		telemetry.stages.trace_bundle?.budgetMs,
		OPTIONAL_LEARNING_STAGE_BUDGET_MS.trace_bundle,
	);
}

// 3. A stage that throws is `failed`, fail-soft.
{
	const telemetry = newTelemetry();
	const value = await runLearningStage(
		{
			signal: new AbortController().signal,
			deadlineAt: performance.now() + 5_000,
			strict: false,
			telemetry,
		},
		"task_promotion",
		async () => {
			throw new Error("fictional upstream 503");
		},
	);
	assert.equal(value, undefined);
	assert.equal(telemetry.stages.task_promotion?.status, "failed");
}

// 4. No budget left: skipped without starting.
{
	const telemetry = newTelemetry();
	let started = false;
	await runLearningStage(
		{
			signal: new AbortController().signal,
			deadlineAt: performance.now() + 100,
			strict: false,
			telemetry,
		},
		"artifact",
		async () => {
			started = true;
		},
	);
	assert.equal(started, false);
	assert.equal(telemetry.stages.artifact?.status, "skipped");
}

// 5. Admitted (strict) runs keep effects certain: a timeout throws.
{
	const telemetry = newTelemetry();
	await assert.rejects(
		runLearningStage(
			{
				signal: new AbortController().signal,
				deadlineAt: performance.now() + 600,
				strict: true,
				telemetry,
			},
			"rationale",
			(signal) => hangUntilAborted(signal, true),
		),
		/timed out/,
	);
	assert.equal(telemetry.stages.rationale?.status, "timed_out");
}

// 6. The outer cap still wins: an outer abort propagates and fails the pass.
{
	const telemetry = newTelemetry();
	const outer = new AbortController();
	const pending = runLearningStage(
		{
			signal: outer.signal,
			deadlineAt: performance.now() + 5_000,
			strict: false,
			telemetry,
		},
		"artifact",
		(signal) => hangUntilAborted(signal, true),
	);
	outer.abort(new Error("onBridgeTurn timed out (25s)"));
	await assert.rejects(pending, /onBridgeTurn timed out/);
	assert.equal(
		learningPassStatus({
			aborted: outer.signal.aborted,
			observerStatus: "completed",
		}),
		"failed",
	);
}

assert.equal(
	learningPassStatus({ aborted: false, observerStatus: "failed" }),
	"failed",
);

console.log(
	"PASS: learning stages budget optional work, time out alone, and keep the outer cap",
);
