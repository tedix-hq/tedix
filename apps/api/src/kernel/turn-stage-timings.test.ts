/**
 * Unit tests for the pure per-turn stage-timing collector. The end-to-end
 * proof (a completed turn's snapshot present on the run metadata, ordered, and
 * tagged) lives in `rpc/routers/kernel/turn-work.test.ts` — this file pins the
 * collector's own contract: first-occurrence marks, offset math, isolate
 * cold/warm tagging, and fail-soft handling of unparseable timestamps.
 */

import { describe, expect, it } from "vite-plus/test";
import {
	createKernelTurnStageTimings,
	KERNEL_TURN_SERIAL_STAGE_ORDER,
	KERNEL_TURN_STAGE_ORDER,
} from "./turn-stage-timings";

/** Deterministic clock: every read advances 10ms from a fixed epoch. */
function steppingClock(startMs = 1_750_000_000_000, stepMs = 10) {
	let t = startMs - stepMs;
	return () => {
		t += stepMs;
		return t;
	};
}

describe("createKernelTurnStageTimings", () => {
	it("records ms offsets from workStarted, first occurrence only", () => {
		const timings = createKernelTurnStageTimings({ now: steppingClock() });
		timings.mark("routePlanStarted"); // +10
		timings.mark("plannerFirstProgress"); // +20
		timings.mark("plannerFirstProgress"); // duplicate — ignored
		timings.mark("firstAnswerDelta"); // +30
		timings.mark("routePlanEnded"); // +40
		const snap = timings.snapshot({
			enqueuedAt: new Date(1_750_000_000_000 - 250).toISOString(),
			settledAt: new Date(1_750_000_000_000 + 1_000).toISOString(),
			turnType: "answer",
		});
		expect(snap.v).toBe(1);
		expect(snap.stages).toEqual({
			routePlanStarted: 10,
			plannerFirstProgress: 20,
			firstAnswerDelta: 30,
			routePlanEnded: 40,
		});
		// Unmarked stages are absent, never zero-filled.
		expect(snap.stages).not.toHaveProperty("writeProposalPlanStarted");
		expect(snap.stages).not.toHaveProperty("firstAnswerDeltaFlush");
		expect(snap.enqueueToWorkMs).toBe(250);
		expect(snap.totalMs).toBe(1_000);
		expect(snap.workStartedAt).toBe(new Date(1_750_000_000_000).toISOString());
	});

	it("tags isolate age: sequence increments per collector and cold means first turn", () => {
		const first = createKernelTurnStageTimings({ now: steppingClock() });
		const second = createKernelTurnStageTimings({ now: steppingClock() });
		const at = new Date().toISOString();
		const a = first.snapshot({
			enqueuedAt: at,
			settledAt: at,
			turnType: "answer",
		});
		const b = second.snapshot({
			enqueuedAt: at,
			settledAt: at,
			turnType: "answer",
		});
		expect(b.isolate.turnSequence).toBe(a.isolate.turnSequence + 1);
		expect(a.isolate.tag).toBe(a.isolate.turnSequence === 1 ? "cold" : "warm");
		// The module-scope counter is ≥ 2 by now, so the second is always warm.
		expect(b.isolate.tag).toBe("warm");
		expect(a.isolate.ageMs).toBeGreaterThanOrEqual(0);
		// Age is measured from the first instrumented turn in this isolate, so a
		// later turn's age is bounded by real elapsed time — never the epoch.
		expect(b.isolate.ageMs).toBeGreaterThanOrEqual(a.isolate.ageMs);
		expect(b.isolate.ageMs).toBeLessThan(60_000);
	});

	it("fails soft on unparseable timestamps (null, never a throw or NaN)", () => {
		const timings = createKernelTurnStageTimings({ now: steppingClock() });
		const snap = timings.snapshot({
			enqueuedAt: "not-a-date",
			settledAt: "also-not-a-date",
			turnType: "write_proposal",
		});
		expect(snap.enqueueToWorkMs).toBeNull();
		expect(snap.totalMs).toBeNull();
		expect(snap.turnType).toBe("write_proposal");
	});

	it("clamps negative gaps to zero (clock skew between placeholder and body clocks)", () => {
		const startMs = 1_750_000_000_000;
		const timings = createKernelTurnStageTimings({
			now: steppingClock(startMs),
		});
		const snap = timings.snapshot({
			// enqueuedAt AFTER workStarted (placeholder clock ahead of body clock).
			enqueuedAt: new Date(startMs + 5_000).toISOString(),
			settledAt: new Date(startMs - 5_000).toISOString(),
			turnType: "delegated",
		});
		expect(snap.enqueueToWorkMs).toBe(0);
		expect(snap.totalMs).toBe(0);
	});

	it("the serial stage order is a subset of the full stage order", () => {
		for (const stage of KERNEL_TURN_SERIAL_STAGE_ORDER) {
			expect(KERNEL_TURN_STAGE_ORDER).toContain(stage);
		}
	});
});
