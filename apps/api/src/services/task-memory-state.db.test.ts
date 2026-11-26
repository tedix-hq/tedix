import { expect, it } from "vite-plus/test";
import { createDbClient } from "@tedix/db/client";
import { createD1Facade } from "@tedix/db/test/d1-facade";
import { createMigratedSqlite } from "../../../../packages/db/src/test/migrated-sqlite";
import { readRuntimeTurnMemory } from "../rpc/routers/cognitive-runtime/turn-memory";
import type { BaseContext } from "../rpc/orpc";

it("bounds getTurnMemory to 14 statements for 100 references while retaining terminal, expired and newest-100 states", async () => {
	const sqlite = createMigratedSqlite({ foreignKeys: false });
	sqlite.exec(
		"INSERT INTO organizations(id,name,slug) VALUES ('org','Example','example')",
	);
	sqlite.exec(
		"INSERT INTO tedis(id,organization_id,name,slug) VALUES ('tedi','org','Assistant','assistant')",
	);
	const work = sqlite.prepare(
		"INSERT INTO work_items(id,org_id,title,disposition,admission_spec_revision,created_at) VALUES (?,'org',?,'completed','revision','2026-01-01')",
	);
	const references = Array.from({ length: 98 }, (_, i) => `work-${i}`);
	for (const id of references) work.run(id, id);
	sqlite.exec(
		"INSERT INTO organization_members(id,organization_id,descope_user_id,user_id,email,status) VALUES ('reviewer','org','reviewer','reviewer','reviewer@example.com','active')",
	);
	const approval = sqlite.prepare(
		"INSERT INTO work_approval_proposals(id,org_id,work_item_id,work_item_version,authority_key,action,proposal,requester_type,requester_id,approver_type,approver_id,status,rationale,expires_at,created_at) VALUES (?,'org','work-0',1,?,'admission','{}','system','tedix','user','reviewer','pending','Review','2026-02-01T00:00:00.000Z',?)",
	);
	for (let i = 0; i < 101; i++)
		approval.run(
			`approval-${String(i).padStart(3, "0")}`,
			`risk:high-${i}`,
			new Date(Date.parse("2026-01-01T00:00:00.000Z") + i).toISOString(),
		);
	sqlite.exec(
		"INSERT INTO tedi_approval_requests(id,tedi_id,org_id,action_type,description,payload,expires_at,created_at) VALUES ('runtime','tedi','org','custom','Runtime approval','{}','2026-02-01T00:00:00.000Z','2026-01-01T00:00:00.000Z')",
	);
	// An explicitly referenced proposal outside the linked newest-100 window remains visible.
	references.push("approval-000", "runtime");
	const statements: string[] = [];
	const db = createDbClient(
		createD1Facade(sqlite, {
			maxBoundParams: 100,
			onPrepare: (query) => statements.push(query),
		}),
	);
	const result = await readRuntimeTurnMemory(
		{
			db,
			headers: new Headers({
				"X-Tedix-Tedi-Id": "tedi",
				"X-Tedix-Org-Id": "org",
			}),
		} as BaseContext,
		{ tediId: "tedi", references },
	);
	expect(statements.length).toBeLessThanOrEqual(14);
	const plans = statements.flatMap((query) =>
		sqlite
			.prepare(`EXPLAIN QUERY PLAN ${query}`)
			.all(...Array((query.match(/\?/g) ?? []).length).fill(null))
			.map((row) => String(row.detail)),
	);
	expect(plans).toContain(
		"SEARCH tedi_approval_requests USING INDEX sqlite_autoindex_tedi_approval_requests_1 (id=?)",
	);
	expect(plans).toContain(
		"SEARCH work_approval_proposals USING INDEX sqlite_autoindex_work_approval_proposals_1 (id=?)",
	);
	expect(
		statements.filter((query) => query.includes("work_approval_executions")),
	).toHaveLength(0);
	expect(result.tasks.map((task) => task.id)).toEqual([
		"work-0",
		...Array.from(
			{ length: 100 },
			(_, i) => `approval-${String(100 - i).padStart(3, "0")}`,
		),
		...references.slice(1),
	]);
	expect(result.tasks[0]?.state).toBe("completed");
	expect(
		result.tasks
			.filter((task) => task.kind === "approval")
			.every((task) => task.state === "expired"),
	).toBe(true);
	expect(result.unresolvedReferences).toEqual([]);
	expect(result.truncated).toBe(false);
	statements.length = 0;
	const single = await readRuntimeTurnMemory(
		{
			db,
			headers: new Headers({
				"X-Tedix-Tedi-Id": "tedi",
				"X-Tedix-Org-Id": "org",
			}),
		} as BaseContext,
		{ tediId: "tedi", references: ["work-0", "work-0"] },
	);
	expect(statements).toHaveLength(10);
	expect(single.tasks).toEqual(result.tasks.slice(0, 101));
});
