import { describe, expect, it } from "vite-plus/test";
import { summarizeRunSetReconciliation } from "./reconciliation-observability";

describe("summarizeRunSetReconciliation", () => {
	it("returns null when canonical reconciliation changed nothing", () => {
		const rows = [
			{ id: "run-1", status: "running", updatedAt: "2026-08-31T20:00:00Z" },
		];
		expect(summarizeRunSetReconciliation(rows, rows)).toBeNull();
	});

	it("aggregates transitions without logging row payloads", () => {
		const summary = summarizeRunSetReconciliation(
			[
				{ id: "run-1", status: "running", updatedAt: "2026-08-31T20:00:00Z" },
				{ id: "run-2", status: "queued", updatedAt: "2026-08-31T21:00:00Z" },
			],
			[
				{ id: "run-1", status: "failed", updatedAt: "2026-08-31T22:00:00Z" },
				{ id: "run-2", status: "failed", updatedAt: "2026-08-31T22:00:00Z" },
			],
			Date.parse("2026-08-31T23:00:00Z"),
		);
		expect(summary).toEqual({
			changedRows: 2,
			statusTransitions: { "running->failed": 1, "queued->failed": 1 },
			oldestChangedAgeMs: 10_800_000,
		});
	});
});
