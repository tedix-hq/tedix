import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, describe, expect, it, vi } from "vite-plus/test";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { coreTable } from "../core-store/client";
import { createMigratedSqlite } from "../test/migrated-sqlite";
import { createPGliteFacade } from "../test/pglite-facade";
import {
	platformCronCheckpoints,
	platformCronExecutions,
} from "../schema/platform-cron-executions";
import type { DbClient } from "../client";
import { createDbClient } from "../client";
import { createD1Facade } from "../test/d1-facade";
import {
	advancePlatformCronCheckpoint,
	getPlatformCronCheckpoint,
	putPlatformCronCheckpoint,
	withPlatformCronWriteBatch,
	listPlatformCronExecutionSummaries,
	recordPlatformCronExecutionFinish,
	recordPlatformCronExecutionStart,
	terminalizeAbandonedPlatformCronExecutions,
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

		// Retained history must not enter the daily counts or the query's working set.
		sqlite.exec(`
			WITH RECURSIVE history(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM history WHERE n < 10000)
			INSERT INTO platform_cron_executions (id, schedule_id, cron, scheduled_at, started_at, status)
			SELECT 'old-' || n, 'billing', '* * * * *',
				strftime('%Y-%m-%dT%H:%M:%fZ', '2026-01-01', '+' || n || ' minutes'), '2026-01-01', 'failure'
			FROM history;
		`);
		insert.run(
			"stale",
			"weekly",
			"2026-08-01",
			"2026-08-01",
			"2026-08-01",
			"success",
			1,
			"{}",
			null,
		);
		const prepare = vi.spyOn(sqlite, "prepare");
		const scheduleIds = ["billing", "weekly", "missing", "billing"];
		const now = new Date("2026-08-09T02:00:00.000Z");
		await expect(
			listPlatformCronExecutionSummaries(db, scheduleIds, now),
		).resolves.toEqual([
			expect.objectContaining({
				scheduleId: "billing",
				latestId: "healthy-latest",
				latestStatus: "success",
				latestAffectedRowCounts: { ingested: 13 },
				lastSuccessAt: "2026-08-09T01:15:03.000Z",
				lastFailureAt: "2026-08-09T01:00:02.000Z",
				countsLast24h: { running: 0, success: 1, failure: 1 },
			}),
			expect.objectContaining({
				scheduleId: "weekly",
				latestId: "stale",
				lastSuccessAt: null,
				lastFailureAt: null,
				countsLast24h: { running: 0, success: 0, failure: 0 },
			}),
		]);
		const query = prepare.mock.calls.find(([query]) =>
			/with "requested" as/i.test(query),
		)?.[0];
		expect(query).toBeDefined();
		const plan = sqlite
			.prepare(`EXPLAIN QUERY PLAN ${query}`)
			.all(
				JSON.stringify(scheduleIds),
				"2026-08-08T02:00:00.000Z",
				now.toISOString(),
			) as Array<{ detail: string }>;
		expect(plan.map((row) => row.detail).join("\n")).toMatch(
			/SEARCH r USING INDEX idx_platform_cron_executions_fire \(schedule_id=\? AND scheduled_at>\? AND scheduled_at<\?\)/,
		);
		expect(plan.map((row) => row.detail).join("\n")).toMatch(
			/SEARCH latest_receipt USING INDEX idx_platform_cron_executions_fire \(schedule_id=\?\)/,
		);
		prepare.mockRestore();
		sqlite.close();
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

	it("recovers abandoned receipts in bounded batches, preserving recent and terminal rows", async () => {
		const { db, sqlite } = fixture();
		try {
			const insert = sqlite.prepare(`
				INSERT INTO platform_cron_executions (
					id, schedule_id, cron, scheduled_at, started_at, status, created_at
				) VALUES (?, 'retention', '0 3 * * *', ?, ?, ?, ?)
			`);
			for (const [id, startedAt, status] of [
				["orphan-1", "2026-01-01T00:00:00.000Z", "running"],
				["orphan-2", "2026-01-02T00:00:00.000Z", "running"],
				["orphan-3", "2026-08-09T05:59:59.999Z", "running"],
				["boundary", "2026-08-09T06:00:00.000Z", "running"],
				["recent", "2026-08-09T11:59:00.000Z", "running"],
				["success", "2026-01-03T00:00:00.000Z", "success"],
				["failure", "2026-01-04T00:00:00.000Z", "failure"],
			] as const) {
				insert.run(
					id,
					startedAt,
					startedAt,
					status,
					startedAt.replace("T", " "),
				);
			}
			const read = () =>
				sqlite
					.prepare("SELECT * FROM platform_cron_executions ORDER BY id")
					.all();
			const before = read();
			const now = "2026-08-09T12:00:00.000Z";
			await expect(
				terminalizeAbandonedPlatformCronExecutions(db, now, 1, 2),
			).resolves.toBe(2);
			const recovered = sqlite
				.prepare("SELECT * FROM platform_cron_executions WHERE id = 'orphan-1'")
				.get();
			expect(recovered).toMatchObject({
				status: "failure",
				finished_at: now,
				duration_ms: null,
				error: "Cron receipt abandoned: no finish recorded within six hours",
			});
			// A delayed delivery must not replace the recovered terminal outcome.
			await recordPlatformCronExecutionFinish(db, {
				...start,
				id: "orphan-1",
				scheduleId: "retention",
				scheduledAt: "2026-01-01T00:00:00.000Z",
				finishedAt: now,
				status: "success",
				durationMs: 1_000,
				affectedRowCounts: {},
			});
			expect(
				sqlite
					.prepare(
						"SELECT * FROM platform_cron_executions WHERE id = 'orphan-1'",
					)
					.get(),
			).toEqual(recovered);
			await expect(
				terminalizeAbandonedPlatformCronExecutions(db, now, 1, 2),
			).resolves.toBe(1);
			await expect(
				terminalizeAbandonedPlatformCronExecutions(db, now, 1, 2),
			).resolves.toBe(0);
			expect(
				read().filter((row) => !String(row.id).startsWith("orphan-")),
			).toEqual(before.filter((row) => !String(row.id).startsWith("orphan-")));
		} finally {
			sqlite.close();
		}
	});
});

for (const store of ["d1", "postgres"] as const)
	describe(`migrated cron ${store}`, () => {
		let db: DbClient;
		let close: () => void | Promise<void>;
		beforeAll(async () => {
			if (store === "d1") {
				const sqlite = createMigratedSqlite();
				db = createDbClient(createD1Facade(sqlite, { maxBoundParams: 100 }));
				close = () => sqlite.close();
			} else {
				const fixture = await createPGliteFacade();
				db = fixture.db;
				close = fixture.close;
				for (const migration of readMigrationFiles({
					migrationsFolder: fileURLToPath(
						new URL("../../drizzle-pg", import.meta.url),
					),
				})) {
					for (const ddl of migration.sql) await fixture.engine.exec(ddl);
				}
			}
		}, 30000);
		afterAll(async () => {
			await close?.();
		});

		it("preserves monotonic boundaries, null initial CAS fences, stale fences and cursors", async () => {
			await advancePlatformCronCheckpoint(db, {
				scheduleId: "cas",
				mode: "cas",
				previous: null,
				through: "first",
			});
			await advancePlatformCronCheckpoint(db, {
				scheduleId: "cas",
				mode: "cas",
				previous: null,
				through: "stale",
			});
			expect(await getPlatformCronCheckpoint(db, "cas")).toBe("first");
			const cursor = { changedAt: "now", key: "key", tediId: "tedi" };
			await advancePlatformCronCheckpoint(db, {
				scheduleId: "cas",
				mode: "cas",
				previous: "first",
				through: "second",
				cursor,
			});
			await advancePlatformCronCheckpoint(db, {
				scheduleId: "cas",
				mode: "cas",
				previous: "second",
				through: "third",
				cursor: null,
			});
			const checkpoints = coreTable(db, platformCronCheckpoints);
			expect(
				await db
					.select()
					.from(checkpoints)
					.where(eq(checkpoints.scheduleId, "cas")),
			).toEqual([{ scheduleId: "cas", through: "third", cursor }]);
			await putPlatformCronCheckpoint(db, "numeric", "9");
			await advancePlatformCronCheckpoint(db, {
				scheduleId: "numeric",
				mode: "numeric",
				through: "3000000000",
			});
			await advancePlatformCronCheckpoint(db, {
				scheduleId: "numeric",
				mode: "numeric",
				through: "10",
			});
			expect(await getPlatformCronCheckpoint(db, "numeric")).toBe("3000000000");
			await putPlatformCronCheckpoint(db, "newer", "2026-01-01");
			await advancePlatformCronCheckpoint(db, {
				scheduleId: "newer",
				mode: "newer",
				through: "2026-02-01",
			});
			await advancePlatformCronCheckpoint(db, {
				scheduleId: "newer",
				mode: "newer",
				through: "2026-01-02",
			});
			expect(await getPlatformCronCheckpoint(db, "newer")).toBe("2026-02-01");
		});

		it("collapses repeated advances and receipts into one deferred atomic batch", async () => {
			const batch = vi.spyOn(db, "batch");
			const stamp = {
				...start,
				id: "batch",
				scheduleId: "batch",
				finishedAt: "2026-08-09T01:40:02.000Z",
				status: "success" as const,
				durationMs: 1000,
				affectedRowCounts: { expired: 3 },
			};
			try {
				await withPlatformCronWriteBatch(
					db,
					async () => {
						await recordPlatformCronExecutionFinish(db, stamp);
						await recordPlatformCronExecutionFinish(db, {
							...stamp,
							id: "duplicate",
							status: "failure",
						});
						for (const [previous, through] of [
							[null, "a"],
							["a", "b"],
							["stale", "bad"],
						])
							await advancePlatformCronCheckpoint(db, {
								scheduleId: "batch",
								mode: "cas",
								previous,
								through: through!,
							});
						for (const through of ["9", "10", "2"])
							await advancePlatformCronCheckpoint(db, {
								scheduleId: "batch-number",
								mode: "numeric",
								through,
							});
						for (const through of ["b", "c", "a"])
							await advancePlatformCronCheckpoint(db, {
								scheduleId: "batch-newer",
								mode: "newer",
								through,
							});
						expect(await getPlatformCronCheckpoint(db, "batch")).toBeNull();
					},
					async (write) => {
						await write();
					},
				);
				expect(batch).toHaveBeenCalledTimes(1);
				expect(batch.mock.calls[0]![0]).toHaveLength(2);
				expect(await getPlatformCronCheckpoint(db, "batch")).toBe("b");
				expect(await getPlatformCronCheckpoint(db, "batch-number")).toBe("10");
				expect(await getPlatformCronCheckpoint(db, "batch-newer")).toBe("c");
				expect(
					await listPlatformCronExecutionSummaries(
						db,
						["batch", "batch", "missing"],
						new Date("2026-08-09T02:00:00.000Z"),
					),
				).toEqual([
					expect.objectContaining({
						latestId: "batch",
						latestAffectedRowCounts: { expired: 3 },
						countsLast24h: { running: 0, success: 1, failure: 0 },
					}),
				]);
				await expect(
					withPlatformCronWriteBatch(
						db,
						async () => {
							await recordPlatformCronExecutionFinish(db, {
								...stamp,
								id: "rollback",
								scheduleId: "rollback",
							});
							await advancePlatformCronCheckpoint(db, {
								scheduleId: "invalid",
								mode: "newer",
								through: null as unknown as string,
							});
						},
						async (write) => {
							await write();
						},
					),
				).rejects.toThrow();
				const executions = coreTable(db, platformCronExecutions);
				expect(
					await db
						.select()
						.from(executions)
						.where(eq(executions.id, "rollback")),
				).toEqual([]);
			} finally {
				batch.mockRestore();
			}
		});

		it("keeps first terminal outcomes and recovers abandoned starts", async () => {
			const stamp = { ...start, id: "direct", scheduleId: "direct" };
			expect(await recordPlatformCronExecutionStart(db, stamp)).toBe(true);
			expect(
				await recordPlatformCronExecutionStart(db, {
					...stamp,
					id: "direct-duplicate",
				}),
			).toBe(false);
			expect(
				await terminalizeAbandonedPlatformCronExecutions(
					db,
					"2026-08-10T02:00:00.000Z",
					1,
					2,
				),
			).toBe(1);
			await recordPlatformCronExecutionFinish(db, {
				...stamp,
				status: "success",
				finishedAt: "later",
				durationMs: 1,
				affectedRowCounts: {},
			});
			expect(
				await listPlatformCronExecutionSummaries(
					db,
					["direct"],
					new Date("2026-08-10T02:00:00.000Z"),
				),
			).toEqual([
				expect.objectContaining({
					latestStatus: "failure",
					latestError:
						"Cron receipt abandoned: no finish recorded within six hours",
				}),
			]);
		});
	});
