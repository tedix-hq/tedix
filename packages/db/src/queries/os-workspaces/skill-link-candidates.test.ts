import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { coreTable } from "../../core-store/client";
import { createDbQueryClient, type DbQueryClient } from "../../query-client";
import { skillEntries } from "../../schema/cognitive";
import { osWorkspaceProjects, osWorkspaces } from "../../schema/os-workspaces";
import { workspaceOutputIndex } from "../../schema/workspace-feed";
import { projects } from "../../schema/projects";
import { createD1Facade } from "../../test/d1-facade";
import { createPGliteFacade } from "../../test/pglite-facade";
import { schemaDdl } from "../../test/schema-ddl";
import { listOsWorkspaceSkillLinkCandidates } from "./resources";

const at = "2026-10-01T00:00:00.000Z";
async function fixture(store: "d1" | "postgres") {
	let db: DbQueryClient;
	let close: () => void | Promise<void>;
	if (store === "postgres") {
		const fixture = await createPGliteFacade();
		db = fixture.db;
		close = fixture.close;
		for (const migration of readMigrationFiles({
			migrationsFolder: fileURLToPath(
				new URL("../../../drizzle-pg", import.meta.url),
			),
		}))
			for (const ddl of migration.sql) await fixture.engine.exec(ddl);
		await fixture.engine.exec(
			"INSERT INTO organizations(id,name,slug) VALUES ('org-1','Org','org'),('org-2','Other','other')",
		);
	} else {
		const sqlite = new DatabaseSync(":memory:");
		sqlite.exec("PRAGMA foreign_keys = OFF");
		sqlite.exec(
			schemaDdl(
				projects,
				skillEntries,
				osWorkspaces,
				osWorkspaceProjects,
				workspaceOutputIndex,
			),
		);
		db = createDbQueryClient(createD1Facade(sqlite, { maxBoundParams: 100 }));
		close = () => sqlite.close();
	}
	for (const [id, organizationId] of [
		["ws-1", "org-1"],
		["ws-2", "org-1"],
		["ws-other", "org-2"],
	] as const)
		await db.insert(coreTable(db, osWorkspaces)).values({
			id,
			organizationId,
			name: id,
			createdByKind: "user",
			createdById: "u-1",
		});
	for (const [id, organizationId, title] of [
		["skill-lane", "org-1", "Daily research"],
		["skill-linked-project", "org-1", "Weekly digest"],
		["skill-writer", "org-1", "Card writer"],
		["skill-other-org", "org-2", "Other org lane"],
		["skill-unrelated", "org-1", "Unrelated"],
	] as const)
		await db.insert(coreTable(db, skillEntries)).values({
			id,
			organizationId,
			title,
			content: "# s",
		});
	for (const [id, orgId, key, name, skillId, workspaceId] of [
		["p-bound", "org-1", "RES", "Research", "skill-lane", "ws-1"],
		["p-linked", "org-1", "DIG", "Digest", "skill-linked-project", undefined],
		["p-elsewhere", "org-1", "ELS", "Elsewhere", "skill-unrelated", "ws-2"],
		["p-other-org", "org-2", "OTH", "Other", "skill-other-org", "ws-1"],
	] as const)
		await db.insert(coreTable(db, projects)).values({
			id,
			orgId,
			key,
			name,
			createdAt: at,
			updatedAt: at,
			metadata: {
				factory: {
					slug: key,
					skillId,
					...(workspaceId ? { workspaceId } : {}),
				},
			},
		});
	await db.insert(coreTable(db, osWorkspaceProjects)).values({
		id: "link-1",
		organizationId: "org-1",
		workspaceId: "ws-1",
		projectId: "p-linked",
		createdByKind: "user",
		createdById: "u-1",
		createdAt: at,
		updatedAt: at,
	});
	for (const [id, skillId, organizationId, workspaceId, isCurrent] of [
		["rev-1", "skill-writer", "org-1", "ws-1", 0],
		["rev-2", "skill-writer", "org-1", "ws-1", 0],
		["rev-3", "skill-lane", "org-1", "ws-1", 0],
		["rev-4", null, "org-1", "ws-1", 1],
		["foreign-output", "skill-other-org", "org-2", "ws-other", 0],
		["foreign-skill", "skill-other-org", "org-1", "ws-1", 0],
		["other-workspace", "skill-unrelated", "org-1", "ws-2", 0],
	] as const)
		await db.insert(coreTable(db, workspaceOutputIndex)).values({
			id,
			organizationId,
			workspaceId,
			outputId: id,
			revision: 1,
			revisionId: `${id}-r1`,
			isCurrent,
			outputKind: "sheet",
			title: "Cards",
			status: "active",
			outputCreatedByKind: "user",
			outputCreatedById: "u-1",
			outputCreatedAt: at,
			revisionCreatedByKind: "tedi",
			revisionCreatedById: "t-1",
			revisionCreatedAt: at,
			updatedAt: at,
			skillId,
		});
	return { db, close };
}

for (const store of ["d1", "postgres"] as const) {
	describe(`listOsWorkspaceSkillLinkCandidates: ${store}`, () => {
		let db: DbQueryClient;
		let close: () => void | Promise<void>;
		beforeAll(async () => {
			({ db, close } = await fixture(store));
		}, 30000);
		afterAll(async () => {
			await close?.();
		});
		it("finds factory skills and historical indexed writers without cross-tenant skills", async () => {
			expect(
				await listOsWorkspaceSkillLinkCandidates(db, {
					organizationId: "org-1",
					workspaceId: "ws-1",
				}),
			).toEqual([
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
			expect(
				await listOsWorkspaceSkillLinkCandidates(db, {
					organizationId: "org-2",
					workspaceId: "ws-9",
				}),
			).toEqual([]);
		});
	});
}
