import { describe, expect, test } from "vite-plus/test";
import { outboxDiagnosticFromAdminFetch } from "./outbox-diagnostic";

const runId = "tedi-1:mcp:delegated-run";
const snapshot = {
	runId,
	observational: 2,
	terminal: 1,
	kinds: { "tool.completed": 2, "run.completed": 1 },
	oldestPendingAgeMs: 120_000,
	maxRedrives: 3,
	blockedPending: 0,
	blockedInMemory: false,
	inFlight: 0,
	redriveActive: true,
};

describe("outboxDiagnosticFromAdminFetch", () => {
	test("accepts only the exact run and strips unexpected upstream fields", () => {
		const result = outboxDiagnosticFromAdminFetch(
			{
				ok: true,
				status: 200,
				json: {
					ok: true,
					outbox: { ...snapshot, payload: "private bytes" },
					secret: "must not leave API",
				},
			},
			runId,
		);
		expect(result).toEqual({ ok: true, outbox: snapshot });
		expect(JSON.stringify(result)).not.toContain("private bytes");
	});

	test("rejects a mismatched run instead of returning another run's state", () => {
		expect(() =>
			outboxDiagnosticFromAdminFetch(
				{
					ok: true,
					status: 200,
					json: { ok: true, outbox: { ...snapshot, runId: "other-run" } },
				},
				runId,
			),
		).toThrow("unexpected payload");
	});

	test("rejects malformed or failed runtime reads without claiming an empty queue", () => {
		for (const result of [
			{ ok: true, status: 200, json: { ok: true, outbox: {} } },
			{ ok: true, status: 200, json: { ok: false, outbox: snapshot } },
			{ ok: false, status: 503, json: null },
			{ error: "timeout_after_10000ms" },
		]) {
			expect(() => outboxDiagnosticFromAdminFetch(result, runId)).toThrow();
		}
	});

	test("redacts internal hosts from transport errors", () => {
		expect(() =>
			outboxDiagnosticFromAdminFetch(
				{
					error:
						"fetch failed for https://cto.tedi.tedix.dev/__admin/agent-diag",
				},
				runId,
			),
		).toThrow("[internal]");
	});
});
