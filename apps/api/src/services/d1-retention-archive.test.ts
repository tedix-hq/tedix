import { DatabaseSync } from "node:sqlite";
import { createDbQueryClient } from "@tedix/db/query-client";
import { auditEvents } from "@tedix/db/schema/audit-events";
import { tediRuntimeEvents } from "@tedix/db/schema/cognitive-runtime";
import { d1RetentionPolicies } from "@tedix/db/schema/d1-retention";
import { createD1Facade } from "@tedix/db/test/d1-facade";
import { schemaDdl, tableDdl } from "@tedix/db/test/schema-ddl";
import { describe, expect, it } from "vite-plus/test";
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
	async put(key: string, value: Uint8Array) {
		if (this.failPuts) throw new Error("r2 unavailable");
		this.objects.set(key, value);
		return { key };
	}
	async head(key: string) {
		const value = this.objects.get(key);
		return value ? { key, size: value.byteLength } : null;
	}
}

function fixture(policies: string) {
	const sqlite = new DatabaseSync(":memory:", {
		enableForeignKeyConstraints: false,
	});
	sqlite.exec(schemaDdl(auditEvents, tediRuntimeEvents, d1RetentionPolicies));
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
	return {
		sqlite,
		db: createDbQueryClient(createD1Facade(sqlite)),
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
		[auditEvents, tediRuntimeEvents]
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
	return { sqlite, db: createDbQueryClient(createD1Facade(sqlite)), count };
}

async function gunzipLines(bytes: Uint8Array): Promise<string[]> {
	const text = await new Response(
		new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip")),
	).text();
	return text.trim().split("\n");
}

describe("runD1Retention", () => {
	it("dry run reports what it would free and changes no rows", async () => {
		const { db, seed, count, policy } = fixture(
			"('audit_events','dry_run',30,2000,'2026-10-21')",
		);
		seed([...Array.from({ length: 120 }, () => 90), 1, 1]);
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
		seed([...Array.from({ length: 620 }, () => 90), 5, 2]);
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
		seed(Array.from({ length: 60 }, () => 90));
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
		seed(Array.from({ length: 300 }, () => 90));
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
		seed([...Array.from({ length: 620 }, () => 90), 5, 2]);
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
			timestamp: Math.floor(NOW.getTime() / 1000) - 90 * DAY,
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
		seed(Array.from({ length: 40 }, () => 90));
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
		seed(Array.from({ length: 60 }, () => 90));
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

	it("reports a missing logs binding and changes nothing", async () => {
		const { db, seed, count, policy } = fixture(
			"('audit_events','move_to_logs_db',30,2000,'2026-10-21'), ('tedi_call_costs','move_to_logs_db',400,2000,'2026-10-21')",
		);
		seed(Array.from({ length: 10 }, () => 90));
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
		seed([...Array.from({ length: 30 }, () => 45), 20, 20, 20]);
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
			keepDays: 30,
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
