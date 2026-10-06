import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vite-plus/test";
import { createDbClient } from "../client";
import { createD1Facade } from "../test/d1-facade";
import {
	listPlatformCronExecutionSummaries,
	prunePlatformCronExecutions,
	recordPlatformCronExecutionFinish,
	recordPlatformCronExecutionStart,
} from "./platform-cron-executions";

function fixture() {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec(`
		CREATE TABLE platform_cron_executions (
			id TEXT PRIMARY KEY NOT NULL,
			schedule_id TEXT NOT NULL,
			cron TEXT NOT NULL,
			scheduled_at TEXT NOT NULL,
			started_at TEXT NOT NULL,
			finished_at TEXT,
			status TEXT NOT NULL DEFAULT 'running',
			duration_ms INTEGER,
			affected_row_counts TEXT NOT NULL DEFAULT '{}',
			error TEXT,
			created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
		);
		CREATE UNIQUE INDEX idx_platform_cron_executions_fire
			ON platform_cron_executions (schedule_id, scheduled_at);
	`);
	return { db: createDbClient(createD1Facade(sqlite)), sqlite };
}

const start = {
	id: "receipt-1",
	scheduleId: "work-item-lease-expiry",
	cron: "*/2 * * * *",
	scheduledAt: "2026-08-09T01:40:00.000Z",
	startedAt: "2026-08-09T01:40:01.000Z",
};

describe("platform cron execution receipts", () => {
	it("summarizes the latest outcome without turning historical failures into current attention", async () => {
		const { db, sqlite } = fixture();
		const insert = sqlite.prepare(`
			INSERT INTO platform_cron_executions (
				id, schedule_id, cron, scheduled_at, started_at, finished_at,
				status, duration_ms, affected_row_counts, error
			) VALUES (?, ?, '*/15 * * * *', ?, ?, ?, ?, ?, ?, ?)
		`);
		insert.run(
			"failed-first",
			"billing",
			"2026-08-09T01:00:00.000Z",
			"2026-08-09T01:00:01.000Z",
			"2026-08-09T01:00:02.000Z",
			"failure",
			1_000,
			"{}",
			"provider unavailable",
		);
		insert.run(
			"healthy-latest",
			"billing",
			"2026-08-09T01:15:00.000Z",
			"2026-08-09T01:15:01.000Z",
			"2026-08-09T01:15:03.000Z",
			"success",
			2_000,
			'{"ingested":13}',
			null,
		);

		await expect(listPlatformCronExecutionSummaries(db)).resolves.toEqual([
			expect.objectContaining({
				scheduleId: "billing",
				latestId: "healthy-latest",
				latestStatus: "success",
				latestAffectedRowCounts: { ingested: 13 },
				lastSuccessAt: "2026-08-09T01:15:03.000Z",
				lastFailureAt: "2026-08-09T01:00:02.000Z",
			}),
		]);
	});

	it("deduplicates a fire and preserves its first terminal outcome", async () => {
		const { db, sqlite } = fixture();
		await expect(recordPlatformCronExecutionStart(db, start)).resolves.toBe(
			true,
		);
		await expect(
			recordPlatformCronExecutionStart(db, { ...start, id: "receipt-2" }),
		).resolves.toBe(false);
		await recordPlatformCronExecutionFinish(db, {
			...start,
			finishedAt: "2026-08-09T01:40:02.000Z",
			status: "success",
			durationMs: 1_000,
			affectedRowCounts: { expired: 3 },
		});
		await recordPlatformCronExecutionFinish(db, {
			...start,
			id: "receipt-2",
			finishedAt: "2026-08-09T01:40:03.000Z",
			status: "failure",
			durationMs: 2_000,
			affectedRowCounts: {},
			error: "duplicate replay",
		});

		const rows = sqlite
			.prepare("SELECT * FROM platform_cron_executions")
			.all() as Array<Record<string, unknown>>;
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({
			id: "receipt-1",
			status: "success",
			duration_ms: 1_000,
			affected_row_counts: '{"expired":3}',
			error: null,
		});
	});

	it("prunes old terminal receipts in bounded batches but keeps running rows", async () => {
		const { db, sqlite } = fixture();
		const insert = sqlite.prepare(`
			INSERT INTO platform_cron_executions (
				id, schedule_id, cron, scheduled_at, started_at, status, created_at
			) VALUES (?, ?, '0 3 * * *', ?, ?, ?, ?)
		`);
		insert.run(
			"old-success",
			"retention",
			"2026-01-01",
			"2026-01-01",
			"success",
			"2026-01-01 00:00:00",
		);
		insert.run(
			"old-running",
			"retention",
			"2026-01-02",
			"2026-01-02",
			"running",
			"2026-01-02 00:00:00",
		);
		insert.run(
			"new-success",
			"retention",
			"2026-08-01",
			"2026-08-01",
			"success",
			"2026-08-01 00:00:00",
		);

		await expect(
			prunePlatformCronExecutions(db, "2026-07-01 00:00:00", 1, 1),
		).resolves.toBe(1);
		expect(
			sqlite
				.prepare("SELECT id FROM platform_cron_executions ORDER BY id")
				.all(),
		).toEqual([{ id: "new-success" }, { id: "old-running" }]);
	});
});
