import { describe, expect, it } from "vite-plus/test";
import {
	createProgressThrottle,
	DEFAULT_PROGRESS_MIN_INTERVAL_MS,
} from "./progress-throttle";

/**
 * Deterministic harness: manual clock + manual timers (no real sleeps). The
 * single pending timer is fired explicitly via `fireTimer()`, mirroring how
 * the trailing write fires in the DO.
 */
function harness(minIntervalMs?: number) {
	let nowMs = 0;
	const applied: Array<string | null> = [];
	const timers: Array<{ fn: () => void; at: number; cleared: boolean }> = [];
	const throttle = createProgressThrottle<string>({
		apply: (value) => applied.push(value),
		minIntervalMs,
		now: () => nowMs,
		setTimer: (fn, delayMs) => {
			const entry = { fn, at: nowMs + delayMs, cleared: false };
			timers.push(entry);
			return entry;
		},
		clearTimer: (handle) => {
			const entry = handle as { cleared: boolean };
			entry.cleared = true;
		},
	});
	return {
		throttle,
		applied,
		timers,
		setNow: (ms: number) => {
			nowMs = ms;
		},
		/** Fire the most recent uncleared timer (advancing the clock to its due time). */
		fireTimer: () => {
			const pending = timers.filter((t) => !t.cleared).pop();
			if (!pending) throw new Error("no pending timer");
			nowMs = Math.max(nowMs, pending.at);
			pending.fn();
		},
		pendingTimerCount: () => timers.filter((t) => !t.cleared).length,
	};
}

describe("createProgressThrottle", () => {
	it("applies the first push immediately", () => {
		const h = harness();
		h.throttle.push("Planning route");
		expect(h.applied).toEqual(["Planning route"]);
		expect(h.pendingTimerCount()).toBe(0);
	});

	it("defers pushes inside the interval and the trailing write lands the LAST value", () => {
		const h = harness();
		h.throttle.push("Planning route"); // t=0, applied
		h.setNow(200);
		h.throttle.push("Reading globex"); // inside 1s window → deferred
		h.setNow(400);
		h.throttle.push("Reading — step 2"); // replaces the pending value
		expect(h.applied).toEqual(["Planning route"]);
		expect(h.pendingTimerCount()).toBe(1);
		h.fireTimer(); // fires at t=1000 (lastApplied 0 + interval)
		expect(h.applied).toEqual(["Planning route", "Reading — step 2"]);
		expect(h.timers[0]?.at).toBe(DEFAULT_PROGRESS_MIN_INTERVAL_MS);
	});

	it("applies immediately again once the interval has elapsed", () => {
		const h = harness();
		h.throttle.push("a"); // t=0
		h.setNow(DEFAULT_PROGRESS_MIN_INTERVAL_MS);
		h.throttle.push("b"); // exactly 1s later → immediate
		h.setNow(DEFAULT_PROGRESS_MIN_INTERVAL_MS * 2 + 5);
		h.throttle.push("c");
		expect(h.applied).toEqual(["a", "b", "c"]);
		expect(h.pendingTimerCount()).toBe(0);
	});

	it("respects a custom minIntervalMs", () => {
		const h = harness(100);
		h.throttle.push("a"); // t=0
		h.setNow(50);
		h.throttle.push("b"); // deferred
		h.setNow(100);
		expect(h.applied).toEqual(["a"]);
		h.fireTimer();
		expect(h.applied).toEqual(["a", "b"]);
	});

	it("end() cancels the pending trailing write and applies null (clear-on-end)", () => {
		const h = harness();
		h.throttle.push("a"); // applied
		h.setNow(300);
		h.throttle.push("b"); // pending trailing
		h.throttle.end();
		expect(h.applied).toEqual(["a", null]);
		// Trailing timer was cleared — even if the runtime fired it anyway,
		// the ended guard would drop it.
		expect(h.pendingTimerCount()).toBe(0);
		h.timers[0]?.fn();
		expect(h.applied).toEqual(["a", null]);
	});

	it("ignores pushes after end() — a straggler can never resurrect a cleared stage", () => {
		const h = harness();
		h.throttle.push("a");
		h.throttle.end();
		h.setNow(10_000);
		h.throttle.push("straggler");
		expect(h.applied).toEqual(["a", null]);
		// Double-end is a no-op too.
		h.throttle.end();
		expect(h.applied).toEqual(["a", null]);
	});

	it("a throwing applier never propagates (advisory fail-soft)", () => {
		let calls = 0;
		const throttle = createProgressThrottle<string>({
			apply: () => {
				calls += 1;
				throw new Error("setState broke");
			},
			now: () => calls * 5_000, // every push outside the interval
		});
		expect(() => throttle.push("a")).not.toThrow();
		expect(() => throttle.push("b")).not.toThrow();
		expect(() => throttle.end()).not.toThrow();
		expect(calls).toBe(3);
	});

	it("an immediate push after the trailing write re-enters the throttle window", () => {
		const h = harness();
		h.throttle.push("a"); // t=0 applied
		h.setNow(500);
		h.throttle.push("b"); // pending
		h.fireTimer(); // t=1000, applies "b", lastApplied=1000
		h.setNow(1200);
		h.throttle.push("c"); // inside the new window → deferred again
		expect(h.applied).toEqual(["a", "b"]);
		h.fireTimer(); // t=2000
		expect(h.applied).toEqual(["a", "b", "c"]);
	});
});
