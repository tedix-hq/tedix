import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vite-plus/test";

it("backfills only retired runs and preserves customer content and existing fences", () => {
	const db = new DatabaseSync(":memory:");
	try {
		db.exec(`
			CREATE TABLE skill_runs (
				id TEXT PRIMARY KEY, error TEXT, workflow_retired_at TEXT,
				workflow_source TEXT, result TEXT
			);
			CREATE TABLE skill_run_artifacts (
				run_id TEXT, path TEXT, content_inline TEXT
			);
		`);
		const insertRun = db.prepare(
			"INSERT INTO skill_runs VALUES (?, ?, ?, 'customer source', 'customer result')",
		);
		for (const [id, error, retiredAt] of [
			["revoked", "REVOKED", null],
			["revoked-detail", "REVOKED: reason", null],
			["aborted", null, null],
			["already-retired", "REVOKED", "2026-10-01T00:00:00.000Z"],
			["active", null, null],
			["other-error", "REVOKEDish", null],
			["malformed", null, null],
			["pending", null, null],
			["other-action", null, null],
			["other-path", null, null],
		] as const)
			insertRun.run(id, error, retiredAt);
		const insertArtifact = db.prepare(
			"INSERT INTO skill_run_artifacts VALUES (?, ?, ?)",
		);
		const abort = JSON.stringify({
			status: "rejected",
			resolution: { action: "operator_abort" },
		});
		insertArtifact.run("aborted", "controls/restarts/1.json", abort);
		insertArtifact.run("malformed", "controls/restarts/1.json", "{broken");
		insertArtifact.run(
			"pending",
			"controls/restarts/1.json",
			JSON.stringify({
				status: "pending",
				resolution: { action: "operator_abort" },
			}),
		);
		insertArtifact.run(
			"other-action",
			"controls/restarts/1.json",
			JSON.stringify({ status: "rejected", resolution: { action: "retry" } }),
		);
		insertArtifact.run("other-path", "outputs/step.json", abort);
		const content = () => ({
			runs: db
				.prepare(
					"SELECT id, error, workflow_source, result FROM skill_runs ORDER BY id",
				)
				.all(),
			artifacts: db
				.prepare("SELECT * FROM skill_run_artifacts ORDER BY run_id")
				.all(),
		});
		const before = content();
		const migration = readFileSync(
			new URL(
				"../../drizzle/20261118175115_backfill-skill-run-retirement/migration.sql",
				import.meta.url,
			),
			"utf8",
		);
		db.exec(migration);
		expect(content()).toEqual(before);
		expect(
			db
				.prepare(
					"SELECT id FROM skill_runs WHERE workflow_retired_at IS NOT NULL ORDER BY id",
				)
				.all(),
		).toEqual([
			{ id: "aborted" },
			{ id: "already-retired" },
			{ id: "revoked" },
			{ id: "revoked-detail" },
		]);
		expect(
			db
				.prepare(
					"SELECT workflow_retired_at FROM skill_runs WHERE id = 'already-retired'",
				)
				.get()?.workflow_retired_at,
		).toBe("2026-10-01T00:00:00.000Z");
		const after = db.prepare("SELECT * FROM skill_runs ORDER BY id").all();
		db.exec(migration);
		expect(db.prepare("SELECT * FROM skill_runs ORDER BY id").all()).toEqual(
			after,
		);
	} finally {
		db.close();
	}
});
