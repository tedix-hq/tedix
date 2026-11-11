import { describe, expect, it } from "vite-plus/test";
import {
	isRetryableOwnerToolExecution,
	ownerToolExecutionNextStep,
	ownerToolExecutionOutcome,
	parseOwnerToolExecution,
} from "./owner-tool-execution";

describe("owner tool execution record", () => {
	it("reads the recorded run and ignores anything else", () => {
		expect(
			parseOwnerToolExecution({
				status: "failed",
				startedAt: "2026-10-28T13:23:45.692Z",
				finishedAt: "2026-10-28T13:23:46.311Z",
				error: "Provider tool call failed (transport)",
				retryable: true,
				attempt: 2,
				retriedBy: "admin-2",
				extra: "dropped",
			}),
		).toEqual({
			status: "failed",
			startedAt: "2026-10-28T13:23:45.692Z",
			finishedAt: "2026-10-28T13:23:46.311Z",
			error: "Provider tool call failed (transport)",
			retryable: true,
			attempt: 2,
			retriedBy: "admin-2",
		});
		expect(parseOwnerToolExecution({ status: "done" })).toBeNull();
		expect(parseOwnerToolExecution(undefined)).toBeNull();
	});

	it("allows one retry of a platform-side failure only", () => {
		const failed = (overrides: Record<string, unknown>) =>
			parseOwnerToolExecution({
				status: "failed",
				startedAt: "x",
				...overrides,
			});
		expect(isRetryableOwnerToolExecution(failed({ retryable: true }))).toBe(
			true,
		);
		expect(isRetryableOwnerToolExecution(failed({ retryable: false }))).toBe(
			false,
		);
		// A gateway refusal before dispatch is retryable even when the recorder
		// marked the row final.
		expect(
			isRetryableOwnerToolExecution(
				failed({
					retryable: false,
					error:
						"Tool rate limit exceeded for high_impact_write: … No side effect was executed for this call.",
				}),
			),
		).toBe(true);
		// A retry that failed on the platform's side again may be tried again.
		expect(
			isRetryableOwnerToolExecution(failed({ retryable: true, attempt: 2 })),
		).toBe(true);
		expect(
			isRetryableOwnerToolExecution(
				failed({
					error:
						"Human approval required: critical or destructive action requires human approval. Route this action through Home's approval flow. No side effect was executed.",
				}),
			),
		).toBe(true);
		// Rows recorded before the flag existed: classified by their error.
		expect(
			isRetryableOwnerToolExecution(
				failed({
					error:
						'Tool "tedix__delete_descope_aih_mcp_client" is no longer available on tedix-unified',
				}),
			),
		).toBe(true);
		expect(
			isRetryableOwnerToolExecution(
				failed({ error: "insufficient_scope: platform:admin" }),
			),
		).toBe(false);
		expect(
			isRetryableOwnerToolExecution(
				parseOwnerToolExecution({ status: "executed", startedAt: "x" }),
			),
		).toBe(false);
		expect(isRetryableOwnerToolExecution(null)).toBe(false);
		// A run cut off before it finished is retryable once it is stale.
		const now = Date.parse("2026-10-28T14:40:00.000Z");
		const running = (startedAt: string) =>
			parseOwnerToolExecution({ status: "running", startedAt, attempt: 2 });
		expect(
			isRetryableOwnerToolExecution(running("2026-10-28T14:22:08.160Z"), now),
		).toBe(true);
		expect(
			isRetryableOwnerToolExecution(running("2026-10-28T14:35:00.000Z"), now),
		).toBe(false);
		expect(
			ownerToolExecutionOutcome(running("2026-10-28T14:22:08.160Z"), now),
		).toContain("Did not finish");
	});

	it("keeps queued work automatic and describes the wait", () => {
		const execution = parseOwnerToolExecution({
			status: "queued",
			startedAt: "2026-10-31T12:00:00.000Z",
			nextAttemptAt: "2026-10-31T12:01:00.000Z",
		});
		expect(execution?.nextAttemptAt).toBe("2026-10-31T12:01:00.000Z");
		expect(isRetryableOwnerToolExecution(execution)).toBe(false);
		expect(ownerToolExecutionOutcome(execution)).toContain(
			"Tedix will retry automatically",
		);
		expect(
			ownerToolExecutionOutcome({
				status: "queued",
				summary: "Deleted 40 conversations over 1 run; continuing",
			}),
		).toBe("Continuing: Deleted 40 conversations over 1 run; continuing");
	});

	it("says what happened in words", () => {
		expect(
			ownerToolExecutionOutcome(
				parseOwnerToolExecution({
					status: "executed",
					startedAt: "x",
					summary: "Delete descope aih mcp client",
				}),
			),
		).toBe("Done: Delete descope aih mcp client");
		expect(
			ownerToolExecutionOutcome(
				parseOwnerToolExecution({
					status: "failed",
					startedAt: "x",
					error: "Provider tool call failed (transport)",
				}),
			),
		).toBe("Failed: Provider tool call failed (transport)");
		expect(
			ownerToolExecutionOutcome(
				parseOwnerToolExecution({ status: "running", startedAt: "x" }),
			),
		).toBe("Running now");
		expect(ownerToolExecutionOutcome(null)).toBeNull();
	});
});

describe("ownerToolExecutionNextStep", () => {
	const now = Date.parse("2026-11-06T09:30:00.000Z");
	const cutOff = parseOwnerToolExecution({
		status: "running",
		startedAt: "2026-11-05T11:43:38.705Z",
	});
	it("never offers a retry for a cut-off run the gateway consumed", () => {
		expect(
			ownerToolExecutionNextStep(cutOff, {
				consumedAt: "2026-11-05T11:43:44.838Z",
				now,
			}),
		).toBe("outcome_unknown");
		expect(ownerToolExecutionNextStep(cutOff, { now })).toBe("retry");
	});
	it("leaves a requester-only failure to the requester, even when redacted", () => {
		const plain = parseOwnerToolExecution({
			status: "failed",
			startedAt: "x",
			retryable: true,
			error:
				"The requester must retry with a verified connections.execute grant; no provider call was made",
		});
		const redacted = parseOwnerToolExecution({
			status: "failed",
			startedAt: "x",
			retryable: false,
			actionBy: "requester",
			error: "Execution details are available to the requester",
		});
		for (const execution of [plain, redacted]) {
			expect(isRetryableOwnerToolExecution(execution, now)).toBe(false);
			expect(ownerToolExecutionNextStep(execution, { now })).toBe("requester");
		}
	});
	it("keeps live runs waiting and clears finished or dismissed ones", () => {
		expect(
			ownerToolExecutionNextStep(
				parseOwnerToolExecution({
					status: "running",
					startedAt: "2026-11-06T09:29:00.000Z",
				}),
				{ now },
			),
		).toBe("wait");
		expect(
			ownerToolExecutionNextStep(
				parseOwnerToolExecution({ status: "executed", startedAt: "x" }),
				{ now },
			),
		).toBe("none");
		const dismissed = parseOwnerToolExecution({
			status: "failed",
			startedAt: "x",
			retryable: true,
			dismissedAt: "2026-11-06T09:00:00.000Z",
		});
		expect(isRetryableOwnerToolExecution(dismissed, now)).toBe(false);
		expect(ownerToolExecutionNextStep(dismissed, { now })).toBe("none");
	});
});
