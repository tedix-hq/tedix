import { expect, it } from "vite-plus/test";
import { createDbQueryClient } from "../query-client";
import { createD1Facade } from "../test/d1-facade";
import { createMigratedSqlite } from "../test/migrated-sqlite";
import { getTodayProjectTotals } from "./today-project";

it("reads only the project's workspace outputs, not every output index row of the organization", async () => {
	const sqlite = createMigratedSqlite({ foreignKeys: false });
	sqlite.exec(`INSERT INTO os_workspaces (id, organization_id, name, created_by_kind, created_by_id, visibility, status)
		VALUES ('ws-shared', 'org-one', 'Shared', 'user', 'ada', 'org', 'active'),
		       ('ws-private', 'org-one', 'Private', 'user', 'ada', 'private', 'active'),
		       ('ws-other', 'org-one', 'Other project', 'user', 'ada', 'org', 'active')`);
	sqlite.exec(`INSERT INTO os_workspace_projects (id, organization_id, workspace_id, project_id, status, created_by_kind, created_by_id)
		VALUES ('link-shared', 'org-one', 'ws-shared', 'project', 'active', 'user', 'ada'),
		       ('link-private', 'org-one', 'ws-private', 'project', 'active', 'user', 'ada'),
		       ('link-other', 'org-one', 'ws-other', 'project-two', 'active', 'user', 'ada')`);
	const insertOutput = sqlite.prepare(`INSERT INTO workspace_output_index
		(id, organization_id, workspace_id, output_id, revision, revision_id, is_current, output_kind, title, status,
		 output_created_by_kind, output_created_by_id, output_created_at,
		 revision_created_by_kind, revision_created_by_id, revision_created_at, updated_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active',
		 'user', 'ada', '2026-11-01T00:00:00.000Z', 'user', 'ada', ?, ?)`);
	// Revisions of outputs in workspaces outside the project must not be read.
	for (let i = 0; i < 50; i++) {
		const at = `2026-11-02T00:${String(i % 60).padStart(2, "0")}:00.000Z`;
		insertOutput.run(
			`other:${i}`,
			"org-one",
			"ws-other",
			"output-other",
			i,
			`revision-other-${i}`,
			i === 49 ? 1 : 0,
			"document",
			`Other ${i}`,
			at,
			at,
		);
	}
	insertOutput.run(
		"doc:1",
		"org-one",
		"ws-shared",
		"doc",
		1,
		"revision-doc-1",
		1,
		"document",
		"Plan",
		"2026-11-03T00:00:00.000Z",
		"2026-11-03T00:00:00.000Z",
	);
	insertOutput.run(
		"secret:1",
		"org-one",
		"ws-private",
		"secret",
		1,
		"revision-secret-1",
		1,
		"document",
		"Private",
		"2026-11-03T00:00:00.000Z",
		"2026-11-03T00:00:00.000Z",
	);
	// The requests and approvals CTEs seek the person's own rows through their
	// approver/target indexes; this test pins the documents loop order, which
	// used to scan every output index row of the organization.
	const plans: string[] = [];
	const db = createDbQueryClient(
		createD1Facade({
			prepare(query) {
				if (query.includes('"workspace_output_index"'))
					plans.push(
						...sqlite
							.prepare(`EXPLAIN QUERY PLAN ${query}`)
							.all(...Array((query.match(/\?/g) ?? []).length).fill(null))
							.map((row) => String((row as { detail: string }).detail)),
					);
				return sqlite.prepare(query);
			},
			exec: (query) => sqlite.exec(query),
		}),
	);

	const totals = await getTodayProjectTotals(db, {
		orgId: "org-one",
		projectId: "project",
		personId: "person",
		since: "2026-11-01T00:00:00.000Z",
		until: "2026-11-04T00:00:00.000Z",
		excludeOutputId: "today",
	});
	expect(totals.documents).toBe(1);
	expect(JSON.parse(totals.receiptsJson)).toEqual([
		{
			id: "doc",
			title: "Plan",
			at: "2026-11-03T00:00:00.000Z",
			source: "/outputs/doc",
		},
	]);
	// The output index is probed per project workspace; nothing scans the
	// organization's whole output history.
	expect(plans).toEqual(
		expect.arrayContaining([
			"SEARCH l USING INDEX os_workspace_projects_org_project_status_idx (organization_id=? AND project_id=? AND status=?)",
			"SEARCH s USING INDEX os_workspaces_org_id_unique (organization_id=? AND id=?)",
			"SEARCH o USING INDEX workspace_output_index_org_workspace_current_idx (organization_id=? AND workspace_id=? AND is_current=?)",
		]),
	);
	expect(plans.some((line) => line.startsWith("SCAN o"))).toBe(false);
});
