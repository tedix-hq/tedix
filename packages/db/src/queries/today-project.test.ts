import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vite-plus/test";
import { createDbClient } from "../client";
import { createD1Facade } from "../test/d1-facade";
import { getTodayProjectTotals } from "./today-project";

it("counts the person's project receipts without deriving attention from the interaction ledger", async () => {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec(`
	CREATE TABLE work_items(id TEXT, org_id TEXT, project_id TEXT);
	CREATE TABLE work_interactions(id TEXT, org_id TEXT, work_item_id TEXT, project_id TEXT, target_type TEXT, target_id TEXT, status TEXT, expires_at TEXT, due_at TEXT, metadata TEXT, kind TEXT, resolved_at TEXT, created_at TEXT);
	CREATE TABLE os_outputs(id TEXT, organization_id TEXT, workspace_id TEXT, title TEXT, updated_at TEXT, kind TEXT, status TEXT);
	CREATE TABLE os_workspace_projects(organization_id TEXT, workspace_id TEXT, project_id TEXT, status TEXT);
	CREATE TABLE os_workspaces(id TEXT, organization_id TEXT, visibility TEXT, status TEXT);
	CREATE TABLE work_approval_proposals(id TEXT, org_id TEXT, work_item_id TEXT, approver_type TEXT, approver_id TEXT, status TEXT, expires_at TEXT, resolved_at TEXT, created_at TEXT);
	INSERT INTO work_items VALUES ('work','org-one','project');
	INSERT INTO os_workspaces VALUES ('shared','org-one','org','active'),('private','org-one','private','active');
	INSERT INTO os_workspace_projects VALUES ('org-one','shared','project','active'),('org-one','private','project','active');
	INSERT INTO os_outputs VALUES ('doc','org-one','shared','Plan','2026-10-18 08:00:00','document','active'),('today','org-one','shared','Today','2026-10-18T09:00:00.000Z','document','active'),('secret','org-one','private','Private','2026-10-18T08:00:00.000Z','document','active');
	`);
	const insert = sqlite.prepare(
		"INSERT INTO work_interactions VALUES (?,?,?,?,'user',?,?,NULL,NULL,?,'question',?,?)",
	);
	for (const [id, org, person, status, metadata, resolved] of [
		["open", "org-one", "person", "open", "{}", null],
		["other-person", "org-one", "someone-else", "open", "{}", null],
		["other-org", "org-two", "person", "open", "{}", null],
		[
			"fyi",
			"org-one",
			"person",
			"open",
			'{"schema":"tedix.decision-capture.v1","attention":{"kind":"fyi"}}',
			null,
		],
		["done", "org-one", "person", "resolved", "{}", "2026-10-18T07:00:00.000Z"],
	])
		insert.run(
			id!,
			org!,
			"work",
			null,
			person!,
			status!,
			metadata!,
			resolved!,
			"2026-10-18T06:00:00.000Z",
		);
	const totals = await getTodayProjectTotals(
		createDbClient(createD1Facade(sqlite)),
		{
			orgId: "org-one",
			projectId: "project",
			personId: "person",
			since: "2026-10-17T22:00:00.000Z",
			until: "2026-10-18T22:00:00.000Z",
			excludeOutputId: "today",
		},
	);
	expect(totals).toMatchObject({
		decisions: 1,
		documents: 1,
		lastTouched: "2026-10-18T08:00:00.000Z",
	});
	expect(totals).not.toHaveProperty("needsYou");
	expect(JSON.parse(totals.receiptsJson)).toEqual([
		{
			id: "doc",
			title: "Plan",
			at: "2026-10-18T08:00:00.000Z",
			source: "/outputs/doc",
		},
	]);
	sqlite.close();
});
