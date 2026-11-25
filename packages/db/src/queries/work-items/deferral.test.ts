import { describe, expect, it } from "vite-plus/test";
import { failedAttemptsWait } from "./deferral";

const at = (minute: number) =>
	new Date(Date.UTC(2026, 0, 5, 3, minute)).toISOString();
const run = (outcome: string, minute: number, workItemVersion = 3) => ({
	outcome,
	finishedAt: at(minute),
	workItemVersion,
});

describe("failedAttemptsWait", () => {
	it("makes a task wait from the fourth failed Attempt in a row", () => {
		const three = [run("failed", 9), run("failed", 6), run("failed", 3)];
		expect(failedAttemptsWait(three, 3, at(10))).toBeUndefined();

		const four = [run("failed", 12), ...three];
		expect(failedAttemptsWait(four, 3, at(13))).toContain(
			"Recheck at 2026-01-05T04:12:00.000Z",
		);
		// The hour has passed: the next Attempt may start.
		expect(failedAttemptsWait(four, 3, at(73))).toBeUndefined();
		// Five in a row wait four hours.
		expect(
			failedAttemptsWait([run("failed", 15), ...four], 3, at(16)),
		).toContain("Recheck at 2026-01-05T07:15:00.000Z");
	});

	it("counts incomplete results with broken runs, as one stuck task produced them", () => {
		// The nine Attempts of that task, newest first; six are loaded.
		const outcomes = [
			"rejected",
			"failed",
			"rejected",
			"rejected",
			"failed",
			"rejected",
			"failed",
			"failed",
			"rejected",
		];
		const loaded = outcomes
			.map((outcome, index) => run(outcome, 30 - index * 3))
			.slice(0, 6);
		expect(failedAttemptsWait(loaded, 3, at(31))).toContain(
			"Failed 6 times in a row on this task version. Recheck at 2026-01-06T03:30:00.000Z",
		);
		// A runner that went away is not a failed try at the task.
		const expired = [
			run("failed", 12),
			run("rejected", 9),
			run("expired", 6),
			run("failed", 3),
			run("rejected", 1),
		];
		expect(failedAttemptsWait(expired, 3, at(13))).toBeUndefined();
	});

	it("starts over after a landed result or a new task version", () => {
		const landed = [
			run("failed", 12),
			run("failed", 9),
			run("failed", 6),
			run("landed_unverified", 3),
			run("failed", 1),
		];
		expect(failedAttemptsWait(landed, 3, at(13))).toBeUndefined();
		const revised = [
			run("failed", 12, 4),
			run("failed", 9, 3),
			run("failed", 6, 3),
			run("failed", 3, 3),
		];
		expect(failedAttemptsWait(revised, 4, at(13))).toBeUndefined();
	});
});
