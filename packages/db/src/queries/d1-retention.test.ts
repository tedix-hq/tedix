import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vite-plus/test";
import { createDbQueryClient } from "../query-client";
import { auditEvents } from "../schema/audit-events";
import { tediRuntimeEvents } from "../schema/cognitive-runtime";
import { d1RetentionPolicies } from "../schema/d1-retention";
import { createD1Facade } from "../test/d1-facade";
import { schemaDdl, tableDdl } from "../test/schema-ddl";
import {
	D1_LOGS_COPY_STATEMENT_BYTES,
	D1_RETENTION_PAGE_ROWS,
	buildD1LogsCopyStatements,
	buildD1RetentionDeleteStatements,
	copyD1RetentionRowsToLogs,
	d1RetentionCutoff,
	d1RetentionEffectiveKeepDays,
	d1RetentionPolicyProblem,
	deleteD1RetentionRows,
	estimateD1RetentionBacklog,
	getD1RetentionTableSpec,
	isD1RetentionExpired,
	listActiveD1RetentionPolicies,
	readD1RetentionPage,
	recordD1RetentionRun,
	verifyD1LogsCopy,
} from "./d1-retention";

const NOW = new Date("2026-10-21T12:00:00.000Z");
const DAY = 86_400;

function fixture() {
	const sqlite = new DatabaseSync(":memory:", {
		enableForeignKeyConstraints: false,
	});
	sqlite.exec(schemaDdl(auditEvents, tediRuntimeEvents, d1RetentionPolicies));
	const db = createDbQueryClient(createD1Facade(sqlite));
	const insertAudit = sqlite.prepare(
		"INSERT INTO audit_events(id, organization_id, actor_id, actor_type, action, resource_type, metadata, timestamp) VALUES(?,?,?,?,?,?,?,?)",
	);
	const insertRuntime = sqlite.prepare(
		"INSERT INTO tedi_runtime_events(id, organization_id, tedi_id, kind, runtime_backend, payload, created_at) VALUES(?,?,?,?,?,?,?)",
	);
	const nowSeconds = Math.floor(NOW.getTime() / 1000);
	/** Audit rows `ageDays` old, oldest first, so rowid tracks time. */
	const seedAudit = (ages: number[]) => {
		ages.forEach((age, index) => {
			insertAudit.run(
				`audit-${index}`,
				"fictional-lighthouse",
				"user-ada",
				"user",
				"mcp.tool.execute",
				"mcp_tool",
				JSON.stringify({ n: index }),
				nowSeconds - age * DAY,
			);
		});
	};
	const count = (table: string) =>
		Number(
			(
				sqlite.prepare(`SELECT count(*) AS n FROM ${table}`).get() as {
					n: number;
				}
			).n,
		);
	return { sqlite, db, seedAudit, insertRuntime, count };
}

const audit = () => {
	const spec = getD1RetentionTableSpec("audit_events");
	if (!spec) throw new Error("audit_events must be supported");
	return spec;
};

describe("d1 retention policy validation", () => {
	it("refuses unknown tables and unarchived deletes of evidence, and raises windows below the floor", () => {
		expect(
			d1RetentionPolicyProblem({
				tableName: "organizations",
				mode: "delete",
				keepDays: 365,
			}),
		).toBe("unsupported_table");
		expect(
			d1RetentionPolicyProblem({
				tableName: "audit_events",
				mode: "archive_then_delete",
				keepDays: 7,
			}),
		).toBeNull();
		expect(d1RetentionEffectiveKeepDays(audit(), { keepDays: 7 })).toBe(90);
		expect(d1RetentionEffectiveKeepDays(audit(), { keepDays: 120 })).toBe(120);
		expect(
			d1RetentionPolicyProblem({
				tableName: "audit_events",
				mode: "delete",
				keepDays: 90,
			}),
		).toBe("archive_required");
		expect(
			d1RetentionPolicyProblem({
				tableName: "tedi_runtime_events",
				mode: "delete",
				keepDays: 30,
			}),
		).toBeNull();
		expect(getD1RetentionTableSpec("constructor")).toBeNull();
	});

	it("never judges unparsable timestamps expired", () => {
		const runtime = getD1RetentionTableSpec("tedi_runtime_events");
		if (!runtime) throw new Error("runtime spec missing");
		for (const value of [
			"",
			"0000-invalid",
			"2026-00-02",
			"2026-02-30",
			"2026-07-01bad",
			null,
		]) {
			expect(isD1RetentionExpired(runtime, value, "2026-09-21")).toBe(false);
		}
		for (const value of [-Infinity, -1e99, NaN]) {
			expect(isD1RetentionExpired(audit(), value, 100)).toBe(false);
		}
	});

	it("expresses the cutoff in each table's own timestamp format", () => {
		expect(d1RetentionCutoff(audit(), NOW, 30)).toBe(
			Math.floor(NOW.getTime() / 1000) - 30 * DAY,
		);
		const runtime = getD1RetentionTableSpec("tedi_runtime_events");
		if (!runtime) throw new Error("tedi_runtime_events must be supported");
		expect(d1RetentionCutoff(runtime, NOW, 30)).toBe("2026-09-21");
	});
});

describe("d1 retention statements", () => {
	it("reads at most one page per statement from the oldest end", async () => {
		const { db, seedAudit } = fixture();
		seedAudit(Array.from({ length: 620 }, (_, i) => 700 - i));
		const page = await readD1RetentionPage(db, audit(), -1, 5000);
		expect(page).toHaveLength(D1_RETENTION_PAGE_ROWS);
		expect(page[0]?.__rowid).toBe(1);
		expect(page[0]?.id).toBe("audit-0");
		const next = await readD1RetentionPage(db, audit(), 50, 10);
		expect(next.map((row) => row.__rowid)).toEqual(
			Array.from({ length: 10 }, (_, i) => 51 + i),
		);
	});

	it("deletes one page of rowids per statement with two bound parameters and never inside the keep window", async () => {
		const { db, seedAudit, count } = fixture();
		// 610 expired rows, then 10 inside a 30-day window.
		seedAudit([
			...Array.from({ length: 610 }, () => 100),
			...Array.from({ length: 10 }, () => 1),
		]);
		const cutoff = d1RetentionCutoff(audit(), NOW, 30);
		const rowids = Array.from({ length: 620 }, (_, i) => i + 1);
		const statements = buildD1RetentionDeleteStatements(
			db,
			audit(),
			rowids,
			cutoff,
		);
		expect(statements).toHaveLength(2);
		for (const statement of statements) {
			expect(statement.toSQL().params).toHaveLength(2);
		}
		// Asking to delete all 620 removes only the 610 expired rows.
		await expect(
			deleteD1RetentionRows(db, audit(), rowids, cutoff),
		).resolves.toBe(610);
		expect(count("audit_events")).toBe(10);
	});

	it("estimates the expired backlog without counting the table", async () => {
		const { db, seedAudit, sqlite } = fixture();
		seedAudit([
			...Array.from({ length: 300 }, () => 120),
			...Array.from({ length: 200 }, () => 60),
			...Array.from({ length: 100 }, () => 2),
		]);
		// A gap in the rowid sequence: previously deleted rows.
		sqlite.prepare("DELETE FROM audit_events WHERE rowid <= 20").run();
		const estimate = await estimateD1RetentionBacklog(
			db,
			audit(),
			d1RetentionCutoff(audit(), NOW, 30),
		);
		expect(estimate.eligibleRows).toBeGreaterThanOrEqual(470);
		expect(estimate.eligibleRows).toBeLessThanOrEqual(480);
		expect(estimate.avgRowBytes).toBeGreaterThan(0);
		expect(estimate.eligibleBytes).toBe(
			estimate.eligibleRows * estimate.avgRowBytes,
		);

		const nothing = await estimateD1RetentionBacklog(
			db,
			audit(),
			d1RetentionCutoff(audit(), NOW, 365),
		);
		expect(nothing.eligibleRows).toBe(0);
	});

	it("handles text timestamps in both ISO and SQLite formats", async () => {
		const { db, insertRuntime } = fixture();
		const rows = [
			"2026-07-01 10:00:00",
			"2026-07-02T10:00:00.000Z",
			"2026-09-20T23:59:59.000Z",
			"2026-09-21 00:00:00",
			"2026-10-20T10:00:00.000Z",
		];
		rows.forEach((createdAt, index) =>
			insertRuntime.run(
				`event-${index}`,
				"fictional-lighthouse",
				"tedi-1",
				"message",
				"custom",
				"{}",
				createdAt,
			),
		);
		const runtime = getD1RetentionTableSpec("tedi_runtime_events");
		if (!runtime) throw new Error("tedi_runtime_events must be supported");
		const cutoff = d1RetentionCutoff(runtime, NOW, 30);
		const estimate = await estimateD1RetentionBacklog(db, runtime, cutoff);
		expect(estimate.eligibleRows).toBe(3);
		await expect(
			deleteD1RetentionRows(db, runtime, [1, 2, 3, 4, 5], cutoff),
		).resolves.toBe(3);
	});
});

describe("d1 retention policy rows", () => {
	it("lists active policies only and accumulates run totals", async () => {
		const { db, sqlite } = fixture();
		sqlite.exec(
			"INSERT INTO d1_retention_policies(table_name, mode, keep_days, updated_at) VALUES ('audit_events','dry_run',90,'2026-10-21'), ('tedi_runtime_events','off',30,'2026-10-21')",
		);
		const active = await listActiveD1RetentionPolicies(db);
		expect(active.map((row) => row.tableName)).toEqual(["audit_events"]);
		for (const deleted of [40, 2]) {
			await recordD1RetentionRun(db, {
				tableName: "audit_events",
				ranAt: NOW.toISOString(),
				report: { mode: "dry_run", deletedRows: deleted },
				archivedRows: deleted,
				deletedRows: deleted,
			});
		}
		const row = sqlite
			.prepare(
				"SELECT archived_rows_total AS a, deleted_rows_total AS d, last_report AS r FROM d1_retention_policies WHERE table_name = 'audit_events'",
			)
			.get() as { a: number; d: number; r: string };
		expect(row.a).toBe(42);
		expect(row.d).toBe(42);
		expect(JSON.parse(row.r)).toEqual({ mode: "dry_run", deletedRows: 2 });
	});
});

describe("d1 logs copy statements", () => {
	function logsFixture() {
		const sqlite = new DatabaseSync(":memory:");
		sqlite.exec(
			[auditEvents, tediRuntimeEvents]
				.flatMap((table) => tableDdl(table, { foreignKeys: false }))
				.join("\n"),
		);
		const facade = createD1Facade(sqlite);
		let batches = 0;
		const batch = facade.batch.bind(facade);
		facade.batch = (statements) => {
			batches += 1;
			return batch(statements);
		};
		return {
			sqlite,
			db: createDbQueryClient(facade),
			batches: () => batches,
		};
	}

	it("copies a page with one bound parameter per statement and reads every column back in one batch", async () => {
		const { db, seedAudit } = fixture();
		seedAudit(Array.from({ length: 500 }, () => 90));
		const rows = await readD1RetentionPage(db, audit(), -1);
		// JSON transport must not change any value: quotes, escapes, unicode,
		// JSON-looking and numeric-looking text, blanks and nulls.
		const tricky = [
			'{"a":[1,2]}',
			"1.50",
			"",
			"  ",
			'quote " \\ \n tab\t',
			"Zoë ✓ 🚀",
		];
		rows.forEach((row, index) => {
			row.metadata = index % 7 === 0 ? null : (tricky[index % 6] ?? null);
		});
		const statements = buildD1LogsCopyStatements(audit(), rows);
		expect(statements.length).toBeLessThan(5);
		for (const statement of statements) {
			expect(db.all(statement.query).getQuery().params).toHaveLength(1);
		}
		const logs = logsFixture();
		const copied = await copyD1RetentionRowsToLogs(logs.db, audit(), rows);
		expect(logs.batches()).toBe(1);
		expect(copied.size).toBe(500);
		expect(verifyD1LogsCopy(audit(), rows, copied)).toEqual({
			missing: [],
			mismatched: [],
		});
		expect(
			logs.sqlite
				.prepare(
					"SELECT metadata, timestamp FROM audit_events WHERE id = 'audit-5'",
				)
				.get(),
		).toEqual({ metadata: "Zoë ✓ 🚀", timestamp: rows[5]?.timestamp });
	});

	it("binds an oversized row column by column and splits a large page into more batches", async () => {
		const { db, seedAudit } = fixture();
		seedAudit(Array.from({ length: 12 }, () => 90));
		const rows = await readD1RetentionPage(db, audit(), -1);
		rows.forEach((row, index) => {
			row.metadata = (index === 0 ? "y" : "z").repeat(
				index === 0 ? D1_LOGS_COPY_STATEMENT_BYTES + 10 : 200 * 1024,
			);
		});
		const params = buildD1LogsCopyStatements(audit(), rows).map(
			(statement) => db.all(statement.query).getQuery().params.length,
		);
		// The oversized row binds one parameter per column; the rest one each.
		expect(params[0]).toBe(11);
		expect(params.slice(1).every((count) => count === 1)).toBe(true);
		const logs = logsFixture();
		const copied = await copyD1RetentionRowsToLogs(logs.db, audit(), rows);
		expect(logs.batches()).toBeGreaterThan(1);
		expect(verifyD1LogsCopy(audit(), rows, copied)).toEqual({
			missing: [],
			mismatched: [],
		});
	});

	it("flags a logs row that differs in any column", async () => {
		const { db, seedAudit } = fixture();
		seedAudit(Array.from({ length: 3 }, () => 90));
		const rows = await readD1RetentionPage(db, audit(), -1);
		const logs = logsFixture();
		// A logs database that rewrites one value on insert.
		logs.sqlite.exec(
			"CREATE TRIGGER rewrite AFTER INSERT ON audit_events WHEN NEW.id = 'audit-1' BEGIN UPDATE audit_events SET timestamp = timestamp + 1 WHERE id = NEW.id; END;",
		);
		const copied = await copyD1RetentionRowsToLogs(logs.db, audit(), rows);
		expect(verifyD1LogsCopy(audit(), rows, copied)).toEqual({
			missing: [],
			mismatched: ["audit-1"],
		});
	});
});
