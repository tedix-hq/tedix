import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vite-plus/test";
import { createDbQueryClient } from "../query-client";
import { auditEvents } from "../schema/audit-events";
import { skillRunArtifacts, skillRuns } from "../schema/cognitive";
import { tediArtifacts, tediRuntimeEvents } from "../schema/cognitive-runtime";
import { d1RetentionPolicies } from "../schema/d1-retention";
import {
	externalAgentAttributions,
	externalAgentReviewEvidence,
} from "../schema/external-agent-identity";
import { memoryFacts } from "../schema/memory-graph";
import { osGadgetExecutions } from "../schema/os-workspaces";
import { workEvidence } from "../schema/work-items";
import { createD1Facade } from "../test/d1-facade";
import { schemaDdl, tableDdl } from "../test/schema-ddl";
import {
	D1_LOGS_COPY_STATEMENT_BYTES,
	D1_RETENTION_PAGE_ROWS,
	D1_RETENTION_TABLES,
	D1RetentionEstimateDeadlineError,
	buildD1LogsCopyStatements,
	buildD1RetentionDeleteStatements,
	copyD1RetentionRowsToLogs,
	d1RetentionCutoff,
	d1RetentionEffectiveKeepDays,
	d1RetentionPolicyProblem,
	deleteD1RetentionRows,
	estimateD1RetentionBacklog,
	filterD1RetentionReferencedRows,
	getD1RetentionTableSpec,
	hasD1RetentionExpiredRows,
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
	it("refuses unknown tables and raises windows below the floor", () => {
		expect(
			d1RetentionPolicyProblem({
				tableName: "organizations",
				mode: "move_to_logs_db",
				keepDays: 365,
			}),
		).toBe("unsupported_table");
		expect(
			d1RetentionPolicyProblem({
				tableName: "audit_events",
				mode: "move_to_logs_db",
				keepDays: 7,
			}),
		).toBeNull();
		expect(d1RetentionEffectiveKeepDays(audit(), { keepDays: 7 })).toBe(90);
		expect(d1RetentionEffectiveKeepDays(audit(), { keepDays: 120 })).toBe(120);
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
	it.each(Object.values(D1_RETENTION_TABLES))(
		"probes $tableName with one covering index seek and no sort",
		async (tableSpec) => {
			const sqlite = new DatabaseSync(":memory:");
			sqlite.exec(schemaDdl({ foreignKeys: false }, tableSpec.table));
			const d1 = createD1Facade(sqlite);
			const reads = vi.spyOn(d1, "prepare");
			const db = createDbQueryClient(d1);
			const cutoff = d1RetentionCutoff(tableSpec, NOW, tableSpec.minKeepDays);
			expect(await hasD1RetentionExpiredRows(db, tableSpec, cutoff)).toBe(
				false,
			);
			expect(reads).toHaveBeenCalledTimes(1);
			const query = reads.mock.calls[0]![0];
			const plan = sqlite.prepare(`EXPLAIN QUERY PLAN ${query}`).all(cutoff, 1);
			expect(plan).toHaveLength(1);
			expect(plan[0]?.detail).toMatch(
				/SEARCH .* USING COVERING INDEX .* \(.*<\?\)/,
			);
			sqlite.close();
		},
	);

	it("finds old rows behind newer rows and rechecks a changing cutoff", async () => {
		const { db, seedAudit } = fixture();
		seedAudit([1, 90, 2]);
		expect(
			await hasD1RetentionExpiredRows(
				db,
				audit(),
				d1RetentionCutoff(audit(), NOW, 90),
			),
		).toBe(false);
		const later = new Date(NOW.getTime() + DAY * 1000);
		expect(
			await hasD1RetentionExpiredRows(
				db,
				audit(),
				d1RetentionCutoff(audit(), later, 90),
			),
		).toBe(true);
	});

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

	it("stops backlog probes at the deadline and starts none when it already expired", async () => {
		const { db, seedAudit } = fixture();
		seedAudit(Array.from({ length: 1000 }, () => 120));
		const cutoff = d1RetentionCutoff(audit(), NOW, 90);
		const reads = vi.spyOn(db, "all");
		let clock = 0;
		const mocked = vi.spyOn(Date, "now").mockImplementation(() => clock++);
		try {
			await expect(
				estimateD1RetentionBacklog(db, audit(), cutoff, 0),
			).rejects.toBeInstanceOf(D1RetentionEstimateDeadlineError);
			expect(reads).not.toHaveBeenCalled();
			clock = 0;
			await expect(
				estimateD1RetentionBacklog(db, audit(), cutoff, 3),
			).rejects.toBeInstanceOf(D1RetentionEstimateDeadlineError);
			expect(reads.mock.calls.length).toBeGreaterThan(0);
			expect(reads.mock.calls.length).toBeLessThanOrEqual(3);
		} finally {
			mocked.mockRestore();
			reads.mockRestore();
		}
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
			divergentColumns: {},
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
			divergentColumns: {},
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
			divergentColumns: { "audit-1": ["timestamp"] },
		});
	});
});

describe("external agent attribution retention", () => {
	function attributions() {
		const sqlite = new DatabaseSync(":memory:", {
			enableForeignKeyConstraints: false,
		});
		sqlite.exec(
			schemaDdl(externalAgentAttributions, externalAgentReviewEvidence),
		);
		const db = createDbQueryClient(createD1Facade(sqlite));
		const spec = getD1RetentionTableSpec("external_agent_attributions")!;
		const seed = (id: string, targetType: string, org = "org-example") =>
			sqlite
				.prepare(`INSERT INTO external_agent_attributions
				(id, organization_id, principal_id, session_id, target_type, target_id, role, metadata, occurred_at)
				VALUES (?, ?, 'principal-example', 'session-example', ?, ?, 'executor', '{}', '2026-08-01T10:00:00.000Z')`)
				.run(id, org, targetType, `target-${id}`);
		const review = (id: string, executionId: string, org = "org-example") =>
			sqlite
				.prepare(`INSERT INTO external_agent_review_evidence
				(id, organization_id, execution_attribution_id, subject_principal_id, subject_session_id,
				 reviewer_principal_type, reviewer_principal_id, target_type, target_id, task_family,
				 repository_key, repository_version, risk_level, environment, outcome, score,
				 review_method, evidence_refs, context_hash, occurred_at, created_at)
				VALUES (?, ?, ?, 'principal-example', 'session-example', 'user', 'user-example',
				 'mcp_execution', 'target', 'change', 'repo', 'v1', 'low', 'production', 'success', 1,
				 'manual', '[]', 'hash', '2026-08-02', '2026-08-02')`)
				.run(id, org, executionId);
		return { db, spec, seed, review };
	}

	it("keeps at least 30 days for verified logs moves", () => {
		const spec = getD1RetentionTableSpec("external_agent_attributions")!;
		expect(spec.logsDb).toBe(true);
		expect(d1RetentionEffectiveKeepDays(spec, { keepDays: 7 })).toBe(30);
		expect(
			d1RetentionPolicyProblem({
				tableName: "external_agent_attributions",
				mode: "move_to_logs_db",
				keepDays: 30,
			}),
		).toBeNull();
	});

	it("moves only unreviewed MCP executions and rechecks reviews at deletion", async () => {
		const { db, spec, seed, review } = attributions();
		seed("free", "mcp_execution");
		seed("reviewed", "mcp_execution");
		seed("commit", "commit");
		seed("attempt", "work_item_attempt");
		seed("late-review", "mcp_execution");
		seed("other-org-review", "mcp_execution");
		review("review-1", "reviewed");
		// A review in another organization does not pin this row.
		review("review-2", "other-org-review", "org-other");
		const page = await readD1RetentionPage(db, spec, -1);
		const filtered = await filterD1RetentionReferencedRows(db, spec, page);
		expect(filtered.rows.map((row) => row.id)).toEqual([
			"free",
			"late-review",
			"other-org-review",
		]);
		expect(filtered.referencedRows).toBe(3);
		review("review-3", "late-review");
		const deleted = await deleteD1RetentionRows(
			db,
			spec,
			page.map((row) => row.__rowid),
			"2026-09-01",
		);
		expect(deleted).toBe(2);
		expect(
			(await readD1RetentionPage(db, spec, -1)).map((row) => row.id),
		).toEqual(["reviewed", "commit", "attempt", "late-review"]);
	});
});

describe("artifact retention references", () => {
	function artifacts() {
		const sqlite = new DatabaseSync(":memory:", {
			enableForeignKeyConstraints: false,
		});
		sqlite.exec(
			schemaDdl(
				skillRuns,
				skillRunArtifacts,
				memoryFacts,
				workEvidence,
				tediArtifacts,
				osGadgetExecutions,
			),
		);
		const db = createDbQueryClient(createD1Facade(sqlite));
		const spec = getD1RetentionTableSpec("skill_run_artifacts")!;
		const seed = (
			id: string,
			status = "completed",
			completedAt: string | null = "2026-09-01",
		) => {
			sqlite
				.prepare(`INSERT INTO skill_runs
				(id, organization_id, skill_id, tedi_id, workflow_instance_id, runtime_environment, status, completed_at)
				VALUES (?, 'org-example', 'skill-example', 'tedi-example', ?, 'production', ?, ?)`)
				.run(id, id, status, completedAt);
			sqlite
				.prepare(`INSERT INTO skill_run_artifacts
				(id, run_id, path, content_r2_key, created_at)
				VALUES (?, ?, 'output.json', ?, '2026-09-01')`)
				.run(id, id, `${id}/bodies/${id}`);
		};
		const fact = (id: string, source: string, org = "org-example") => {
			sqlite
				.prepare(`INSERT INTO memory_facts (id, organization_id, content, fact_type, source)
				VALUES (?, ?, 'retained provenance', 'observation', ?)`)
				.run(id, org, source);
		};
		const evidence = (id: string, org = "org-example") => {
			sqlite
				.prepare(`INSERT INTO work_evidence
				(id, work_item_id, org_id, claim_key, kind, uri, submitted_by_type, submitted_by_id, submitted_at)
				VALUES (?, 'work-example', ?, 'result', 'artifact', ?, 'user', 'user-example', '2026-10-01')`)
				.run(id, org, `artifact://${id}`);
		};
		return { sqlite, db, spec, seed, fact, evidence };
	}

	it("retains run and path memory sources, Work evidence, open and missing runs", async () => {
		const { sqlite, db, spec, seed, fact, evidence } = artifacts();
		for (const id of [
			"run-fact",
			"path-fact",
			"evidence",
			"free",
			"prefix",
			"other-org",
		])
			seed(id);
		for (const status of ["queued", "running", "paused"]) seed(status, status);
		seed("unfinished", "completed", null);
		seed("restart");
		sqlite.exec(
			"UPDATE skill_runs SET restart_requested_at = '2026-10-01' WHERE id = 'restart'",
		);
		seed("missing");
		sqlite.exec("DELETE FROM skill_runs WHERE id = 'missing'");
		fact("run-fact", "skill://runs/run-fact");
		fact("path-fact", "skill://example/runs/path-fact/steps/result.json");
		fact("prefix", "skill://runs/prefix-other/output.json");
		fact("other-org", "skill://runs/other-org", "org-other");
		evidence("evidence");
		evidence("other-org", "org-other");
		const page = await readD1RetentionPage(db, spec, -1);
		const filtered = await filterD1RetentionReferencedRows(db, spec, page);
		expect(filtered.rows.map((row) => row.id)).toEqual([
			"free",
			"prefix",
			"other-org",
		]);
		expect(filtered.referencedRows).toBe(9);
		expect(page).toHaveLength(12);
		const deleted = await deleteD1RetentionRows(
			db,
			spec,
			page.map((row) => row.__rowid),
			"2026-10-01",
		);
		expect(deleted).toBe(3);
		expect(
			(await readD1RetentionPage(db, spec, -1)).map(
				(row) => row.content_r2_key,
			),
		).toContain("path-fact/bodies/path-fact");
	});

	it("rechecks references at deletion if a fact appears after the page filter", async () => {
		const { db, spec, seed, fact } = artifacts();
		seed("late-fact");
		const page = await readD1RetentionPage(db, spec, -1);
		expect(
			(await filterD1RetentionReferencedRows(db, spec, page)).referencedRows,
		).toBe(0);
		fact("late-fact", "skill://runs/late-fact");
		expect(
			await deleteD1RetentionRows(db, spec, [page[0]!.__rowid], "2026-10-01"),
		).toBe(0);
		expect(await readD1RetentionPage(db, spec, -1)).toHaveLength(1);
	});

	it("pins registry evidence by run and skill URI, including deletion-time references", async () => {
		const { sqlite, db, spec, seed, evidence } = artifacts();
		for (const id of [
			"registry-run",
			"registry-uri",
			"unreferenced",
			"other-org",
		])
			seed(id);
		const page = await readD1RetentionPage(db, spec, -1);
		for (const id of [
			"registry-run",
			"registry-uri",
			"unreferenced",
			"other-org",
		]) {
			sqlite
				.prepare(`INSERT INTO tedi_artifacts
				(id, organization_id, tedi_id, run_id, kind, name, uri, created_at)
				VALUES (?, ?, 'tedi-example', ?, 'file', 'output', ?, '2026-09-01')`)
				.run(
					`registered-${id}`,
					id === "other-org" ? "org-other" : "org-example",
					id === "registry-uri" ? null : id,
					`skill://example/runs/${id}/output.json`,
				);
			if (id !== "unreferenced") evidence(`registered-${id}`);
		}
		const filtered = await filterD1RetentionReferencedRows(db, spec, page);
		expect(filtered.rows.map((row) => row.id)).toEqual([
			"unreferenced",
			"other-org",
		]);
		expect(filtered.referencedRows).toBe(2);
		expect(
			await deleteD1RetentionRows(
				db,
				spec,
				page.map((row) => row.__rowid),
				"2026-10-01",
			),
		).toBe(2);
	});

	it("pins registry evidence through its governed producer execution", async () => {
		const { sqlite, db, spec, seed, evidence } = artifacts();
		for (const id of ["producer", "foreign-producer"]) {
			seed(id);
			sqlite
				.prepare(`INSERT INTO os_gadget_executions
				(id, organization_id, workspace_id, gadget_id, status, granted_capabilities, policy_decision, run_id, created_by_kind, created_by_id, created_at)
				VALUES (?, ?, 'workspace-example', 'gadget-example', 'completed', '[]', '{}', ?, 'user', 'user-example', '2026-09-01')`)
				.run(
					`execution-${id}`,
					id === "producer" ? "org-example" : "org-other",
					id,
				);
			sqlite
				.prepare(`INSERT INTO tedi_artifacts
				(id, organization_id, tedi_id, run_id, producer_execution_id, kind, name, created_at)
				VALUES (?, 'org-example', 'tedi-example', 'runtime-run', ?, 'file', 'result', '2026-09-01')`)
				.run(`registered-${id}`, `execution-${id}`);
			evidence(`registered-${id}`);
		}
		const page = await readD1RetentionPage(db, spec, -1);
		expect(
			(await filterD1RetentionReferencedRows(db, spec, page)).rows.map(
				(row) => row.id,
			),
		).toEqual(["foreign-producer"]);
		expect(
			await deleteD1RetentionRows(
				db,
				spec,
				page.map((row) => row.__rowid),
				"2026-10-01",
			),
		).toBe(1);
	});

	it("uses the resolver's stored artifact ID for encoded registry URIs", async () => {
		const { sqlite, db, spec, seed } = artifacts();
		seed("encoded");
		sqlite.exec(`INSERT INTO tedi_artifacts
			(id, organization_id, tedi_id, run_id, kind, name, created_at)
			VALUES ('registry/id', 'org-example', 'tedi-example', 'encoded', 'file', 'result', '2026-09-01');
			INSERT INTO work_evidence
			(id, work_item_id, org_id, claim_key, kind, uri, submitted_by_type, submitted_by_id, submitted_at, metadata)
			VALUES ('encoded-evidence', 'work-example', 'org-example', 'result', 'artifact', 'artifact://registry%2Fid', 'user', 'user-example', '2026-10-01', '{"_tedixEvidence":{"artifactId":"registry/id"}}')`);
		const page = await readD1RetentionPage(db, spec, -1);
		expect(await filterD1RetentionReferencedRows(db, spec, page)).toEqual({
			rows: [],
			referencedRows: 1,
		});
		expect(
			await deleteD1RetentionRows(
				db,
				spec,
				page.map((row) => row.__rowid),
				"2026-10-01",
			),
		).toBe(0);
	});

	it("keeps the raw cursor through a fully pinned page", async () => {
		const { db, spec, seed, fact } = artifacts();
		seed("pinned");
		seed("movable");
		fact("pinned", "skill://runs/pinned");
		const page = await readD1RetentionPage(db, spec, -1, 1);
		expect(await filterD1RetentionReferencedRows(db, spec, page)).toEqual({
			rows: [],
			referencedRows: 1,
		});
		expect(
			(await readD1RetentionPage(db, spec, page[0]!.__rowid, 1))[0]?.id,
		).toBe("movable");
	});

	it("looks up registry pins by primary key instead of joining every organization artifact", async () => {
		const { sqlite, db, spec, seed, evidence } = artifacts();
		seed("free");
		evidence("registered-elsewhere");
		const queries: string[] = [];
		const observed = createDbQueryClient(
			createD1Facade(sqlite, {
				onPrepare(query) {
					queries.push(query);
				},
			}),
		);
		const page = await readD1RetentionPage(db, spec, -1);
		expect(
			(await filterD1RetentionReferencedRows(observed, spec, page)).rows,
		).toHaveLength(1);
		const query = queries.find((query) => query.includes("tedi_artifacts"))!;
		const plan = sqlite
			.prepare(`EXPLAIN QUERY PLAN ${query}`)
			.all(JSON.stringify(page.map((row) => row.__rowid)));
		expect(
			plan.some(
				(row) =>
					String(row.detail).includes("SEARCH tedi_artifacts") &&
					String(row.detail).includes("(id=?)"),
			),
		).toBe(true);
		sqlite.close();
	});
});
