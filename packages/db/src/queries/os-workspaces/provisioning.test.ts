import { DatabaseSync } from "node:sqlite";
import { eq, sql } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { coreTable } from "../../core-store/client";
import { createDbQueryClient, type DbQueryClient } from "../../query-client";
import { projects } from "../../schema/projects";
import {
	osWorkspaceProjects,
	osWorkspaceResources,
	osWorkspaces,
} from "../../schema/os-workspaces";
import {
	projects as pgProjects,
	osWorkspaceProjects as pgWorkspaceProjects,
	osWorkspaceResources as pgResources,
	osWorkspaces as pgWorkspaces,
} from "../../schema-pg/core";
import { createD1Facade } from "../../test/d1-facade";
import { createPGliteFacade } from "../../test/pglite-facade";
import { pgTableDdl } from "../../test/pg-schema-ddl";
import { schemaDdl } from "../../test/schema-ddl";
import { batchNonEmpty } from "../../utils/batch";
import {
	buildBlueprintProvisioningStatements,
	getBlueprintApplyReceipt,
	type BlueprintProvisioningRows,
} from "./provisioning";

const at = "2026-11-20T12:00:00.000Z";
const closers: Array<() => void | Promise<void>> = [];
afterEach(async () => {
	for (const close of closers.splice(0)) await close();
});
async function fixture(store: "d1" | "postgres"): Promise<DbQueryClient> {
	const parents =
		"CREATE TABLE organizations(id TEXT PRIMARY KEY); CREATE TABLE tedis(id TEXT PRIMARY KEY); CREATE TABLE tedi_objectives(id TEXT PRIMARY KEY); INSERT INTO organizations VALUES ('org'),('other')";
	let db: DbQueryClient;
	if (store === "postgres") {
		const fixture = await createPGliteFacade();
		closers.push(fixture.close);
		db = fixture.db;
		await fixture.engine.exec(parents);
		for (const table of [
			pgProjects,
			pgWorkspaces,
			pgWorkspaceProjects,
			pgResources,
		])
			for (const ddl of pgTableDdl(table)) await fixture.engine.exec(ddl);
	} else {
		const sqlite = new DatabaseSync(":memory:");
		closers.push(() => sqlite.close());
		sqlite.exec(`PRAGMA foreign_keys=ON; ${parents}`);
		sqlite.exec(
			schemaDdl(
				projects,
				osWorkspaces,
				osWorkspaceProjects,
				osWorkspaceResources,
			),
		);
		db = createDbQueryClient(createD1Facade(sqlite, { maxBoundParams: 100 }));
	}
	await db.insert(coreTable(db, osWorkspaces)).values({
		id: "workspace",
		organizationId: "org",
		name: "Workspace",
		createdByKind: "user",
		createdById: "owner",
	});
	return db;
}
function provisioningRows(count: number): BlueprintProvisioningRows {
	return {
		projects: Array.from({ length: count }, (_, index) => ({
			id: `project-${index}`,
			orgId: "org",
			key: `P${index}`,
			name: `Project ${index}`,
			createdAt: at,
		})),
		projectLinks: Array.from({ length: count }, (_, index) => ({
			id: `link-${index}`,
			organizationId: "org",
			workspaceId: "workspace",
			projectId: `project-${index}`,
			createdByKind: "user",
			createdById: "owner",
			createdAt: at,
			updatedAt: at,
		})),
		epics: [],
		items: [],
		relations: [],
		epicItems: [],
		outputs: [],
		outputRevisions: [],
		schedules: [],
	};
}

for (const store of ["d1", "postgres"] as const) {
	describe(`blueprint provisioning: ${store}`, () => {
		it("writes large related sets within D1 limits and reads receipts only in scope", async () => {
			const db = await fixture(store);
			const statements = buildBlueprintProvisioningStatements(
				db,
				provisioningRows(140),
			);
			if (store === "postgres") expect(statements).toHaveLength(2);
			await db.batch(batchNonEmpty(statements));
			expect(
				(
					await db
						.select({ count: sql<number>`count(*)`.mapWith(Number) })
						.from(coreTable(db, projects))
				)[0]?.count,
			).toBe(140);
			expect(
				(
					await db
						.select({ count: sql<number>`count(*)`.mapWith(Number) })
						.from(coreTable(db, osWorkspaceProjects))
				)[0]?.count,
			).toBe(140);
			await db.insert(coreTable(db, osWorkspaceResources)).values({
				id: "receipt",
				organizationId: "org",
				workspaceId: "workspace",
				providerId: "tedix",
				connectionScope: "tenant",
				resourceType: "receipt",
				providerResourceId: "receipt",
				slot: "blueprint-apply-receipt",
				name: "Receipt",
				metadata: '{"applied":true}',
				createdByKind: "user",
				createdById: "owner",
			});
			expect(await getBlueprintApplyReceipt(db, "org", "workspace")).toBe(
				'{"applied":true}',
			);
			expect(
				await getBlueprintApplyReceipt(db, "other", "workspace"),
			).toBeUndefined();
		});
		it("rolls back projects and links when a later statement fails", async () => {
			const db = await fixture(store);
			const rows = provisioningRows(1);
			await expect(
				db.batch(
					batchNonEmpty([
						...buildBlueprintProvisioningStatements(db, rows),
						db
							.insert(coreTable(db, projects))
							.values({ ...rows.projects[0]!, key: "Duplicate" }),
					]),
				),
			).rejects.toThrow();
			const table = coreTable(db, projects);
			expect(
				await db.select().from(table).where(eq(table.id, "project-0")),
			).toEqual([]);
			expect(
				await db.select().from(coreTable(db, osWorkspaceProjects)),
			).toEqual([]);
		});
	});
}
