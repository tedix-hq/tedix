import { describe, expect, it } from "vite-plus/test";
import {
	isRetryableOwnerToolExecution,
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
		expect(
			isRetryableOwnerToolExecution(failed({ retryable: true, attempt: 2 })),
		).toBe(false);
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
