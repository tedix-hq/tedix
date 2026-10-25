import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vite-plus/test";
import { createDbQueryClient } from "../../query-client";
import { skillEntries } from "../../schema/cognitive";
import {
	osOutputRevisions,
	osOutputs,
	osWorkspaceProjects,
} from "../../schema/os-workspaces";
import { projects } from "../../schema/projects";
import { createD1Facade } from "../../test/d1-facade";
import { schemaDdl } from "../../test/schema-ddl";
import { listOsWorkspaceSkillLinkCandidates } from "./resources";

/**
 * The skills a Workspace's own data says run it, read on real SQLite through
 * the D1 facade (which rejects BEGIN and duplicate output names).
 */
function fixture() {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec("PRAGMA foreign_keys = OFF");
	sqlite.exec(
		schemaDdl(
			projects,
			skillEntries,
			osWorkspaceProjects,
			osOutputs,
			osOutputRevisions,
		),
	);
	const skill = sqlite.prepare(
		"INSERT INTO skill_entries (id, organization_id, title, content) VALUES (?, ?, ?, '# s')",
	);
	skill.run("skill-lane", "org-1", "Daily research");
	skill.run("skill-linked-project", "org-1", "Weekly digest");
	skill.run("skill-writer", "org-1", "Card writer");
	skill.run("skill-other-org", "org-2", "Other org lane");
	skill.run("skill-unrelated", "org-1", "Unrelated");
	const project = sqlite.prepare(
		"INSERT INTO projects (id, org_id, key, name, metadata, created_at, updated_at) VALUES (?, ?, ?, ?, ?, '2026-10-01', '2026-10-01')",
	);
	project.run(
		"p-bound",
		"org-1",
		"RES",
		"Research",
		JSON.stringify({
			factory: { slug: "res", skillId: "skill-lane", workspaceId: "ws-1" },
		}),
	);
	project.run(
		"p-linked",
		"org-1",
		"DIG",
		"Digest",
		JSON.stringify({
			factory: { slug: "dig", skillId: "skill-linked-project" },
		}),
	);
	project.run(
		"p-elsewhere",
		"org-1",
		"ELS",
		"Elsewhere",
		JSON.stringify({
			factory: { slug: "els", skillId: "skill-unrelated", workspaceId: "ws-2" },
		}),
	);
	project.run(
		"p-other-org",
		"org-2",
		"OTH",
		"Other",
		JSON.stringify({
			factory: { slug: "oth", skillId: "skill-other-org", workspaceId: "ws-1" },
		}),
	);
	sqlite
		.prepare(
			"INSERT INTO os_workspace_projects (id, organization_id, workspace_id, project_id, status, created_by_kind, created_by_id, created_at, updated_at) VALUES (?, 'org-1', 'ws-1', ?, ?, 'user', 'u-1', '2026-10-01', '2026-10-01')",
		)
		.run("link-1", "p-linked", "active");
	sqlite
		.prepare(
			"INSERT INTO os_outputs (id, organization_id, workspace_id, kind, title, status, created_by_kind, created_by_id, created_at, updated_at) VALUES (?, 'org-1', ?, 'sheet', ?, 'active', 'user', 'u-1', '2026-10-01', '2026-10-01')",
		)
		.run("out-1", "ws-1", "Cards");
	const revision = sqlite.prepare(
		"INSERT INTO os_output_revisions (id, organization_id, output_id, revision, content, created_by_kind, created_by_id, created_at, skill_run_id, skill_id) VALUES (?, 'org-1', 'out-1', ?, '{}', 'tedi', 't-1', '2026-10-01', ?, ?)",
	);
	revision.run("rev-1", 1, "run-1", "skill-writer");
	revision.run("rev-2", 2, "run-2", "skill-writer");
	revision.run("rev-3", 3, "run-3", "skill-lane");
	revision.run("rev-4", 4, null, null);
	return createDbQueryClient(createD1Facade(sqlite));
}

describe("listOsWorkspaceSkillLinkCandidates", () => {
	it("finds factory lanes bound or linked to the Workspace and the skills that wrote its Outputs, once each", async () => {
		const db = fixture();
		const candidates = await listOsWorkspaceSkillLinkCandidates(db, {
			organizationId: "org-1",
			workspaceId: "ws-1",
		});
		expect(candidates).toEqual([
			{
				skillId: "skill-lane",
				title: "Daily research",
				reason: "factory_project",
			},
			{
				skillId: "skill-linked-project",
				title: "Weekly digest",
				reason: "factory_project",
			},
			{
				skillId: "skill-writer",
				title: "Card writer",
				reason: "wrote_outputs",
			},
		]);
	});

	it("returns nothing for a Workspace in another organization", async () => {
		const db = fixture();
		expect(
			await listOsWorkspaceSkillLinkCandidates(db, {
				organizationId: "org-2",
				workspaceId: "ws-9",
			}),
		).toEqual([]);
	});
});
