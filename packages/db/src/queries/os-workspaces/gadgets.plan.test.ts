import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vite-plus/test";
import { createDbQueryClient } from "../../query-client";
import {
	osGadgetRevisions,
	osGadgets,
	osWorkspaces,
} from "../../schema/os-workspaces";
import { createD1Facade } from "../../test/d1-facade";
import { schemaDdl } from "../../test/schema-ddl";
import {
	createOsGadgetRevision,
	listOsWorkApps,
	listCardSourceApps,
} from "./gadgets";

describe("OS gadget list query plans", () => {
	it("reads active apps in creation order without scanning or sorting the gadget table", async () => {
		const sqlite = new DatabaseSync(":memory:");
		sqlite.exec(`
			CREATE TABLE organizations (id TEXT PRIMARY KEY NOT NULL);
			CREATE TABLE os_workspaces (
				id TEXT PRIMARY KEY NOT NULL,
				organization_id TEXT NOT NULL REFERENCES organizations(id)
			);
		`);
		sqlite.exec(schemaDdl(osGadgets, osGadgetRevisions));

		let query = "";
		const db = createDbQueryClient(
			createD1Facade(sqlite, {
				onPrepare(sql) {
					query = sql;
				},
			}),
		);
		await listCardSourceApps(db, { limit: 500 });

		const plan = sqlite
			.prepare(`EXPLAIN QUERY PLAN ${query}`)
			.all(...Array((query.match(/\?/g) ?? []).length).fill(null))
			.map((row) => String(row.detail));
		expect(plan).toContain(
			"SEARCH os_gadgets USING INDEX os_gadgets_status_created_idx (status=?)",
		);
		expect(plan.some((line) => /SCAN os_gadgets/.test(line))).toBe(false);
		expect(plan.some((line) => /TEMP B-TREE/.test(line))).toBe(false);
		sqlite.close();
	});

	it("seeks card-source revisions before gadgets with production statistics", async () => {
		const sqlite = new DatabaseSync(":memory:");
		sqlite.exec(schemaDdl(osGadgets, osGadgetRevisions));
		// Existing production stats, plus new-index cardinality from 32 matching
		// revisions across 10 organizations and 16 gadgets (ceil averages).
		sqlite.exec(`
			ANALYZE;
			INSERT INTO sqlite_stat1 (tbl, idx, stat) VALUES
				('os_gadgets', 'os_gadgets_triggers_status_created_idx', '1389 153 153 1 1'),
				('os_gadgets', 'os_gadgets_org_status_created_idx', '1389 31 31 1 1'),
				('os_gadgets', 'os_gadgets_status_created_idx', '1389 162 1 1'),
				('os_gadgets', 'os_gadgets_workspace_name_unique', '1389 39 1'),
				('os_gadgets', 'sqlite_autoindex_os_gadgets_1', '1389 1'),
				('os_gadget_revisions', 'os_gadget_revisions_org_idx', '2260 23'),
				('os_gadget_revisions', 'os_gadget_revisions_gadget_revision_unique', '2260 2 1'),
				('os_gadget_revisions', 'sqlite_autoindex_os_gadget_revisions_1', '2260 1'),
				('os_gadget_revisions', 'os_gadget_revisions_card_source_org_idx', '32 4 2 1');
			ANALYZE sqlite_schema;
		`);
		let query = "";
		const db = createDbQueryClient(
			createD1Facade(sqlite, {
				onPrepare: (sql) => {
					query = sql;
				},
			}),
		);
		await listCardSourceApps(db, { organizationId: "org-1", limit: 201 });
		const plan = sqlite
			.prepare(`EXPLAIN QUERY PLAN ${query}`)
			.all("org-1", "active", 201)
			.map((row) => String(row.detail));
		expect(plan[0]).toBe(
			"SEARCH os_gadget_revisions USING INDEX os_gadget_revisions_card_source_org_idx (organization_id=?)",
		);
		expect(plan[1]).toBe(
			"SEARCH os_gadgets USING INDEX sqlite_autoindex_os_gadgets_1 (id=?)",
		);
		sqlite.close();
	});
});

it("seeks Work apps past unrelated manifests and revision history with bounded ordered results", async () => {
	const sqlite = new DatabaseSync(":memory:");
	try {
		sqlite.exec(
			schemaDdl(
				{ foreignKeys: false },
				osWorkspaces,
				osGadgets,
				osGadgetRevisions,
			),
		);
		sqlite.exec(`INSERT INTO os_workspaces (id, organization_id, name, created_by_kind, created_by_id, created_at, updated_at)
			VALUES ('ws', 'org', 'Apps', 'user', 'ada', 'now', 'now');
			WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<1000)
			INSERT INTO os_workspaces (id, organization_id, name, created_by_kind, created_by_id, created_at, updated_at)
			SELECT 'ws-'||x, 'org', 'Apps-'||x, 'user', 'ada', 'now', 'now' FROM n;
			WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<6000)
			INSERT INTO os_gadgets (id, organization_id, workspace_id, name, created_by_kind, created_by_id, created_at, updated_at)
			SELECT 'plain-'||x, 'org', 'ws', 'plain-'||x, 'user', 'ada', 'now', 'now' FROM n;
			INSERT INTO os_gadgets (id, organization_id, workspace_id, name, created_by_kind, created_by_id, created_at, updated_at)
			VALUES ('work', 'org', 'ws', 'Work', 'user', 'ada', 'now', 'now');`);
		let query = "";
		const db = createDbQueryClient(
			createD1Facade(sqlite, {
				onPrepare: (sql) => {
					query = sql;
				},
			}),
		);
		await createOsGadgetRevision(db, {
			id: "r1",
			gadgetId: "work",
			organizationId: "org",
			manifest: '{"navigation":{"work":"deck"}}',
			createdByKind: "user",
			createdById: "ada",
		});
		sqlite.exec(`WITH RECURSIVE n(x) AS (SELECT 2 UNION ALL SELECT x+1 FROM n WHERE x<1000)
			INSERT INTO os_gadget_revisions (id, organization_id, gadget_id, revision, manifest, created_by_kind, created_by_id, created_at)
			SELECT 'history-'||x, 'org', 'work', x, '{}', 'user', 'ada', 'now' FROM n;
			ANALYZE;`);
		expect(
			(await listOsWorkApps(db, "org", { userIds: [] }, 1)).map(
				({ gadget }) => gadget.id,
			),
		).toEqual(["work"]);
		expect(query).not.toContain("json_extract");
		const plan = sqlite
			.prepare(`EXPLAIN QUERY PLAN ${query}`)
			.all("org", "org", "org", "active", "active", "org", 1, 1)
			.map((row) => String(row.detail))
			.join("\n");
		expect(plan).toContain("os_gadgets_org_work_status_created_idx");
		expect(plan).toContain("sqlite_autoindex_os_gadget_revisions_1 (id=?)");
		expect(plan).not.toMatch(/SCAN |TEMP B-TREE/);
		await createOsGadgetRevision(db, {
			id: "r2",
			gadgetId: "work",
			organizationId: "org",
			manifest: "{}",
			expectedRevision: 1000,
			createdByKind: "user",
			createdById: "ada",
		});
		expect(await listOsWorkApps(db, "org", { userIds: [] }, 201)).toEqual([]);
	} finally {
		sqlite.close();
	}
});
