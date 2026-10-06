import { describe, expect, it } from "vite-plus/test";
import { shouldArmStallWatchdog, stallWatchdogDelayMs } from "./turn-stall";

describe("shouldArmStallWatchdog", () => {
	/**
	 * The regression. The old rule was `currentTurn().text ? arm : null`, so a
	 * runtime that wedged during `preparing_context`, a tool call, or a
	 * delegation — every one of which arrives as a frame with no text — left the
	 * composer with no timer and no bound.
	 */
	it("arms a turn that has produced no text yet", () => {
		expect(shouldArmStallWatchdog({ finalized: false })).toBe(true);
	});

	it("arms a turn that has produced text", () => {
		expect(shouldArmStallWatchdog({ finalized: false })).toBe(true);
	});

	it("does not arm a finalized turn", () => {
		expect(shouldArmStallWatchdog({ finalized: true })).toBe(false);
	});
});

describe("phase-aware silence budget", () => {
	it.each(["preparing_context", "generating", "using_tool", "delegating"])(
		"keeps %s bounded without canceling legitimate work at 15 seconds",
		(phase) => {
			expect(stallWatchdogDelayMs({ text: "", phase })).toBe(150_000);
			expect(stallWatchdogDelayMs({ text: "Partial answer", phase })).toBe(
				150_000,
			);
		},
	);
	it("uses the short missing-terminal bound only after an answer reaches finalizing", () => {
		expect(stallWatchdogDelayMs({ text: "", phase: "finalizing" })).toBe(
			150_000,
		);
		expect(stallWatchdogDelayMs({ text: "  ", phase: "finalizing" })).toBe(
			150_000,
		);
		expect(stallWatchdogDelayMs({ text: "Answer", phase: "finalizing" })).toBe(
			15_000,
		);
	});
});
