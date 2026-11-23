import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vite-plus/test";
import { createDbQueryClient } from "../query-client";
import { projects } from "../schema/projects";
import { tedis } from "../schema/tedis";
import { workAgentSessions } from "../schema/work-agent-sessions";
import { workProjectHealthJudgments } from "../schema/work-factory";
import { workAttempts, workItems } from "../schema/work-items";
import { createD1Facade } from "../test/d1-facade";
import { schemaDdl } from "../test/schema-ddl";
import { listProjectPortfolio } from "./projects";

it("seeks each project's next item, health and latest report from an index", async () => {
	const sqlite = new DatabaseSync(":memory:");
	try {
		sqlite.exec("PRAGMA foreign_keys=OFF");
		for (const table of [
			projects,
			tedis,
			workItems,
			workAttempts,
			workAgentSessions,
			workProjectHealthJudgments,
		])
			sqlite.exec(schemaDdl(table));
		const statements: string[] = [];
		const db = createDbQueryClient(
			createD1Facade(sqlite, {
				onPrepare: (statement) => {
					statements.push(statement);
				},
			}),
		);
		await listProjectPortfolio(db, { orgId: "org-example", limit: 1000 });
		const plan = (needle: string) => {
			const query = statements.find((s) => s.includes(needle))!;
			const params = Array.from(
				{ length: (query.match(/\?/g) ?? []).length },
				() => "org-example",
			);
			return sqlite
				.prepare(`EXPLAIN QUERY PLAN ${query}`)
				.all(...params)
				.map((row) => String(row.detail))
				.join(" | ");
		};
		const areas = plan("next_item");
		expect(areas).toContain(
			"idx_work_items_org_project_disposition (org_id=? AND project_id=? AND disposition=?)",
		);
		expect(areas).toContain(
			"idx_work_project_health_observed (org_id=? AND project_id=?)",
		);
		expect(areas).toContain("idx_work_agent_sessions_org_project_last_event");
		expect(areas).not.toMatch(/SCAN (next|judged|report)\b/);
	} finally {
		sqlite.close();
	}
});
