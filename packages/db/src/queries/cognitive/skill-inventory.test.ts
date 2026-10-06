import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vite-plus/test";
import { createDbClient } from "../../client";
import { createD1Facade } from "../../test/d1-facade";
import {
	listAllSkillsForOrg,
	listExecutableSkillWorkflowsForOrg,
} from "./skill-inventory";

describe("skill inventory search", () => {
	let sqlite: DatabaseSync;
	let db: ReturnType<typeof createDbClient>;

	beforeEach(() => {
		sqlite = new DatabaseSync(":memory:");
		sqlite.exec(`
			CREATE TABLE skill_entries (
				id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, tedi_id TEXT,
				domain_id TEXT, title TEXT NOT NULL, slug TEXT, folder_path TEXT,
				description TEXT,
				content TEXT NOT NULL, files TEXT, input_schema TEXT,
				success_count INTEGER NOT NULL DEFAULT 0,
				failure_count INTEGER NOT NULL DEFAULT 0, last_used_at TEXT,
				avg_duration_ms INTEGER, revision INTEGER NOT NULL DEFAULT 1,
				revision_reasoning TEXT, supersedes_id TEXT, source_skill_id TEXT,
				source_revision INTEGER, visibility TEXT NOT NULL DEFAULT 'private',
				agent_skills_format TEXT, r2_path TEXT, app_id TEXT, tool_ids TEXT,
				summary TEXT, tags TEXT, audience TEXT, preconditions TEXT,
				lifecycle_state TEXT DEFAULT 'draft', review_flagged_at TEXT,
				review_flag_reason TEXT, pace_layer TEXT NOT NULL DEFAULT 'innovation',
				proposed_by_tedi_id TEXT, created_at TEXT, updated_at TEXT
			);
			INSERT INTO skill_entries (
				id, organization_id, title, slug, folder_path, description, content, files,
				visibility, lifecycle_state, updated_at
			) VALUES
				('skill-1', 'org-1', 'Weekly digest', 'weekly-digest', 'operations/reports',
				 'Sends the customer report', '# Digest',
				 '{"scripts/workflow.ts":"export default {}"}', 'org', 'active',
				 '2026-08-30T10:00:00.000Z'),
				('skill-2', 'org-1', 'Invoice review', 'invoice-review', NULL,
				 'Checks accounting totals', '# Review', NULL, 'org', 'active',
				 '2026-08-30T09:00:00.000Z'),
				('skill-3', 'org-2', 'Other digest', 'other-digest', 'operations',
				 'Must remain tenant isolated', '# Other',
				 '{"scripts/workflow.ts":"export default {}"}', 'org', 'active',
					'2026-08-30T11:00:00.000Z');
			UPDATE skill_entries
			SET domain_id = 'domain-ops', tedi_id = 'tedi-1'
			WHERE id = 'skill-1';
			INSERT INTO skill_entries (
				id, organization_id, tedi_id, domain_id, title, slug, folder_path,
				description, content, visibility, lifecycle_state, supersedes_id, updated_at
			) VALUES
				('skill-4', 'org-1', NULL, 'domain-ops', 'Baseline', 'baseline',
				 'operations/overrides', 'Org baseline', '# Baseline', 'org', 'active', NULL,
				 '2026-08-30T08:00:00.000Z'),
				('skill-5', 'org-1', 'tedi-1', 'domain-ops', 'Override', 'override',
				 'operations/overrides', 'Tedi override', '# Override', 'private', 'active',
				 'skill-4', '2026-08-30T12:00:00.000Z');
		`);
		db = createDbClient(createD1Facade(sqlite));
	});

	it("filters canonical fields before counting and paginating", async () => {
		const result = await listAllSkillsForOrg(db, "org-1", {
			limit: 1,
			offset: 0,
			query: "CUSTOMER",
		});

		expect(result.total).toBe(1);
		expect(result.entries.map((entry) => entry.id)).toEqual(["skill-1"]);
	});

	it("searches only executable workflow skills within the tenant", async () => {
		const result = await listExecutableSkillWorkflowsForOrg(db, "org-1", {
			query: "digest",
		});

		expect(result.total).toBe(1);
		expect(result.entries.map((entry) => entry.id)).toEqual(["skill-1"]);
	});

	it("searches folder paths and filters exact, recursive, and root folders", async () => {
		const searched = await listAllSkillsForOrg(db, "org-1", {
			query: "reports",
		});
		expect(searched.entries.map((entry) => entry.id)).toEqual(["skill-1"]);

		const exact = await listAllSkillsForOrg(db, "org-1", {
			folderPath: "operations",
		});
		expect(exact.total).toBe(0);

		const recursive = await listAllSkillsForOrg(db, "org-1", {
			folderPath: "operations",
			recursive: true,
		});
		expect(recursive.entries.map((entry) => entry.id)).toEqual([
			"skill-5",
			"skill-1",
			"skill-4",
		]);

		const root = await listAllSkillsForOrg(db, "org-1", { folderPath: null });
		expect(root.entries.map((entry) => entry.id)).toEqual(["skill-2"]);
	});

	it("composes domain and tedi filters with recursive folder filtering", async () => {
		const combined = await listAllSkillsForOrg(db, "org-1", {
			domainId: "domain-ops",
			tediId: "tedi-1",
			folderPath: "operations",
			recursive: true,
		});
		expect(combined.total).toBe(2);
		expect(combined.entries.map((entry) => entry.id)).toEqual([
			"skill-5",
			"skill-1",
		]);

		const wrongFolder = await listAllSkillsForOrg(db, "org-1", {
			domainId: "domain-ops",
			tediId: "tedi-1",
			folderPath: "finance",
			recursive: true,
		});
		expect(wrongFolder.total).toBe(0);

		const overrides = await listAllSkillsForOrg(db, "org-1", {
			domainId: "domain-ops",
			tediId: "tedi-1",
			folderPath: "operations/overrides",
			recursive: true,
		});
		expect(overrides.total).toBe(1);
		expect(overrides.entries.map((entry) => entry.id)).toEqual(["skill-5"]);
	});
});
