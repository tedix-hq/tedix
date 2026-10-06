import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vite-plus/test";

const MIGRATION = readFileSync(
	new URL(
		"../../drizzle/20260829091858_require_structured_child_run_stop_metadata/migration.sql",
		import.meta.url,
	),
	"utf8",
).replaceAll("--> statement-breakpoint", "");

describe("structured child-run stop metadata migration", () => {
	it("backfills marker-matched terminal events and Home summaries only", () => {
		const sqlite = new DatabaseSync(":memory:");
		sqlite.exec(`
			CREATE TABLE tedi_runtime_events (
				id TEXT PRIMARY KEY,
				tedi_id TEXT NOT NULL,
				run_id TEXT,
				kind TEXT NOT NULL,
				payload TEXT
			);
			CREATE TABLE kernel_runtime_runs (
				id TEXT PRIMARY KEY,
				preview TEXT,
				metadata TEXT
			);
		`);
		const marker =
			"[Turn stopped early: per-turn provider-call ceiling reached (10/10 steps).]";
		const insertEvent = sqlite.prepare(
			"INSERT INTO tedi_runtime_events VALUES (?, ?, ?, ?, ?)",
		);
		insertEvent.run("terminal", "tedi-1", "run-1", "run.completed", "{}");
		insertEvent.run(
			"marker",
			"tedi-1",
			"run-1",
			"message.completed",
			JSON.stringify({ role: "assistant", content: marker }),
		);
		insertEvent.run(
			"structured",
			"tedi-1",
			"run-2",
			"run.completed",
			JSON.stringify({ stopReason: "step_ceiling", keep: true }),
		);
		sqlite
			.prepare("INSERT INTO kernel_runtime_runs VALUES (?, ?, ?), (?, ?, ?)")
			.run(
				"legacy-home",
				marker,
				JSON.stringify({
					childRunStatus: "completed",
					childRunPreview: marker,
					keep: true,
				}),
				"ordinary-home",
				"Complete",
				JSON.stringify({ childRunStatus: "completed", keep: true }),
			);

		sqlite.exec(MIGRATION);

		const terminal = JSON.parse(
			(
				sqlite
					.prepare(
						"SELECT payload FROM tedi_runtime_events WHERE id='terminal'",
					)
					.get() as { payload: string }
			).payload,
		);
		expect(terminal).toEqual({ stopReason: "step_ceiling" });
		const structured = JSON.parse(
			(
				sqlite
					.prepare(
						"SELECT payload FROM tedi_runtime_events WHERE id='structured'",
					)
					.get() as { payload: string }
			).payload,
		);
		expect(structured).toEqual({ stopReason: "step_ceiling", keep: true });
		const home = JSON.parse(
			(
				sqlite
					.prepare(
						"SELECT metadata FROM kernel_runtime_runs WHERE id='legacy-home'",
					)
					.get() as { metadata: string }
			).metadata,
		);
		expect(home).toEqual({
			childRunStatus: "partial",
			childRunPreview: marker,
			childRunStopReason: "step_ceiling",
			keep: true,
		});
		const ordinary = JSON.parse(
			(
				sqlite
					.prepare(
						"SELECT metadata FROM kernel_runtime_runs WHERE id='ordinary-home'",
					)
					.get() as { metadata: string }
			).metadata,
		);
		expect(ordinary).toEqual({ childRunStatus: "completed", keep: true });
	});
});
