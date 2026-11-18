import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vite-plus/test";
import { workItems } from "../../schema/work-items";
import { schemaDdl } from "../../test/schema-ddl";

it("indexes Work metadata and recomputes observer report and wake state", () => {
	const sqlite = new DatabaseSync(":memory:");
	try {
		sqlite.exec(schemaDdl(workItems));
		sqlite.exec("PRAGMA foreign_keys = OFF");
		sqlite.exec(`INSERT INTO work_items(id,org_id,project_id,title,created_at,metadata) VALUES
			('work','org','project','Example','2026-11-18','{"repositoryObserver":1,"executor":"codex","source":"example","observerWokenAt":"2026-11-18"}')`);
		expect(
			sqlite
				.prepare(
					"SELECT repository_observer,report,observer_woken_at,metadata_executor,metadata_source FROM work_items",
				)
				.get(),
		).toEqual({
			repository_observer: 1,
			report: null,
			observer_woken_at: "2026-11-18",
			metadata_executor: "codex",
			metadata_source: "example",
		});
		for (const [where, index] of [
			[
				"org_id='org' AND project_id='project' AND repository_observer=1 AND report IS NULL AND observer_woken_at >= '2026-11-17'",
				"idx_work_items_observer_report_woken",
			],
			[
				"org_id='org' AND metadata_executor='codex'",
				"idx_work_items_metadata_executor",
			],
			[
				"org_id='org' AND metadata_source='example'",
				"idx_work_items_metadata_source",
			],
		]) {
			expect(
				sqlite
					.prepare(
						`EXPLAIN QUERY PLAN SELECT id FROM work_items WHERE ${where}`,
					)
					.all()
					.map((row) => String(row.detail)),
			).toContainEqual(expect.stringContaining(`USING INDEX ${index}`));
		}
		sqlite.exec(
			`UPDATE work_items SET metadata=json_set(metadata,'$.report',json('{"done":true}'),'$.observerWokenAt','2026-11-19')`,
		);
		expect(
			sqlite.prepare("SELECT report,observer_woken_at FROM work_items").get(),
		).toEqual({ report: '{"done":true}', observer_woken_at: "2026-11-19" });
		expect(
			sqlite.prepare("SELECT id FROM work_items WHERE report IS NULL").all(),
		).toEqual([]);
	} finally {
		sqlite.close();
	}
});
