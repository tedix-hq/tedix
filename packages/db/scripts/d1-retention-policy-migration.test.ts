import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vite-plus/test";

const migrationsDirectory = join(import.meta.dirname, "../drizzle");

describe("D1 retention policy migrations", () => {
	it("activate verified log moves for audit and runtime streams", () => {
		const sqlite = new DatabaseSync(":memory:");
		for (const directory of readdirSync(migrationsDirectory).sort()) {
			const sql = readFileSync(
				join(migrationsDirectory, directory, "migration.sql"),
				"utf8",
			);
			if (sql.includes("d1_retention_policies")) sqlite.exec(sql);
		}

		expect(
			sqlite
				.prepare(
					"SELECT table_name, mode FROM d1_retention_policies WHERE table_name IN ('audit_events', 'tedi_runtime_events', 'kernel_runtime_events') ORDER BY table_name",
				)
				.all(),
		).toEqual([
			{ table_name: "audit_events", mode: "move_to_logs_db" },
			{ table_name: "kernel_runtime_events", mode: "move_to_logs_db" },
			{ table_name: "tedi_runtime_events", mode: "move_to_logs_db" },
		]);
	});
});
