import type { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vite-plus/test";
import { createDbQueryClient } from "../query-client";
import { createD1Facade } from "../test/d1-facade";
import { createMigratedSqlite } from "../test/migrated-sqlite";
import {
	D1_RETENTION_TABLES,
	type D1RetentionCutoff,
	type D1RetentionTableSpec,
	d1RetentionCutoff,
	d1RetentionPolicyCutoff,
	hasD1RetentionExpiredRows,
	isD1RetentionExpired,
	mayBeOlderThanD1RetentionCutoff,
	nextD1RetentionOldRowid,
} from "./d1-retention";

const NOW = new Date("2026-11-17T12:00:00.000Z");
const audit = D1_RETENTION_TABLES.audit_events!;
const runtime = D1_RETENTION_TABLES.tedi_runtime_events!;

/**
 * Stored timestamps of every shape the ledgers have held, valid or not, on
 * both sides of a 30-day cutoff (2026-10-18).
 */
const TEXT_VALUES = [
	"2026-09-01T10:00:00.000Z",
	"2026-10-17T23:59:59.999Z",
	"2026-10-18T00:00:00.000Z",
	"2026-11-16T10:00:00.000Z",
	"2026-09-01 10:00:00",
	"2026-11-16 10:00:00",
	"2026-09-01",
	"2026-10-18",
	"2026-09-01T10:00:00+02:00",
	"0000-invalid",
	"",
	" 2026-09-01",
	"not a date",
	"9999",
	"2026-10-1",
	"２０２６-09-01",
	"2026-09-01T10:00:00.000Zé",
	null,
] as const;
const SECONDS = Math.floor(NOW.getTime() / 1000);
const EPOCH_VALUES = [
	SECONDS - 120 * 86_400,
	SECONDS - 30 * 86_400 - 1,
	SECONDS - 30 * 86_400,
	SECONDS - 86_400,
	0,
	-1,
	-100_000_000_000_000,
	9_999_999_999_999,
	1.5,
] as const;

function fixture() {
	const sqlite = createMigratedSqlite({ foreignKeys: false });
	const insertRuntime = sqlite.prepare(
		"INSERT INTO tedi_runtime_events(id, organization_id, tedi_id, kind, runtime_backend, payload, created_at) VALUES(?,'fictional-lighthouse','tedi-ada','tool.completed','custom','{}',?)",
	);
	const insertAudit = sqlite.prepare(
		"INSERT INTO audit_events(id, organization_id, actor_id, actor_type, action, resource_type, metadata, timestamp) VALUES(?,'fictional-lighthouse','user-ada','user','mcp.tool.execute','mcp_tool','{}',?)",
	);
	return {
		sqlite,
		db: createDbQueryClient(createD1Facade(sqlite)),
		insertRuntime,
		insertAudit,
	};
}

/** The rowids the database itself calls older than the cutoff, in order. */
function oldRowids(
	sqlite: DatabaseSync,
	tableSpec: D1RetentionTableSpec,
	cutoff: D1RetentionCutoff,
) {
	return (
		sqlite
			.prepare(
				`SELECT rowid AS r FROM ${tableSpec.tableName} NOT INDEXED WHERE ${tableSpec.timestamp.name} < ? ORDER BY rowid`,
			)
			.all(cutoff) as Array<{ r: number }>
	).map((row) => Number(row.r));
}

describe("the next row older than a retention cutoff", () => {
	it("never calls a stored value newer when the database calls it older", () => {
		const { sqlite, insertRuntime, insertAudit } = fixture();
		// The epoch ledger stores whatever it is given, text included.
		TEXT_VALUES.forEach((value, index) => {
			if (value !== null) insertRuntime.run(`text-${index}`, value);
		});
		EPOCH_VALUES.forEach((value, index) =>
			insertAudit.run(`epoch-${index}`, value),
		);
		insertAudit.run("epoch-text", "2026-09-01");
		for (const tableSpec of [runtime, audit]) {
			const cutoff = d1RetentionCutoff(tableSpec, NOW, 30);
			const rows = sqlite
				.prepare(
					`SELECT id, ${tableSpec.timestamp.name} AS value, (${tableSpec.timestamp.name} < ?) AS older FROM ${tableSpec.tableName}`,
				)
				.all(cutoff) as Array<{
				id: string;
				value: unknown;
				older: number | null;
			}>;
			expect(rows.length).toBeGreaterThan(8);
			for (const row of rows) {
				const may = mayBeOlderThanD1RetentionCutoff(row.value, cutoff);
				// Older in the database means "may be older" here, always.
				if (row.older === 1) expect(may, row.id).toBe(true);
				// And every row the engine would move is one the database calls older.
				if (isD1RetentionExpired(tableSpec, row.value, cutoff)) {
					expect(row.older, row.id).toBe(1);
					expect(may, row.id).toBe(true);
				}
			}
			// Plain newer timestamps are recognised as newer, or nothing is skipped.
			expect(
				rows.filter(
					(row) => !mayBeOlderThanD1RetentionCutoff(row.value, cutoff),
				).length,
			).toBeGreaterThanOrEqual(3);
		}
		expect(mayBeOlderThanD1RetentionCutoff(null, "2026-10-18")).toBe(false);
		expect(mayBeOlderThanD1RetentionCutoff(undefined, 5)).toBe(false);
	});

	it("is the first old row after the cursor in rowid order, or nothing", async () => {
		const { sqlite, db, insertRuntime, insertAudit } = fixture();
		// Old rows alone, in runs, behind newer rows and at the very end.
		const values = (index: number) =>
			index % 97 === 0 || (index > 400 && index < 420) || index === 899
				? TEXT_VALUES[index % 3 === 0 ? 0 : index % 3 === 1 ? 4 : 9]
				: TEXT_VALUES[index % 2 ? 3 : 5];
		for (let index = 0; index < 900; index++) {
			insertRuntime.run(`runtime-${index}`, values(index));
			insertAudit.run(
				`audit-${index}`,
				index % 113 === 0 || index === 899
					? EPOCH_VALUES[index % 2 ? 0 : 6]
					: EPOCH_VALUES[3],
			);
		}
		// Gaps in the rowids, as deletes leave them.
		sqlite.exec(
			"DELETE FROM tedi_runtime_events WHERE rowid BETWEEN 190 AND 200; DELETE FROM audit_events WHERE rowid BETWEEN 100 AND 120",
		);
		for (const tableSpec of [runtime, audit]) {
			const cutoff = d1RetentionCutoff(tableSpec, NOW, 30);
			const old = oldRowids(sqlite, tableSpec, cutoff);
			expect(old.length).toBeGreaterThanOrEqual(8);
			for (const after of [
				-1, 0, 1, 96, 97, 98, 195, 399, 410, 419, 420, 700, 898, 899, 900, 5000,
			])
				expect(
					await nextD1RetentionOldRowid(db, tableSpec, cutoff, after),
					`${tableSpec.tableName} after ${after}`,
				).toBe(old.find((rowid) => rowid > after) ?? null);
			// A cutoff before every row finds nothing.
			expect(
				await nextD1RetentionOldRowid(
					db,
					tableSpec,
					tableSpec.format === "text" ? "" : -1e18,
					-1,
				),
			).toBeNull();
		}
	});

	it("seeks both audit retention windows without scanning retained actions", async () => {
		const { sqlite, insertAudit } = fixture();
		insertAudit.run("retained-payment", SECONDS - 30 * 86_400);
		sqlite.exec("UPDATE audit_events SET action = 'payment.captured'");
		sqlite.exec(`ANALYZE;
			DELETE FROM sqlite_stat1;
			INSERT INTO sqlite_stat1(tbl,idx,stat) VALUES
				('audit_events','idx_audit_events_timestamp','1550000 2'),
				('audit_events','idx_audit_events_action_timestamp','1550000 50000 2');
			ANALYZE sqlite_schema;`);
		const statements: string[] = [];
		const db = createDbQueryClient(
			createD1Facade(sqlite, {
				onPrepare(query) {
					statements.push(query);
				},
			}),
		);
		const cutoff = d1RetentionPolicyCutoff(audit, NOW, { keepDays: 90 });
		expect(await hasD1RetentionExpiredRows(db, audit, cutoff)).toBe(false);
		expect(await nextD1RetentionOldRowid(db, audit, cutoff, 0)).toBeNull();
		for (const query of statements) {
			const plan = sqlite
				.prepare(`EXPLAIN QUERY PLAN ${query}`)
				.all(
					...Array.from(
						{ length: (query.match(/\?/g) ?? []).length },
						() => null,
					),
				)
				.map((row) => String(row.detail))
				.join("\n");
			expect(plan).toContain("MULTI-INDEX OR");
			expect(plan).toContain("idx_audit_events_timestamp (timestamp<?)");
			expect(plan).toContain(
				"idx_audit_events_action_timestamp (action=? AND timestamp<?)",
			);
			expect(plan).not.toMatch(/SCAN audit_events|TEMP B-TREE/);
		}
		insertAudit.run("expired-telemetry", SECONDS - 15 * 86_400);
		expect(await hasD1RetentionExpiredRows(db, audit, cutoff)).toBe(true);
		expect(await nextD1RetentionOldRowid(db, audit, cutoff, 0)).toBe(2);
		insertAudit.run("expired-payment", SECONDS - 91 * 86_400);
		sqlite.exec(
			"UPDATE audit_events SET action = 'payment.captured' WHERE id = 'expired-payment'",
		);
		expect(await nextD1RetentionOldRowid(db, audit, cutoff, 2)).toBe(3);
	});

	it.each([
		{ statistics: "no statistics", productionLike: false },
		{ statistics: "production-like statistics", productionLike: true },
	])(
		"reads only the timestamp index of every retention table with $statistics",
		({ productionLike }) => {
			const { sqlite } = fixture();
			// Ledger sizes of the main database in November 2026.
			if (productionLike)
				sqlite.exec(`ANALYZE;
					DELETE FROM sqlite_stat1;
					INSERT INTO sqlite_stat1(tbl,idx,stat) VALUES
						('audit_events','idx_audit_events_timestamp','1550000 2'),
						('audit_events','idx_audit_events_org_timestamp','1550000 15000 2'),
						('tedi_runtime_events','idx_tedi_runtime_events_created','300000 1'),
						('kernel_runtime_events','idx_kernel_runtime_events_created_at','220000 1'),
						('skill_run_artifacts','idx_skill_run_artifacts_created_at','460000 1'),
						('tedi_call_costs','idx_call_costs_created','820000 1'),
						('external_agent_attributions','idx_external_agent_attribution_occurred','830000 1'),
						('external_agent_attributions','uniq_external_agent_attribution_org_id','830000 8000 1');
					ANALYZE sqlite_schema;`);
			const statements: string[] = [];
			const recording = createDbQueryClient(
				createD1Facade(sqlite, {
					onPrepare(query) {
						statements.push(query);
					},
				}),
			);
			const plans: Record<string, string[]> = {};
			return Promise.all(
				Object.values(D1_RETENTION_TABLES).map(async (tableSpec) => {
					const cutoff = d1RetentionCutoff(tableSpec, NOW, 400);
					await nextD1RetentionOldRowid(recording, tableSpec, cutoff, 1000);
					const query = statements.find((statement) =>
						statement.includes(`"${tableSpec.tableName}"`),
					)!;
					plans[tableSpec.tableName] = sqlite
						.prepare(`EXPLAIN QUERY PLAN ${query}`)
						.all(cutoff, 1000)
						.map((row) => String(row.detail));
				}),
			).then(() => {
				expect(Object.keys(plans).sort()).toEqual(
					Object.keys(D1_RETENTION_TABLES).sort(),
				);
				for (const [table, plan] of Object.entries(plans)) {
					const column = D1_RETENTION_TABLES[table]!.timestamp.name;
					expect(plan, table).toHaveLength(1);
					expect(plan[0], table).toMatch(
						new RegExp(
							`^SEARCH ${table} USING COVERING INDEX \\w+ \\(${column}<\\?\\)$`,
						),
					);
				}
			});
		},
	);
});
