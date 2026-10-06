import { describe, expect, it } from "bun:test";
import {
	classifyTurnLiveness,
	formatTurnDuration,
	TURN_LIVENESS_SLOW_MS,
	TURN_LIVENESS_STUCK_MS,
} from "./turn-liveness.ts";

describe("classifyTurnLiveness", () => {
	const now = 1_000_000;
	it("is live when no turn is in flight (lastActivityAt 0)", () => {
		expect(classifyTurnLiveness(0, now)).toBe("live");
	});
	it("is live within the slow threshold", () => {
		expect(classifyTurnLiveness(now - (TURN_LIVENESS_SLOW_MS - 1), now)).toBe(
			"live",
		);
	});
	it("is slow at/after the slow threshold", () => {
		expect(classifyTurnLiveness(now - TURN_LIVENESS_SLOW_MS, now)).toBe("slow");
	});
	it("is stuck at/after the stuck threshold", () => {
		expect(classifyTurnLiveness(now - TURN_LIVENESS_STUCK_MS, now)).toBe(
			"stuck",
		);
	});
});

describe("formatTurnDuration", () => {
	it("clamps non-positive / non-finite to 0s", () => {
		expect(formatTurnDuration(0)).toBe("0s");
		expect(formatTurnDuration(-5)).toBe("0s");
		expect(formatTurnDuration(Number.NaN)).toBe("0s");
	});
	it("formats seconds / minutes / hours coarsely", () => {
		expect(formatTurnDuration(8_200)).toBe("8s");
		expect(formatTurnDuration(120_000)).toBe("2m");
		expect(formatTurnDuration(125_000)).toBe("2m 5s");
		expect(formatTurnDuration(3_600_000)).toBe("1h");
		expect(formatTurnDuration(3_780_000)).toBe("1h 3m");
	});
});
