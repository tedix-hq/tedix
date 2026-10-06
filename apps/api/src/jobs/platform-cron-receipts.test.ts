import { DatabaseSync } from "node:sqlite";
import { createD1Facade } from "@tedix/db/test/d1-facade";
import { describe, expect, it, vi } from "vite-plus/test";
import { runPlatformCronPath } from "./platform-cron-receipts";

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
	return {
		env: { DB: createD1Facade(sqlite) } as CloudflareEnv,
		event: {
			cron: "*/2 * * * *",
			scheduledTime: Date.parse("2026-08-09T02:00:00.000Z"),
			noRetry: () => {},
		} as ScheduledController,
		sqlite,
	};
}

describe("platform cron path receipts", () => {
	it("writes bounded affected-row counts on success", async () => {
		const { env, event, sqlite } = fixture();
		const counts = Object.fromEntries(
			Array.from({ length: 40 }, (_, index) => [`count${index}`, index]),
		);
		counts.invalid = -1;

		await runPlatformCronPath(env, event, "lease-expiry", async () => counts);

		const row = sqlite
			.prepare(
				"SELECT status, affected_row_counts AS counts, error FROM platform_cron_executions",
			)
			.get() as { status: string; counts: string; error: string | null };
		expect(row.status).toBe("success");
		expect(Object.keys(JSON.parse(row.counts))).toHaveLength(32);
		expect(row.error).toBeNull();
	});

	it("runs a duplicate delivery but preserves one immutable terminal receipt", async () => {
		const { env, event, sqlite } = fixture();
		const first = vi.fn(async () => ({ updated: 1 }));
		const duplicate = vi.fn(async () => ({ updated: 2 }));

		await runPlatformCronPath(env, event, "lease-expiry", first);
		await runPlatformCronPath(env, event, "lease-expiry", duplicate);

		expect(first).toHaveBeenCalledOnce();
		expect(duplicate).toHaveBeenCalledOnce();
		expect(
			sqlite
				.prepare("SELECT count(*) AS count FROM platform_cron_executions")
				.get(),
		).toEqual({ count: 1 });
		expect(
			sqlite
				.prepare(
					"SELECT affected_row_counts AS counts FROM platform_cron_executions",
				)
				.get(),
		).toEqual({ counts: '{"updated":1}' });
	});

	it("seals a content-free cause chain before rethrowing the original error", async () => {
		const { env, event, sqlite } = fixture();
		const secret = "Bearer sensitive-provider-token";
		const failure = new Error(`provider failed: ${secret}`, {
			cause: new TypeError(`invalid response: ${secret}`),
		});

		await expect(
			runPlatformCronPath(env, event, "provider-sync", async () => {
				throw failure;
			}),
		).rejects.toBe(failure);

		const row = sqlite
			.prepare(
				"SELECT status, duration_ms AS durationMs, error FROM platform_cron_executions",
			)
			.get() as { status: string; durationMs: number; error: string };
		expect(row.status).toBe("failure");
		expect(row.durationMs).toBeGreaterThanOrEqual(0);
		expect(JSON.parse(row.error)).toEqual({
			type: "Error",
			cause: { type: "TypeError" },
		});
		expect(row.error).not.toContain(secret);
	});

	it("keeps the path running when the start receipt fails and logs only topology", async () => {
		const secret = "Bearer receipt-token";
		const failure = new Error(`D1 failed: ${secret}`);
		const env = {
			DB: {
				prepare: () => {
					throw failure;
				},
			},
		} as unknown as CloudflareEnv;
		const event = fixture().event;
		const run = vi.fn(async () => {
			throw new Error("job failed");
		});
		const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			await expect(
				runPlatformCronPath(env, event, "provider-sync", run),
			).rejects.toThrow("job failed");
			expect(run).toHaveBeenCalledOnce();
			const records = errorLog.mock.calls.map(([line]) =>
				JSON.parse(String(line)),
			);
			expect(records).toEqual([
				{
					event: "platform.cron.receipt_start_failed",
					scheduleId: "provider-sync",
					exception: { type: "UnknownThrown", cause: { type: "Error" } },
				},
				{
					event: "platform.cron.receipt_finish_failed",
					scheduleId: "provider-sync",
					exception: { type: "UnknownThrown", cause: { type: "Error" } },
				},
			]);
			expect(JSON.stringify(errorLog.mock.calls)).not.toContain(secret);
		} finally {
			errorLog.mockRestore();
		}
	});
});
