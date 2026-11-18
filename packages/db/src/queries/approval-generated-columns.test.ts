import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vite-plus/test";
import { tediApprovalRequests } from "../schema/approvals";
import { schemaDdl } from "../test/schema-ddl";

it("indexes approval execution state and recomputes consumption and dismissal", () => {
	const sqlite = new DatabaseSync(":memory:");
	try {
		sqlite.exec(schemaDdl(tediApprovalRequests));
		sqlite.exec("PRAGMA foreign_keys = OFF");
		sqlite.exec(`INSERT INTO tedi_approval_requests
			(id,tedi_id,org_id,action_type,description,payload,status,created_at,expires_at)
			VALUES ('one','tedi','org','mcp.tool_call','Example','{"execution":{"status":"queued"}}','approved','2026-11-18','2026-11-19')`);
		expect(
			sqlite
				.prepare(
					"SELECT execution_status, execution_dismissed_at, consumed_at FROM tedi_approval_requests",
				)
				.get(),
		).toEqual({
			execution_status: "queued",
			execution_dismissed_at: null,
			consumed_at: null,
		});
		const query =
			"SELECT id FROM tedi_approval_requests WHERE org_id='org' AND status='approved' AND action_type='mcp.tool_call' AND execution_dismissed_at IS NULL AND execution_status='queued' AND expires_at>'2026-11-18'";
		expect(
			sqlite
				.prepare(`EXPLAIN QUERY PLAN ${query}`)
				.all()
				.map((row) => String(row.detail)),
		).toContainEqual(
			expect.stringContaining(
				"USING INDEX idx_approval_requests_execution_attention",
			),
		);
		sqlite.exec(
			`UPDATE tedi_approval_requests SET payload=json_set(payload,'$.execution.status','running','$.consumedAt','2026-11-18','$.execution.dismissedAt','2026-11-18')`,
		);
		expect(sqlite.prepare(query).all()).toEqual([]);
		expect(
			sqlite
				.prepare(
					"SELECT execution_status, execution_dismissed_at, consumed_at FROM tedi_approval_requests",
				)
				.get(),
		).toEqual({
			execution_status: "running",
			execution_dismissed_at: "2026-11-18",
			consumed_at: "2026-11-18",
		});
	} finally {
		sqlite.close();
	}
});
