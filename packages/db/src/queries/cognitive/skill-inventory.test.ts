import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vite-plus/test";
import { createDbClient } from "../../client";
import { createD1Facade } from "../../test/d1-facade";
import { createMigratedSqlite } from "../../test/migrated-sqlite";
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
				source_revision INTEGER, improvement_adoption TEXT, visibility TEXT NOT NULL DEFAULT 'private',
				agent_skills_format TEXT, r2_path TEXT, app_id TEXT, tool_ids TEXT, mcp_app_bindings TEXT,
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

	it("excludes only improvement copies before counts, search and pagination", async () => {
		sqlite.exec(`UPDATE skill_entries SET source_skill_id = 'skill-1', tags = '["workflow-improvement"]', lifecycle_state = 'archived' WHERE id = 'skill-5';
		 UPDATE skill_entries SET source_skill_id = 'skill-1', tags = '["workflow-improvement"]' WHERE id = 'skill-4';
		 UPDATE skill_entries SET tags = '["workflow-improvement"]' WHERE id = 'skill-2';`);
		const page = await listAllSkillsForOrg(db, "org-1", {
			excludeImprovements: true,
			limit: 1,
			offset: 1,
		});
		expect(page.total).toBe(2);
		expect(page.entries.map((entry) => entry.id)).toEqual(["skill-2"]);
		expect(
			(
				await listAllSkillsForOrg(db, "org-1", {
					excludeImprovements: true,
					lifecycleState: "archived",
				})
			).total,
		).toBe(0);
		expect(
			(
				await listAllSkillsForOrg(db, "org-1", {
					excludeImprovements: true,
					query: "override",
				})
			).total,
		).toBe(0);
		const history = await listAllSkillsForOrg(db, "org-1", {
			improvementsOf: "skill-1",
		});
		expect(history.entries.map((entry) => entry.id).sort()).toEqual([
			"skill-4",
			"skill-5",
		]);
		expect(
			(await listAllSkillsForOrg(db, "org-2", { improvementsOf: "skill-1" }))
				.total,
		).toBe(0);
	});

	it("excludes archived skills before pagination and counts, preserving other states", async () => {
		sqlite.exec(`UPDATE skill_entries SET lifecycle_state = 'archived' WHERE id IN ('skill-5', 'skill-3');
			UPDATE skill_entries SET lifecycle_state = NULL WHERE id = 'skill-2';
			UPDATE skill_entries SET lifecycle_state = 'draft' WHERE id = 'skill-4';`);
		const first = await listAllSkillsForOrg(db, "org-1", {
			excludeArchived: true,
			limit: 2,
		});
		expect(first.total).toBe(3);
		expect(first.entries.map((entry) => entry.id)).toEqual([
			"skill-1",
			"skill-2",
		]);
		const second = await listAllSkillsForOrg(db, "org-1", {
			excludeArchived: true,
			limit: 2,
			offset: 2,
		});
		expect(second.total).toBe(3);
		expect(second.entries.map((entry) => entry.id)).toEqual(["skill-4"]);
		expect(
			(await listAllSkillsForOrg(db, "org-1", { excludeArchived: false }))
				.total,
		).toBe(4);
		const archived = await listAllSkillsForOrg(db, "org-1", {
			lifecycleState: "archived",
			limit: 0,
		});
		expect(archived).toEqual({ entries: [], total: 1 });
		expect(
			(
				await listAllSkillsForOrg(db, "org-1", {
					excludeArchived: true,
					query: "Tedi override",
				})
			).total,
		).toBe(0);
		const searched = await listAllSkillsForOrg(db, "org-1", {
			query: "Override",
		});
		expect(searched.entries.map((entry) => entry.id)).toEqual([
			"skill-5",
			"skill-4",
		]);
		expect(searched.total).toBe(2);
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

describe("skill inventory plan", () => {
	const inventoryIndexes = [
		"idx_skill_entries_org_updated",
		"idx_skill_entries_org_tedi_supersedes",
	];

	function seededSqlite(): DatabaseSync {
		const sqlite = createMigratedSqlite({ foreignKeys: false });
		const insert = sqlite.prepare(`
			INSERT INTO skill_entries (
				id, organization_id, tedi_id, title, slug, content, visibility,
				lifecycle_state, supersedes_id, success_count, updated_at
			) VALUES (?, ?, ?, ?, ?, '# Skill', ?, ?, ?, ?, ?)`);
		const lifecycles = ["active", "proven", "draft", "archived", "stale"];
		for (let index = 0; index < 160; index += 1) {
			const tediId = index % 4 === 0 ? null : `tedi-${index % 3}`;
			// tedi-1 overrides some org baselines, in every lifecycle state.
			const supersedesId =
				tediId === "tedi-1" && index % 5 === 1 ? `skill-${index - 1}` : null;
			insert.run(
				`skill-${index}`,
				index % 7 === 6 ? "org-2" : "org-1",
				tediId,
				`Skill ${index}`,
				`skill-${index}`,
				index % 6 === 0 ? "private" : "org",
				lifecycles[index % lifecycles.length]!,
				supersedesId,
				index % 3,
				// Shared timestamps make success_count the deciding tie-breaker.
				`2026-10-${String(1 + (index % 20)).padStart(2, "0")}T00:00:00.000Z`,
			);
		}
		return sqlite;
	}

	const cases: Parameters<typeof listAllSkillsForOrg>[2][] = [
		undefined,
		{ tediId: "tedi-1" },
		{ tediId: "tedi-1", limit: 7, offset: 5 },
		{ tediId: "tedi-1", lifecycleState: "active" },
		{ tediId: "tedi-2", visibility: "org" },
		{ lifecycleState: "proven", limit: 3, offset: 2 },
	];

	it("returns the same pages and totals with and without the inventory indexes", async () => {
		// One seeded database: two seedings can straddle a second and differ in created_at.
		const sqlite = seededSqlite();
		const list = (options: (typeof cases)[number]) =>
			listAllSkillsForOrg(
				createDbClient(createD1Facade(sqlite)),
				"org-1",
				options,
			);
		const indexed = [];
		for (const options of cases) indexed.push(await list(options));
		for (const name of inventoryIndexes) sqlite.exec(`DROP INDEX ${name}`);
		for (const [index, options] of cases.entries()) {
			const expected = await list(options);
			expect(expected.total).toBeGreaterThan(0);
			expect(indexed[index]).toEqual(expected);
		}
	});

	it.each([false, true])(
		"reads the tedi inventory through indexes without a sort (analyzed: %s)",
		async (analyzed) => {
			const sqlite = seededSqlite();
			if (analyzed) sqlite.exec("ANALYZE");
			const statements: { sql: string; params: unknown[] }[] = [];
			const recording = {
				exec: (sql: string) => sqlite.exec(sql),
				prepare(sql: string) {
					const statement = sqlite.prepare(sql);
					const record =
						(method: "all" | "get" | "run") =>
						(...params: unknown[]) => {
							statements.push({ sql, params });
							return (statement[method] as (...args: unknown[]) => never)(
								...params,
							);
						};
					return { all: record("all"), get: record("get"), run: record("run") };
				},
			};
			await listAllSkillsForOrg(
				createDbClient(createD1Facade(recording)),
				"org-1",
				{ tediId: "tedi-1", limit: 200 },
			);
			expect(statements).toHaveLength(2);
			for (const { sql, params } of statements) {
				const plan = sqlite
					.prepare(`EXPLAIN QUERY PLAN ${sql}`)
					.all(...(params as SQLInputValue[]))
					.map((row) => String(row.detail));
				// Before these indexes the page sorted the tenant in a temp B-tree and
				// the override probe walked the tenant once per candidate row.
				expect(plan.join("\n")).not.toMatch(/SCAN skill_entries|TEMP B-TREE/);
				if (sql.startsWith("select count(*)")) {
					// With statistics the count may union two index seeks instead.
					expect(
						plan.some((line) => line.startsWith("SEARCH skill_entries USING")),
					).toBe(true);
				} else {
					expect(plan).toContain(
						"SEARCH skill_entries USING INDEX idx_skill_entries_org_updated (organization_id=?)",
					);
				}
				expect(plan).toContain(
					"SEARCH tedi_skill_override USING COVERING INDEX idx_skill_entries_org_tedi_supersedes (organization_id=? AND tedi_id=? AND supersedes_id=?)",
				);
			}
		},
	);
});
