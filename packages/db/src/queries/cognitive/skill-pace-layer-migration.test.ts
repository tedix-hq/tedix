import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vite-plus/test";

const MIGRATION = readFileSync(
	new URL(
		"../../../drizzle/20260829085510_require_skill_pace_layer/migration.sql",
		import.meta.url,
	),
	"utf8",
).replaceAll("--> statement-breakpoint", "");

describe("required skill pace layer migration", () => {
	it("preserves rows, maps every NULL from lifecycle, and rejects future NULLs", () => {
		const sqlite = new DatabaseSync(":memory:");
		sqlite.exec(`
			CREATE TABLE skill_entries (
				id TEXT PRIMARY KEY,
				lifecycle_state TEXT,
				pace_layer TEXT
			);
			CREATE INDEX idx_skill_entries_pace_layer ON skill_entries (pace_layer);
			INSERT INTO skill_entries VALUES
				('draft', 'draft', NULL),
				('active', 'active', NULL),
				('proven', 'proven', NULL),
				('crystallized', 'crystallized', NULL),
				('stale', 'stale', NULL),
				('missing-lifecycle', NULL, NULL),
				('explicit', 'draft', 'record');
		`);

		sqlite.exec(MIGRATION);

		expect(
			sqlite
				.prepare("SELECT id, pace_layer FROM skill_entries ORDER BY id")
				.all(),
		).toEqual([
			{ id: "active", pace_layer: "differentiation" },
			{ id: "crystallized", pace_layer: "record" },
			{ id: "draft", pace_layer: "innovation" },
			{ id: "explicit", pace_layer: "record" },
			{ id: "missing-lifecycle", pace_layer: "innovation" },
			{ id: "proven", pace_layer: "differentiation" },
			{ id: "stale", pace_layer: "innovation" },
		]);
		expect(() =>
			sqlite.exec(
				"INSERT INTO skill_entries(id, lifecycle_state, pace_layer) VALUES ('invalid', 'draft', NULL)",
			),
		).toThrow(/NOT NULL/);
		sqlite.exec(
			"INSERT INTO skill_entries(id, lifecycle_state) VALUES ('defaulted', 'draft')",
		);
		expect(
			sqlite
				.prepare("SELECT pace_layer FROM skill_entries WHERE id='defaulted'")
				.get(),
		).toEqual({ pace_layer: "innovation" });
	});
});
