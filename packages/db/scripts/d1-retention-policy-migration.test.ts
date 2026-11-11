import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vite-plus/test";

const migrationsDirectory = join(import.meta.dirname, "../drizzle");

describe("D1 retention policy migrations", () => {
	it("activates verified log moves for telemetry, attributions and costs", () => {
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
		expect(
			sqlite
				.prepare(
					"SELECT mode, keep_days, max_rows_per_run FROM d1_retention_policies WHERE table_name = 'skill_run_artifacts'",
				)
				.get(),
		).toEqual({
			mode: "move_to_logs_db",
			keep_days: 14,
			max_rows_per_run: 6000,
		});
		expect(
			sqlite
				.prepare(
					"SELECT mode, keep_days, max_rows_per_run FROM d1_retention_policies WHERE table_name = 'external_agent_attributions'",
				)
				.get(),
		).toEqual({
			mode: "move_to_logs_db",
			keep_days: 30,
			max_rows_per_run: 5000,
		});
		expect(
			sqlite
				.prepare(
					"SELECT mode, keep_days, max_rows_per_run FROM d1_retention_policies WHERE table_name = 'tedi_call_costs'",
				)
				.get(),
		).toEqual({
			mode: "move_to_logs_db",
			keep_days: 400,
			max_rows_per_run: 5000,
		});
		sqlite.close();
	});

	it("preserves configured attribution and cost windows and run caps during activation", () => {
		const sqlite = new DatabaseSync(":memory:");
		sqlite.exec(
			readFileSync(
				join(
					migrationsDirectory,
					"20261021192732_d1_retention_policies/migration.sql",
				),
				"utf8",
			),
		);
		sqlite.exec(`INSERT INTO d1_retention_policies(table_name, mode, keep_days, max_rows_per_run)
			VALUES ('external_agent_attributions','dry_run',60,250), ('tedi_call_costs','off',500,100)`);
		const activation = readFileSync(
			join(
				migrationsDirectory,
				"20261111205403_move_attribution_and_cost_retention/migration.sql",
			),
			"utf8",
		);
		sqlite.exec(activation);
		sqlite.exec(activation);
		expect(
			sqlite
				.prepare(
					"SELECT table_name, mode, keep_days, max_rows_per_run FROM d1_retention_policies WHERE table_name IN ('external_agent_attributions', 'tedi_call_costs') ORDER BY table_name",
				)
				.all(),
		).toEqual([
			{
				table_name: "external_agent_attributions",
				mode: "move_to_logs_db",
				keep_days: 60,
				max_rows_per_run: 250,
			},
			{
				table_name: "tedi_call_costs",
				mode: "move_to_logs_db",
				keep_days: 500,
				max_rows_per_run: 100,
			},
		]);
		sqlite.close();
	});

	it.each(["off", "move_to_logs_db", "archive_then_delete", "delete"])(
		"preserves an operator's %s artifact policy",
		(mode) => {
			const sqlite = new DatabaseSync(":memory:");
			sqlite.exec(
				readFileSync(
					join(
						migrationsDirectory,
						"20261021192732_d1_retention_policies/migration.sql",
					),
					"utf8",
				),
			);
			sqlite
				.prepare(
					"UPDATE d1_retention_policies SET mode = ?, keep_days = 30, max_rows_per_run = 25 WHERE table_name = 'skill_run_artifacts'",
				)
				.run(mode);
			for (const directory of [
				"20261105023558_skill_artifact_retention_move_to_logs_db",
				"20261105065416_skill_artifact_retention_page_cap",
				"20261105103437_skill_artifact_retention_head_cap",
			]) {
				sqlite.exec(
					readFileSync(
						join(migrationsDirectory, directory, "migration.sql"),
						"utf8",
					),
				);
			}
			expect(
				sqlite
					.prepare(
						"SELECT mode, keep_days, max_rows_per_run FROM d1_retention_policies WHERE table_name = 'skill_run_artifacts'",
					)
					.get(),
			).toEqual({ mode, keep_days: 30, max_rows_per_run: 25 });
			sqlite.close();
		},
	);
});
