import { DatabaseSync } from "node:sqlite";
import { createD1Facade } from "@tedix/db/test/d1-facade";
import { describe, expect, it, vi } from "vite-plus/test";
import {
	runPlatformCronPath,
	withPlatformCronReceipts,
} from "./platform-cron-receipts";
import { createDbQueryClient } from "@tedix/db/query-client";
import { advancePlatformCronCheckpoint } from "@tedix/db/queries/platform-cron-executions";

function fixture() {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec(`
		CREATE TABLE platform_cron_checkpoints (schedule_id TEXT PRIMARY KEY, through TEXT NOT NULL, cursor TEXT);
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
			cron: "1-59/2 * * * *",
			scheduledTime: Date.parse("2026-08-09T02:00:00.000Z"),
			noRetry: () => {},
		} as ScheduledController,
		sqlite,
	};
}

describe("platform cron path receipts", () => {
	it.each([27, 51])(
		"batches %i paths and flushes failure receipts before propagating dispatch errors",
		async (paths) => {
			const { env, event, sqlite } = fixture();
			event.cron = "*/2 * * * *";
			const db = createDbQueryClient(env.DB);
			const batch = vi.spyOn(env.DB, "batch");
			const failure = new Error("dispatch failed");
			if (paths === 51)
				batch.mockRejectedValueOnce(new Error("D1_ERROR: overloaded"));
			const tick = () =>
				withPlatformCronReceipts(env, async () => {
					for (let i = 0; i < paths; i++) {
						await runPlatformCronPath(env, event, `path-${i}`, async () => {
							if (i === paths - 1) throw failure;
							return { updated: i };
						}).catch((error) => {
							if (error !== failure) throw error;
						});
					}
					for (let i = 0; i < 6; i++)
						await advancePlatformCronCheckpoint(db, {
							scheduleId: `checkpoint-${i}`,
							through: "2",
							mode: "cas",
							previous: "1",
						});
					expect(
						sqlite
							.prepare("SELECT count(*) AS n FROM platform_cron_executions")
							.get(),
					).toEqual({ n: 0 });
					throw failure;
				});
			await expect(tick()).rejects.toBe(failure);
			expect(batch).toHaveBeenCalledTimes(paths === 51 ? 2 : 1);
			expect(batch.mock.calls.at(-1)![0]).toHaveLength(
				Math.ceil(paths / 50) + 1,
			);
			expect(
				sqlite
					.prepare(
						"SELECT status, count(*) AS n FROM platform_cron_executions GROUP BY status ORDER BY status",
					)
					.all(),
			).toEqual([
				{ status: "failure", n: 1 },
				{ status: "success", n: paths - 1 },
			]);
			expect(
				sqlite
					.prepare(
						"SELECT count(*) AS n FROM platform_cron_checkpoints WHERE through = '2'",
					)
					.get(),
			).toEqual({ n: 6 });
			// A stale CAS must not overwrite a newer concurrently saved boundary.
			sqlite.exec("UPDATE platform_cron_checkpoints SET through = '3'");
			await withPlatformCronReceipts(env, async () => {
				await advancePlatformCronCheckpoint(db, {
					scheduleId: "checkpoint-0",
					through: "4",
					mode: "cas",
					previous: "2",
				});
				await runPlatformCronPath(
					env,
					event,
					`path-${paths - 1}`,
					async () => ({
						updated: 1,
					}),
				);
			});
			expect(
				sqlite
					.prepare(
						"SELECT through FROM platform_cron_checkpoints WHERE schedule_id = 'checkpoint-0'",
					)
					.get(),
			).toEqual({ through: "3" });
			expect(
				sqlite
					.prepare(
						"SELECT status FROM platform_cron_executions WHERE schedule_id = ?",
					)
					.get(`path-${paths - 1}`),
			).toEqual({ status: "failure" });
		},
	);

	it("preserves monotonic checkpoint guards and cursor ownership in a batch", async () => {
		const { env, sqlite } = fixture();
		const db = createDbQueryClient(env.DB);
		sqlite.exec(
			`INSERT INTO platform_cron_checkpoints VALUES ('numeric', '9', '{"key":"keep"}'), ('newer', '3', NULL), ('cas', '3', NULL)`,
		);
		const cursor = { changedAt: "4", key: "new", tediId: "test" };
		await withPlatformCronReceipts(env, async () => {
			await advancePlatformCronCheckpoint(db, {
				scheduleId: "numeric",
				through: "10",
				mode: "numeric",
			});
			await advancePlatformCronCheckpoint(db, {
				scheduleId: "numeric",
				through: "2",
				mode: "numeric",
			});
			await advancePlatformCronCheckpoint(db, {
				scheduleId: "newer",
				through: "2",
				mode: "newer",
				cursor,
			});
			await advancePlatformCronCheckpoint(db, {
				scheduleId: "cas",
				through: "4",
				mode: "cas",
				previous: null,
			});
		});
		expect(
			sqlite
				.prepare(
					"SELECT schedule_id, through, cursor FROM platform_cron_checkpoints ORDER BY schedule_id",
				)
				.all(),
		).toEqual([
			{ schedule_id: "cas", through: "3", cursor: null },
			{ schedule_id: "newer", through: "3", cursor: null },
			{ schedule_id: "numeric", through: "10", cursor: '{"key":"keep"}' },
		]);
		await withPlatformCronReceipts(env, async () => {
			await advancePlatformCronCheckpoint(db, {
				scheduleId: "newer",
				through: "4",
				mode: "newer",
				cursor,
			});
		});
		expect(
			sqlite
				.prepare(
					"SELECT through, cursor FROM platform_cron_checkpoints WHERE schedule_id = 'newer'",
				)
				.get(),
		).toEqual({ through: "4", cursor: JSON.stringify(cursor) });
	});

	it("does not replay maintenance when the final batch permanently fails", async () => {
		const { env, event } = fixture();
		event.cron = "*/2 * * * *";
		const batch = vi
			.spyOn(env.DB, "batch")
			.mockRejectedValue(new Error("D1_ERROR: no such column"));
		const log = vi.spyOn(console, "error").mockImplementation(() => {});
		const run = vi.fn(async () => ({ updated: 1 }));
		try {
			await expect(
				withPlatformCronReceipts(env, () =>
					runPlatformCronPath(env, event, "path", run),
				),
			).resolves.toBeUndefined();
			expect(batch).toHaveBeenCalledOnce();
			expect(run).toHaveBeenCalledOnce();
			expect(JSON.parse(String(log.mock.calls[0]?.[0])).event).toBe(
				"platform.cron.receipt_batch_failed",
			);
		} finally {
			log.mockRestore();
		}
	});

	it.each(["success", "failure"])(
		"writes one immutable %s receipt per frequent path",
		async (status) => {
			const { env, event, sqlite } = fixture();
			event.cron = "*/2 * * * *";
			const prepare = vi.spyOn(env.DB, "prepare");
			const failure = new Error("job failed");
			const run = () =>
				runPlatformCronPath(env, event, "lease-expiry", async () => {
					expect(
						sqlite
							.prepare("SELECT count(*) AS n FROM platform_cron_executions")
							.get(),
					).toEqual({ n: 0 });
					if (status === "failure") throw failure;
					return { updated: 1 };
				});
			if (status === "failure") await expect(run()).rejects.toBe(failure);
			else await run();
			expect(prepare).toHaveBeenCalledTimes(1);
			await runPlatformCronPath(env, event, "lease-expiry", async () => ({
				updated: 2,
			}));
			expect(
				sqlite
					.prepare(
						"SELECT status, affected_row_counts AS counts FROM platform_cron_executions",
					)
					.get(),
			).toEqual({
				status,
				counts: status === "success" ? '{"updated":1}' : "{}",
			});
		},
	);
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

	it.each(["success", "failure"] as const)(
		"retries the same %s receipt through transient D1 overload without rerunning the job",
		async (status) => {
			const { env, event, sqlite } = fixture();
			const failure = new Error("job failed");
			const run = vi.fn(async () => {
				if (status === "failure") throw failure;
				return { updated: 1 };
			});
			const originalPrepare = env.DB.prepare.bind(env.DB);
			const writes: unknown[][] = [];
			vi.spyOn(env.DB, "prepare").mockImplementation((query) => {
				const statement = originalPrepare(query);
				if (!/do update set/i.test(query)) return statement;
				return {
					...statement,
					bind: (...values: unknown[]) => {
						writes.push(values);
						const bound = statement.bind(...values);
						if (writes.length > 1) return bound;
						return {
							...bound,
							run: async () => {
								throw new Error("D1_ERROR", {
									cause: new Error("overloaded"),
								});
							},
						};
					},
				};
			});

			const observed = runPlatformCronPath(
				env,
				event,
				"retention-cleanup",
				run,
			);
			if (status === "failure") await expect(observed).rejects.toBe(failure);
			else await expect(observed).resolves.toBeUndefined();
			expect(run).toHaveBeenCalledOnce();
			expect(writes).toHaveLength(2);
			expect(writes[0]).toEqual(writes[1]);
			expect(
				sqlite
					.prepare(
						"SELECT status, affected_row_counts AS counts FROM platform_cron_executions",
					)
					.all(),
			).toEqual([
				{ status, counts: status === "success" ? '{"updated":1}' : "{}" },
			]);
		},
	);

	it("does not retry or reclassify a permanent error writing a successful receipt", async () => {
		const { env, event, sqlite } = fixture();
		const run = vi.fn(async () => ({ updated: 1 }));
		const originalPrepare = env.DB.prepare.bind(env.DB);
		let finishWrites = 0;
		vi.spyOn(env.DB, "prepare").mockImplementation((query) => {
			if (/do update set/i.test(query)) {
				finishWrites++;
				throw new Error("D1_ERROR: no such column");
			}
			return originalPrepare(query);
		});
		const log = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			await expect(
				runPlatformCronPath(env, event, "retention-cleanup", run),
			).rejects.toThrow();
			expect(run).toHaveBeenCalledOnce();
			expect(finishWrites).toBe(1);
			expect(
				sqlite.prepare("SELECT status FROM platform_cron_executions").get(),
			).toEqual({ status: "running" });
			expect(log).toHaveBeenCalledOnce();
			expect(JSON.parse(String(log.mock.calls[0]?.[0])).event).toBe(
				"platform.cron.receipt_finish_failed",
			);
		} finally {
			log.mockRestore();
		}
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
			causeChain: [{}],
		});
		expect(row.error).not.toContain(secret);
	});

	it("records HTTP status without retaining the response body", async () => {
		const { env, event, sqlite } = fixture();
		const failure = new Error(
			"Tedi wake failed with HTTP 503: private-response",
		);
		await expect(
			runPlatformCronPath(env, event, "commitment-wakes", async () => {
				throw failure;
			}),
		).rejects.toBe(failure);
		const row = sqlite
			.prepare("SELECT error FROM platform_cron_executions")
			.get()!;
		expect(JSON.parse(String(row.error))).toMatchObject({ httpStatus: "503" });
		expect(String(row.error)).not.toContain("private-response");
	});
	it("records the timeout cause and logs it even if the finish receipt fails", async () => {
		const { env, event, sqlite } = fixture();
		const log = vi.spyOn(console, "error").mockImplementation(() => {});
		const failure = new AggregateError(
			[new Error("Commitment wake delivery timed out")],
			"Commitment wake delivery failed",
			{ cause: new Error("Commitment wake delivery timed out") },
		);
		try {
			await expect(
				runPlatformCronPath(env, event, "commitment-wakes", async () => {
					throw failure;
				}),
			).rejects.toBe(failure);
			const row = sqlite
				.prepare("SELECT error FROM platform_cron_executions")
				.get()!;
			expect(String(row.error)).toContain("timed out");
			sqlite.exec("DROP TABLE platform_cron_executions");
			await expect(
				runPlatformCronPath(env, event, "commitment-wakes", async () => {
					throw failure;
				}),
			).rejects.toBe(failure);
			expect(JSON.stringify(log.mock.calls)).toContain("timed out");
		} finally {
			log.mockRestore();
		}
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
				expect.objectContaining({
					event: "platform.cron.path_failed",
					scheduleId: "provider-sync",
					executionId: expect.any(String),
					type: "Error",
				}),
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
