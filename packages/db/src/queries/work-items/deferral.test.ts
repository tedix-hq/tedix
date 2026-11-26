import { describe, expect, it } from "vite-plus/test";
import { failedAttemptsWait, unansweredRunQuestionWait } from "./deferral";

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

describe("unansweredRunQuestionWait", () => {
	const item = { version: 3, metadata: {} };
	const attempt = {
		id: "44444444-4444-4444-8444-444444444444",
		outcome: "cancelled",
		metadata: {
			dispatchVersion: 3,
			runQuestion: { seq: 4, kind: "question", text: "Which table?" },
		},
		workItemVersion: 3,
	};

	it("names the wait and how to answer it while the question is open", () => {
		const wait = unansweredRunQuestionWait(item, attempt);
		expect(wait).toContain("Waiting for an answer to the run's question");
		expect(wait).toContain("Which table?");
		expect(wait).toContain("organization owner/admin");
		expect(wait).toContain("tedi owner/steward");
		expect(wait).toContain("update_work_item");
		expect(wait).not.toContain("send_work_attempt_message");
	});

	it("clears once the run's question has an answer", () => {
		const answered = {
			version: 3,
			metadata: {
				questionContinuation: {
					attemptId: attempt.id,
					messageId: "55555555-5555-4555-8555-555555555555",
				},
			},
		};
		expect(unansweredRunQuestionWait(answered, attempt)).toBeUndefined();
		// A continuation recorded for another Attempt answers nothing here.
		expect(
			unansweredRunQuestionWait(
				{
					version: 3,
					metadata: {
						questionContinuation: {
							attemptId: "66666666-6666-4666-8666-666666666666",
							messageId: "55555555-5555-4555-8555-555555555555",
						},
					},
				},
				attempt,
			),
		).toContain("Waiting for an answer");
	});

	it("ignores runs that settled otherwise or for an older version", () => {
		expect(
			unansweredRunQuestionWait(item, { ...attempt, outcome: "succeeded" }),
		).toBeUndefined();
		expect(
			unansweredRunQuestionWait(item, { ...attempt, workItemVersion: 2 }),
		).toBeUndefined();
		expect(
			unansweredRunQuestionWait(item, {
				...attempt,
				metadata: { dispatchVersion: 2, runQuestion: {} },
			}),
		).toBeUndefined();
		expect(
			unansweredRunQuestionWait(item, { ...attempt, metadata: {} }),
		).toBeUndefined();
	});
});
