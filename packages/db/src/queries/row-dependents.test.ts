import { DatabaseSync } from "node:sqlite";
import type { SQLiteTable } from "drizzle-orm/sqlite-core";
import { describe, expect, it } from "vite-plus/test";
import { createDbClient } from "../client";
import { createDbQueryClient } from "../query-client";
import { organizations } from "../schema/organizations";
import {
	policyPacks,
	runtimeProfiles,
	workspaceTemplateSets,
} from "../schema/control-plane";
import { projects } from "../schema/projects";
import { tediObjectives } from "../schema/tedi-objectives";
import { tedis } from "../schema/tedis";
import { workItems } from "../schema/work-items";
import { osWorkspaces, osWorkspaceProjects } from "../schema/os-workspaces";
import { workAgentSessions } from "../schema/work-agent-sessions";
import { userConfigs } from "../schema/user-configs";
import { workItemSources } from "../schema/work-item-sources";
import { createD1Facade } from "../test/d1-facade";
import { schemaDdl } from "../test/schema-ddl";
import { listRowDependents, rowDependentsBlocking } from "./row-dependents";

function setup(
	sql = "",
	tables: SQLiteTable[] = [
		organizations,
		policyPacks,
		runtimeProfiles,
		workspaceTemplateSets,
		tedis,
	],
) {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec("PRAGMA foreign_keys = ON;");
	sqlite.exec(schemaDdl(...tables));
	if (sql) sqlite.exec(sql);
	const db = createDbClient(createD1Facade(sqlite));
	return { db, reader: createDbQueryClient(db.$client) };
}

describe("listRowDependents", () => {
	it("counts every tedi bound to any revision of the same policy pack", async () => {
		const { reader } = setup(`
			INSERT INTO organizations (id, name, slug) VALUES ('org-1', 'Org', 'org');
			INSERT INTO policy_packs
				(id, organization_id, name, slug, scope, status, version, definition)
			VALUES
				('pack-v1', 'org-1', 'Default', 'default', 'organization', 'active', 1, '{}'),
				('pack-v2', 'org-1', 'Default', 'default', 'organization', 'active', 2, '{}'),
				('pack-other', 'org-1', 'Other', 'other-pack', 'organization', 'active', 1, '{}');
			INSERT INTO tedis
				(id, organization_id, name, slug, policy_pack_id, retired_at)
			VALUES
				('tedi-1', 'org-1', 'Tedi One', 'tedi-one', 'pack-v1', NULL),
				('tedi-2', 'org-1', 'Tedi Two', 'tedi-two', 'pack-v2', NULL),
				('tedi-3', 'org-1', 'Retired', 'retired', 'pack-v1', '2026-01-01T00:00:00Z'),
				('tedi-4', 'org-1', 'Elsewhere', 'elsewhere', 'pack-other', NULL);
		`);
		const dependents = await listRowDependents(reader, {
			kind: "policy_pack",
			id: "pack-v2",
		});
		expect(dependents.map((row) => row.key).sort()).toEqual([
			"tedi:tedi-1",
			"tedi:tedi-2",
		]);
		expect(rowDependentsBlocking(dependents)).toHaveLength(2);
	});

	it("lists a project's open Work, factory binding and workspace links", async () => {
		const { reader } = setup(
			`
			INSERT INTO organizations (id, name, slug) VALUES ('org-1', 'Org', 'org');
			INSERT INTO projects
				(id, org_id, key, name, status, metadata, created_at)
			VALUES
				('proj-1', 'org-1', 'P1', 'Nightly', 'active',
					'{"factory":{"slug":"nightly","name":"Nightly Factory"}}',
					'2026-01-01T00:00:00Z');
			INSERT INTO work_items
				(id, org_id, title, project_id, disposition, created_at)
			VALUES
				('w-open', 'org-1', 'Open', 'proj-1', 'accepted', '2026-01-01T00:00:00Z'),
				('w-done', 'org-1', 'Done', 'proj-1', 'completed', '2026-01-01T00:00:00Z');
			INSERT INTO os_workspaces
				(id, organization_id, name, created_by_kind, created_by_id, created_at, updated_at)
			VALUES ('ws-1', 'org-1', 'Ops', 'user', 'u-1', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z');
			INSERT INTO os_workspace_projects
				(id, organization_id, workspace_id, project_id, created_by_kind, created_by_id, created_at, updated_at)
			VALUES ('wsp-1', 'org-1', 'ws-1', 'proj-1', 'user', 'u-1', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z');
			`,
			[
				organizations,
				policyPacks,
				runtimeProfiles,
				workspaceTemplateSets,
				tedis,
				tediObjectives,
				projects,
				workItems,
				osWorkspaces,
				osWorkspaceProjects,
				workAgentSessions,
				userConfigs,
				workItemSources,
			],
		);
		const dependents = await listRowDependents(reader, {
			kind: "project",
			id: "proj-1",
			orgId: "org-1",
		});
		const keys = dependents.map((row) => row.key).sort();
		expect(keys).toEqual(["factory:proj-1", "work:open", "workspace:ws-1"]);
		// The linked workspace is informational; the open Work and the factory
		// schedule are what stop working.
		expect(
			rowDependentsBlocking(dependents)
				.map((row) => row.key)
				.sort(),
		).toEqual(["factory:proj-1", "work:open"]);
		expect(
			rowDependentsBlocking(dependents, ["work:open", "factory:proj-1"]),
		).toHaveLength(0);
	});
});
