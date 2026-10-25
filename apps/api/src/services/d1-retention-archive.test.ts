import { DatabaseSync } from "node:sqlite";
import { createDbQueryClient } from "@tedix/db/query-client";
import { auditEvents } from "@tedix/db/schema/audit-events";
import { skillRunArtifacts } from "@tedix/db/schema/cognitive";
import { tediRuntimeEvents } from "@tedix/db/schema/cognitive-runtime";
import { d1RetentionPolicies } from "@tedix/db/schema/d1-retention";
import { createD1Facade } from "@tedix/db/test/d1-facade";
import { schemaDdl, tableDdl } from "@tedix/db/test/schema-ddl";
import { describe, expect, it, vi } from "vite-plus/test";
import {
	D1_ARCHIVE_PREFIX,
	runD1Retention,
	withOverloadBackoff,
} from "./d1-retention-archive";

const NOW = new Date("2026-10-21T12:00:00.000Z");
const DAY = 86_400;

class MemoryBucket {
	readonly objects = new Map<string, Uint8Array>();
	failPuts = false;
	/** Simulates a write R2 acknowledged with the wrong size. */
	shortPuts = false;
	puts = 0;
	async put(key: string, value: Uint8Array) {
		this.puts += 1;
		if (this.failPuts) throw new Error("r2 unavailable");
		this.objects.set(key, value);
		return { key, size: value.byteLength - (this.shortPuts ? 1 : 0) };
	}
}

/** Count what reaches a D1 database: statements outside batches, and batches. */
function countCalls(d1: D1Database) {
	const calls = { statements: 0, batches: 0 };
	const batched = new WeakSet<object>();
	const prepare = d1.prepare.bind(d1);
	const batch = d1.batch.bind(d1);
	d1.prepare = (query: string) => {
		const statement = prepare(query);
		const bind = statement.bind.bind(statement);
		const counted = (target: D1PreparedStatement): D1PreparedStatement => {
			for (const method of ["all", "run", "first", "raw"] as const) {
				const original = target[method].bind(target) as (
					...args: unknown[]
				) => unknown;
				(target as unknown as Record<string, unknown>)[method] = (
					...args: unknown[]
				) => {
					if (!batched.has(target)) calls.statements += 1;
					return original(...args);
				};
			}
			return target;
		};
		statement.bind = (...values: unknown[]) => counted(bind(...values));
		return counted(statement);
	};
	d1.batch = (statements) => {
		calls.batches += 1;
		for (const statement of statements) batched.add(statement);
		return batch(statements);
	};
	return calls;
}

function fixture(policies: string) {
	const sqlite = new DatabaseSync(":memory:", {
		enableForeignKeyConstraints: false,
	});
	sqlite.exec(
		schemaDdl(
			auditEvents,
			tediRuntimeEvents,
			skillRunArtifacts,
			d1RetentionPolicies,
		),
	);
	sqlite.exec(
		`INSERT INTO d1_retention_policies(table_name, mode, keep_days, max_rows_per_run, updated_at) VALUES ${policies}`,
	);
	const insert = sqlite.prepare(
		"INSERT INTO audit_events(id, organization_id, actor_id, actor_type, action, resource_type, metadata, timestamp) VALUES(?,?,?,?,?,?,?,?)",
	);
	const insertRuntime = sqlite.prepare(
		"INSERT INTO tedi_runtime_events(id, organization_id, tedi_id, kind, runtime_backend, payload, created_at) VALUES(?,?,?,?,?,?,?)",
	);
	const seedRuntime = (ages: number[]) =>
		ages.forEach((age, index) =>
			insertRuntime.run(
				`runtime-${index}`,
				"fictional-lighthouse",
				"tedi-ada",
				"tool.completed",
				"custom",
				JSON.stringify({ n: index, body: "x".repeat(64) }),
				new Date(NOW.getTime() - age * DAY * 1000).toISOString(),
			),
		);
	const nowSeconds = Math.floor(NOW.getTime() / 1000);
	const seed = (ages: number[]) =>
		ages.forEach((age, index) =>
			insert.run(
				`audit-${index}`,
				"fictional-lighthouse",
				"user-ada",
				"user",
				"mcp.tool.execute",
				"mcp_tool",
				JSON.stringify({ n: index }),
				nowSeconds - age * DAY,
			),
		);
	const count = (table = "audit_events") =>
		Number(
			(
				sqlite.prepare(`SELECT count(*) AS n FROM ${table}`).get() as {
					n: number;
				}
			).n,
		);
	const policy = (table: string) =>
		sqlite
			.prepare(
				"SELECT last_report AS report, archived_rows_total AS archived, deleted_rows_total AS deleted FROM d1_retention_policies WHERE table_name = ?",
			)
			.get(table) as { report: string; archived: number; deleted: number };
	const d1 = createD1Facade(sqlite);
	return {
		sqlite,
		d1,
		db: createDbQueryClient(d1),
		seed,
		seedRuntime,
		count,
		policy,
	};
}

/** A logs database: the same tables without foreign keys, no parent tables. */
function logsFixture() {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec(
		[auditEvents, tediRuntimeEvents, skillRunArtifacts]
			.flatMap((table) => tableDdl(table, { foreignKeys: false }))
			.join("\n"),
	);
	const count = (table = "audit_events") =>
		Number(
			(
				sqlite.prepare(`SELECT count(*) AS n FROM ${table}`).get() as {
					n: number;
				}
			).n,
		);
	const d1 = createD1Facade(sqlite);
	return { sqlite, d1, db: createDbQueryClient(d1), count };
}

async function gunzipLines(bytes: Uint8Array): Promise<string[]> {
	const text = await new Response(
		new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip")),
	).text();
	return text.trim().split("\n");
}

describe("runD1Retention", () => {
	it.each(["move_to_logs_db", "archive_then_delete"] as const)(
		"%s skips a newer row and drains later expired rowids over repeated ticks",
		async (mode) => {
			const { db, seed, sqlite } = fixture(
				`('audit_events','${mode}',30,2,'2026-10-21')`,
			);
			seed([120, 1, 120, 120]);
			const logs = logsFixture();
			const bucket = new MemoryBucket();
			const tick = () =>
				runD1Retention({
					db,
					logsDb: logs.db,
					bucket: bucket as unknown as R2Bucket,
					now: NOW,
				});
			const first = await tick();
			const second = await tick();
			const third = await tick();
			expect([
				first.deletedRows,
				second.deletedRows,
				third.deletedRows,
			]).toEqual([2, 1, 0]);
			expect(
				sqlite.prepare("SELECT id FROM audit_events ORDER BY rowid").all(),
			).toEqual([{ id: "audit-1" }]);
			const archived = (
				await Promise.all([...bucket.objects.values()].map(gunzipLines))
			)
				.flat()
				.map((line) => JSON.parse(line).id);
			expect(archived.sort()).toEqual(["audit-0", "audit-2", "audit-3"]);
			if (mode === "move_to_logs_db") expect(logs.count()).toBe(3);
		},
	);

	it.each(["move_to_logs_db", "archive_then_delete"] as const)(
		"%s retains an artifact body and its reachable pointer or refuses the policy",
		async (mode) => {
			const { db, sqlite, count } = fixture(
				`('skill_run_artifacts','${mode}',14,10,'2026-10-21')`,
			);
			const logs = logsFixture();
			const key = "fictional-run/bodies/artifact-1";
			sqlite
				.prepare(
					"INSERT INTO skill_run_artifacts(id,run_id,path,content_r2_key,created_at) VALUES(?,?,?,?,?)",
				)
				.run(
					"artifact-1",
					"fictional-run",
					"result.json",
					key,
					"2026-07-01 10:00:00",
				);
			const bucket = new MemoryBucket();
			const body = new TextEncoder().encode('{"result":"retained"}');
			bucket.objects.set(key, body);
			const result = await runD1Retention({
				db,
				logsDb: logs.db,
				bucket: bucket as unknown as R2Bucket,
				now: NOW,
			});
			expect(bucket.objects.get(key)).toEqual(body);
			if (mode === "archive_then_delete") {
				expect(result.tables[0]?.problem).toBe("logs_copy_required");
				expect(result.deletedRows).toBe(0);
				expect(count("skill_run_artifacts")).toBe(1);
			} else {
				expect(result.tables[0]?.problem).toBeNull();
				expect(result.deletedRows).toBe(1);
				expect(
					logs.sqlite
						.prepare(
							"SELECT content_r2_key FROM skill_run_artifacts WHERE id = 'artifact-1'",
						)
						.get(),
				).toEqual({ content_r2_key: key });
			}
		},
	);

	it("resumes scanning past retained pages after the time budget and wraps to reconsider them", async () => {
		const { db, seed, count, policy } = fixture(
			"('audit_events','archive_then_delete',30,2000,'2026-10-21')",
		);
		seed([...Array.from({ length: 1000 }, () => 1), 120]);
		const bucket = new MemoryBucket();
		let clock = 0;
		const mocked = vi.spyOn(Date, "now").mockImplementation(() => clock++);
		try {
			const tick = () =>
				runD1Retention({
					db,
					bucket: bucket as unknown as R2Bucket,
					now: NOW,
					timeBudgetMs: 3,
				});
			const first = await tick();
			expect(first.tables[0]).toMatchObject({
				deletedRows: 0,
				stoppedBy: "time_budget",
				scanAfterRowid: 500,
			});
			expect(JSON.parse(policy("audit_events").report).scanAfterRowid).toBe(
				500,
			);
			await tick();
			const third = await tick();
			expect(third.deletedRows).toBe(1);
			expect(count()).toBe(1000);
		} finally {
			mocked.mockRestore();
		}
		await runD1Retention({
			db,
			bucket: bucket as unknown as R2Bucket,
			now: NOW,
		});
		expect(JSON.parse(policy("audit_events").report).scanAfterRowid).toBe(-1);
		const later = await runD1Retention({
			db,
			bucket: bucket as unknown as R2Bucket,
			now: new Date(NOW.getTime() + 90 * DAY * 1000),
		});
		expect(later.deletedRows).toBe(1000);
		expect(count()).toBe(0);
	});

	it("skips an entire scan window of retained rows and keeps invalid timestamps", async () => {
		const { db, seedRuntime, sqlite, count } = fixture(
			"('tedi_runtime_events','archive_then_delete',14,2000,'2026-10-21')",
		);
		seedRuntime([...Array.from({ length: 501 }, () => 1), 90, 90]);
		sqlite
			.prepare(
				"UPDATE tedi_runtime_events SET created_at = '0000-invalid' WHERE id = 'runtime-501'",
			)
			.run();
		const bucket = new MemoryBucket();
		const result = await runD1Retention({
			db,
			bucket: bucket as unknown as R2Bucket,
			now: NOW,
		});
		expect(result.tables[0]).toMatchObject({
			archivedRows: 1,
			deletedRows: 1,
			stoppedBy: "done",
		});
		expect(count("tedi_runtime_events")).toBe(502);
		const archived = await gunzipLines(
			[...bucket.objects.values()][0] as Uint8Array,
		);
		expect(archived.map((line) => JSON.parse(line).id)).toEqual([
			"runtime-502",
		]);
	});

	it("dry run reports what it would free and changes no rows", async () => {
		const { db, seed, count, policy } = fixture(
			"('audit_events','dry_run',30,2000,'2026-10-21')",
		);
		seed([...Array.from({ length: 120 }, () => 120), 1, 1]);
		const bucket = new MemoryBucket();
		const result = await runD1Retention({
			db,
			bucket: bucket as unknown as R2Bucket,
			now: NOW,
		});
		expect(count()).toBe(122);
		expect(bucket.objects.size).toBe(0);
		expect(result.tables[0]).toMatchObject({
			tableName: "audit_events",
			mode: "dry_run",
			eligibleRows: 120,
			deletedRows: 0,
		});
		expect(result.eligibleBytes).toBeGreaterThan(0);
		expect(JSON.parse(policy("audit_events").report)).toMatchObject({
			mode: "dry_run",
			eligibleRows: 120,
		});
	});

	it("archives expired rows to R2 before deleting exactly those rows", async () => {
		const { db, seed, count, policy } = fixture(
			"('audit_events','archive_then_delete',30,2000,'2026-10-21')",
		);
		seed([...Array.from({ length: 620 }, () => 120), 5, 2]);
		const bucket = new MemoryBucket();
		const result = await runD1Retention({
			db,
			bucket: bucket as unknown as R2Bucket,
			now: NOW,
		});
		expect(result.tables[0]).toMatchObject({
			archivedRows: 620,
			deletedRows: 620,
			objects: 2,
			stoppedBy: "done",
		});
		expect(count()).toBe(2);
		const keys = [...bucket.objects.keys()].sort();
		expect(keys[0]?.startsWith(`${D1_ARCHIVE_PREFIX}audit_events/`)).toBe(true);
		const archived = await Promise.all(
			keys.map((key) => gunzipLines(bucket.objects.get(key) as Uint8Array)),
		);
		const rows = archived.flat().map((line) => JSON.parse(line));
		expect(rows).toHaveLength(620);
		expect(rows[0]).toMatchObject({ id: "audit-0", __rowid: 1 });
		expect(policy("audit_events")).toMatchObject({
			archived: 620,
			deleted: 620,
		});
	});

	it("keeps rows when the archive write fails and resumes on the next run", async () => {
		const { db, seed, count } = fixture(
			"('audit_events','archive_then_delete',30,2000,'2026-10-21')",
		);
		seed(Array.from({ length: 60 }, () => 120));
		const bucket = new MemoryBucket();
		bucket.failPuts = true;
		const failed = await runD1Retention({
			db,
			bucket: bucket as unknown as R2Bucket,
			now: NOW,
		});
		expect(failed.tables[0]).toMatchObject({
			stoppedBy: "error",
			deletedRows: 0,
		});
		expect(count()).toBe(60);

		bucket.failPuts = false;
		await runD1Retention({
			db,
			bucket: bucket as unknown as R2Bucket,
			now: NOW,
		});
		expect(count()).toBe(0);
	});

	it("respects the per-run row cap", async () => {
		const { db, seed, count } = fixture(
			"('audit_events','archive_then_delete',30,120,'2026-10-21')",
		);
		seed(Array.from({ length: 300 }, () => 120));
		const result = await runD1Retention({
			db,
			bucket: new MemoryBucket() as unknown as R2Bucket,
			now: NOW,
		});
		expect(result.tables[0]).toMatchObject({
			deletedRows: 120,
			stoppedBy: "row_cap",
		});
		expect(count()).toBe(180);
	});

	it("moves expired rows into the logs database, verifies them, archives, then deletes", async () => {
		const { db, seed, count, policy } = fixture(
			"('audit_events','move_to_logs_db',30,2000,'2026-10-21')",
		);
		seed([...Array.from({ length: 620 }, () => 120), 5, 2]);
		const logs = logsFixture();
		const bucket = new MemoryBucket();
		const result = await runD1Retention({
			db,
			logsDb: logs.db,
			bucket: bucket as unknown as R2Bucket,
			now: NOW,
		});
		expect(result.tables[0]).toMatchObject({
			mode: "move_to_logs_db",
			movedRows: 620,
			archivedRows: 620,
			deletedRows: 620,
			objects: 2,
			stoppedBy: "done",
		});
		expect(count()).toBe(2);
		expect(logs.count()).toBe(620);
		const copied = logs.sqlite
			.prepare(
				"SELECT id, organization_id, metadata, timestamp FROM audit_events WHERE id = 'audit-7'",
			)
			.get();
		expect(copied).toEqual({
			id: "audit-7",
			organization_id: "fictional-lighthouse",
			metadata: JSON.stringify({ n: 7 }),
			timestamp: Math.floor(NOW.getTime() / 1000) - 120 * DAY,
		});
		expect(bucket.objects.size).toBe(2);
		expect(JSON.parse(policy("audit_events").report)).toMatchObject({
			movedRows: 620,
			deletedRows: 620,
		});
	});

	it("moves wide runtime rows within the bound-parameter cap", async () => {
		const { db, seedRuntime, count } = fixture(
			"('tedi_runtime_events','move_to_logs_db',14,2000,'2026-10-21')",
		);
		seedRuntime([...Array.from({ length: 130 }, () => 40), 1]);
		const logs = logsFixture();
		const result = await runD1Retention({
			db,
			logsDb: logs.db,
			bucket: new MemoryBucket() as unknown as R2Bucket,
			now: NOW,
		});
		expect(result.tables[0]).toMatchObject({
			movedRows: 130,
			stoppedBy: "done",
		});
		expect(count("tedi_runtime_events")).toBe(1);
		expect(logs.count("tedi_runtime_events")).toBe(130);
		expect(
			logs.sqlite
				.prepare(
					"SELECT payload FROM tedi_runtime_events WHERE id = 'runtime-3'",
				)
				.get(),
		).toEqual({ payload: JSON.stringify({ n: 3, body: "x".repeat(64) }) });
	});

	it("never deletes a row whose logs copy did not read back identical", async () => {
		const { db, seed, count } = fixture(
			"('audit_events','move_to_logs_db',30,2000,'2026-10-21')",
		);
		seed(Array.from({ length: 40 }, () => 120));
		const logs = logsFixture();
		// A logs database that silently loses every tenth row.
		logs.sqlite.exec(
			"CREATE TRIGGER lose_rows AFTER INSERT ON audit_events WHEN NEW.id LIKE '%0' BEGIN DELETE FROM audit_events WHERE id = NEW.id; END;",
		);
		const bucket = new MemoryBucket();
		const result = await runD1Retention({
			db,
			logsDb: logs.db,
			bucket: bucket as unknown as R2Bucket,
			now: NOW,
		});
		expect(result.tables[0]).toMatchObject({
			stoppedBy: "error",
			movedRows: 0,
			deletedRows: 0,
		});
		expect(result.tables[0]?.error).toContain("logs copy not verified");
		expect(count()).toBe(40);
		expect(bucket.objects.size).toBe(0);
	});

	it("resumes a move that stopped between the logs copy and the delete", async () => {
		const { db, seed, count } = fixture(
			"('audit_events','move_to_logs_db',30,2000,'2026-10-21')",
		);
		seed(Array.from({ length: 60 }, () => 120));
		const logs = logsFixture();
		const bucket = new MemoryBucket();
		bucket.failPuts = true;
		const failed = await runD1Retention({
			db,
			logsDb: logs.db,
			bucket: bucket as unknown as R2Bucket,
			now: NOW,
		});
		expect(failed.tables[0]).toMatchObject({
			stoppedBy: "error",
			deletedRows: 0,
		});
		expect(count()).toBe(60);
		expect(logs.count()).toBe(60);

		bucket.failPuts = false;
		const resumed = await runD1Retention({
			db,
			logsDb: logs.db,
			bucket: bucket as unknown as R2Bucket,
			now: NOW,
		});
		expect(resumed.tables[0]).toMatchObject({ movedRows: 60, deletedRows: 60 });
		expect(count()).toBe(0);
		expect(logs.count()).toBe(60);
	});

	it("moves a page in one read, one logs batch, one archive write and one delete", async () => {
		const { db, d1, seed, count, policy } = fixture(
			"('audit_events','move_to_logs_db',30,10000,'2026-10-21')",
		);
		seed([...Array.from({ length: 1200 }, () => 120), 1]);
		const logs = logsFixture();
		const bucket = new MemoryBucket();
		const main = countCalls(d1);
		const logsCalls = countCalls(logs.d1);
		const result = await runD1Retention({
			db,
			logsDb: logs.db,
			bucket: bucket as unknown as R2Bucket,
			now: NOW,
		});
		expect(result.tables[0]).toMatchObject({
			movedRows: 1200,
			deletedRows: 1200,
			objects: 3,
			stoppedBy: "done",
			scanAfterRowid: -1,
		});
		expect(count()).toBe(1);
		expect(logs.count()).toBe(1200);
		// Three pages: one logs batch (copy + read-back) and one archive each.
		expect(logsCalls).toEqual({ statements: 0, batches: 3 });
		expect(bucket.puts).toBe(3);
		// Main: three page reads and three delete batches, plus the backlog
		// estimate (about eight point reads) and the policy bookkeeping; the
		// old 50-row pages took ten reads per page alone.
		expect(main.batches).toBe(3);
		expect(main.statements).toBeLessThanOrEqual(15);
		const report = JSON.parse(policy("audit_events").report);
		expect(report.timings).toMatchObject({ pages: 3 });
		expect(report.eligibleRows).toBe(0);
	});

	it("keeps rows when R2 acknowledges a different size than was written", async () => {
		const { db, seed, count } = fixture(
			"('audit_events','move_to_logs_db',30,2000,'2026-10-21')",
		);
		seed(Array.from({ length: 30 }, () => 120));
		const logs = logsFixture();
		const bucket = new MemoryBucket();
		bucket.shortPuts = true;
		const result = await runD1Retention({
			db,
			logsDb: logs.db,
			bucket: bucket as unknown as R2Bucket,
			now: NOW,
		});
		expect(result.tables[0]).toMatchObject({
			stoppedBy: "error",
			deletedRows: 0,
			archivedRows: 0,
		});
		expect(result.tables[0]?.error).toContain("archive object not confirmed");
		expect(count()).toBe(30);
	});

	it("leaves the cursor on the last deleted page when a later page fails", async () => {
		const { db, seed, count, policy } = fixture(
			"('audit_events','move_to_logs_db',30,10000,'2026-10-21')",
		);
		seed(Array.from({ length: 700 }, () => 120));
		const logs = logsFixture();
		// The second page's copy loses a row, so it never verifies.
		logs.sqlite.exec(
			"CREATE TRIGGER lose_row AFTER INSERT ON audit_events WHEN NEW.id = 'audit-650' BEGIN DELETE FROM audit_events WHERE id = NEW.id; END;",
		);
		const bucket = new MemoryBucket();
		const result = await runD1Retention({
			db,
			logsDb: logs.db,
			bucket: bucket as unknown as R2Bucket,
			now: NOW,
		});
		expect(result.tables[0]).toMatchObject({
			stoppedBy: "error",
			movedRows: 500,
			deletedRows: 500,
			scanAfterRowid: 500,
		});
		expect(count()).toBe(200);
		expect(JSON.parse(policy("audit_events").report).scanAfterRowid).toBe(500);
		expect(bucket.objects.size).toBe(1);
	});

	it("reports a missing logs binding and changes nothing", async () => {
		const { db, seed, count, policy } = fixture(
			"('audit_events','move_to_logs_db',30,2000,'2026-10-21'), ('tedi_call_costs','move_to_logs_db',400,2000,'2026-10-21')",
		);
		seed(Array.from({ length: 10 }, () => 120));
		const result = await runD1Retention({
			db,
			bucket: new MemoryBucket() as unknown as R2Bucket,
			now: NOW,
		});
		expect(result.tables.map((table) => table.problem)).toEqual([
			"logs_db_missing",
			"logs_db_unsupported",
		]);
		expect(count()).toBe(10);
		expect(JSON.parse(policy("audit_events").report)).toMatchObject({
			problem: "logs_db_missing",
		});
	});

	it("runs a window below the table floor at the floor and says so", async () => {
		const { db, seed, count, policy } = fixture(
			"('audit_events','dry_run',14,10000,'2026-10-21')",
		);
		seed([...Array.from({ length: 30 }, () => 100), 50, 50, 50]);
		const result = await runD1Retention({
			db,
			bucket: new MemoryBucket() as unknown as R2Bucket,
			now: NOW,
		});
		expect(result.tables[0]).toMatchObject({
			problem: null,
			eligibleRows: 30,
			stoppedBy: "done",
		});
		expect(count()).toBe(33);
		expect(JSON.parse(policy("audit_events").report)).toMatchObject({
			keepDays: 90,
			keepDaysRow: 14,
			eligibleRows: 30,
		});
	});

	it("refuses unsafe policies without touching rows", async () => {
		const { db, seed, count, policy } = fixture(
			"('audit_events','delete',90,2000,'2026-10-21'), ('organizations','delete',90,2000,'2026-10-21')",
		);
		seed(Array.from({ length: 10 }, () => 200));
		const result = await runD1Retention({ db, now: NOW });
		expect(result.tables.map((table) => table.problem)).toEqual([
			"archive_required",
			"unsupported_table",
		]);
		expect(count()).toBe(10);
		expect(JSON.parse(policy("audit_events").report)).toMatchObject({
			problem: "archive_required",
		});
	});
});

describe("withOverloadBackoff", () => {
	it("retries an overloaded statement with increasing waits, then succeeds", async () => {
		const waits: number[] = [];
		let calls = 0;
		const value = await withOverloadBackoff(
			async () => {
				calls += 1;
				if (calls < 3) throw new Error("D1_ERROR: D1 DB is overloaded");
				return "ok";
			},
			Date.now() + 60_000,
			async (ms) => {
				waits.push(ms);
			},
		);
		expect(value).toBe("ok");
		expect(waits).toEqual([500, 1000]);
	});

	it("does not retry other errors or past the deadline", async () => {
		await expect(
			withOverloadBackoff(
				async () => {
					throw new Error("D1_ERROR: no such table");
				},
				Date.now() + 60_000,
				async () => {},
			),
		).rejects.toThrow("no such table");
		let calls = 0;
		await expect(
			withOverloadBackoff(
				async () => {
					calls += 1;
					throw new Error("D1_ERROR: D1 DB is overloaded");
				},
				Date.now() + 100,
				async () => {},
			),
		).rejects.toThrow("overloaded");
		expect(calls).toBe(1);
	});
});
