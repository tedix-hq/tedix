import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vite-plus/test";
import { createDbQueryClient } from "../query-client";
import { auditEvents } from "../schema/audit-events";
import { tediRuntimeEvents } from "../schema/cognitive-runtime";
import { d1RetentionPolicies } from "../schema/d1-retention";
import { createD1Facade } from "../test/d1-facade";
import { schemaDdl } from "../test/schema-ddl";
import {
	buildD1RetentionDeleteStatements,
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
		expect(d1RetentionEffectiveKeepDays(audit(), { keepDays: 7 })).toBe(30);
		expect(d1RetentionEffectiveKeepDays(audit(), { keepDays: 90 })).toBe(90);
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
	it("reads at most 50 rows per statement from the oldest end", async () => {
		const { db, seedAudit } = fixture();
		seedAudit(Array.from({ length: 120 }, (_, i) => 200 - i));
		const page = await readD1RetentionPage(db, audit(), -1, 500);
		expect(page).toHaveLength(50);
		expect(page[0]?.__rowid).toBe(1);
		expect(page[0]?.id).toBe("audit-0");
		const next = await readD1RetentionPage(db, audit(), 50);
		expect(next[0]?.__rowid).toBe(51);
	});

	it("deletes in statements of at most 50 rowids and never inside the keep window", async () => {
		const { db, seedAudit, count } = fixture();
		// 110 expired rows, then 10 inside a 30-day window.
		seedAudit([
			...Array.from({ length: 110 }, () => 100),
			...Array.from({ length: 10 }, () => 1),
		]);
		const cutoff = d1RetentionCutoff(audit(), NOW, 30);
		const rowids = Array.from({ length: 120 }, (_, i) => i + 1);
		const statements = buildD1RetentionDeleteStatements(
			db,
			audit(),
			rowids,
			cutoff,
		);
		expect(statements).toHaveLength(3);
		for (const statement of statements) {
			expect(statement.toSQL().params.length).toBeLessThanOrEqual(51);
		}
		// Asking to delete all 120 removes only the 110 expired rows.
		await expect(
			deleteD1RetentionRows(db, audit(), rowids, cutoff),
		).resolves.toBe(110);
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
