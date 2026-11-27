import { fileURLToPath } from "node:url";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { OS_WORKSPACE_INSPECTION_MS } from "@tedix/api-contract/schemas/os-workspace-inspections";
import { createDbClient, type DbClient } from "../client";
import { coreTable } from "../core-store/client";
import { organizationMembers } from "../schema/organization-members";
import { organizations } from "../schema/organizations";
import { osWorkspaces } from "../schema/os-workspaces";
import { createD1Facade } from "../test/d1-facade";
import { createMigratedSqlite } from "../test/migrated-sqlite";
import { createPGliteFacade } from "../test/pglite-facade";
import {
	hasActiveOsWorkspaceInspection,
	isOrganizationInspector,
	listOsWorkspaceInspections,
	listOsWorkspacesForInspection,
	recordOsWorkspaceInspection,
} from "./os-workspace-inspections";

const ORG = "org-inspections";
const ADMIN = "user-admin";
const MEMBER = "user-member";
const AGENT = "user-agent";
const WORKSPACE = "ws-private";
const scope = { organizationId: ORG, workspaceId: WORKSPACE };

for (const store of ["d1", "postgres"] as const) {
	describe(`lane 11b os workspace inspections core store: ${store}`, () => {
		let db: DbClient;
		let close: () => void | Promise<void>;
		beforeAll(async () => {
			if (store === "d1") {
				const sqlite = createMigratedSqlite();
				db = createDbClient(createD1Facade(sqlite));
				close = () => sqlite.close();
			} else {
				const fixture = await createPGliteFacade();
				db = fixture.db;
				close = fixture.close;
				for (const migration of readMigrationFiles({
					migrationsFolder: fileURLToPath(
						new URL("../../drizzle-pg", import.meta.url),
					),
				})) {
					for (const ddl of migration.sql) await fixture.engine.exec(ddl);
				}
			}
			await db.insert(coreTable(db, organizations)).values({
				id: ORG,
				name: "Inspections",
				slug: "inspections",
			});
			const members = coreTable(db, organizationMembers);
			await db.insert(members).values([
				{
					id: "mem-admin",
					organizationId: ORG,
					descopeUserId: ADMIN,
					email: "admin@example.com",
					name: "Ada Admin",
					role: "admin",
				},
				{
					id: "mem-member",
					organizationId: ORG,
					descopeUserId: MEMBER,
					email: "member@example.com",
					role: "member",
				},
				{
					id: "mem-agent",
					organizationId: ORG,
					descopeUserId: AGENT,
					email: "agent@example.com",
					kind: "external_agent",
					role: "admin",
				},
			]);
			const workspaces = coreTable(db, osWorkspaces);
			await db.insert(workspaces).values([
				{
					id: WORKSPACE,
					organizationId: ORG,
					name: "Private Ops",
					visibility: "private",
					ownerUserId: MEMBER,
					createdByKind: "user",
					createdById: MEMBER,
				},
				{
					id: "ws-public",
					organizationId: ORG,
					name: "Public Docs",
					createdByKind: "user",
					createdById: ADMIN,
				},
				{
					id: "ws-archived",
					organizationId: ORG,
					name: "Archived",
					status: "archived",
					createdByKind: "user",
					createdById: ADMIN,
				},
			]);
		}, 30_000);
		afterAll(async () => {
			await close?.();
		});

		it("recognizes only active human owners and admins as inspectors", async () => {
			expect(await isOrganizationInspector(db, ORG, ADMIN)).toBe(true);
			expect(await isOrganizationInspector(db, ORG, MEMBER)).toBe(false);
			expect(await isOrganizationInspector(db, ORG, AGENT)).toBe(false);
			expect(await isOrganizationInspector(db, ORG, "user-missing")).toBe(
				false,
			);
		});

		it("grants inspection reads only inside the recorded hour", async () => {
			const now = Date.now();
			expect(await hasActiveOsWorkspaceInspection(db, scope, ADMIN, now)).toBe(
				false,
			);
			await recordOsWorkspaceInspection(db, {
				organizationId: ORG,
				workspaceId: WORKSPACE,
				userId: ADMIN,
				metadata: { reason: "support" },
			});
			expect(await hasActiveOsWorkspaceInspection(db, scope, ADMIN, now)).toBe(
				true,
			);
			expect(await hasActiveOsWorkspaceInspection(db, scope, MEMBER, now)).toBe(
				false,
			);
			expect(
				await hasActiveOsWorkspaceInspection(
					db,
					scope,
					ADMIN,
					now + OS_WORKSPACE_INSPECTION_MS + 60_000,
				),
			).toBe(false);
		});

		it("lists active workspaces including private ones with owner names", async () => {
			const rows = await listOsWorkspacesForInspection(db, ORG);
			expect(rows.map((row) => row.id).sort()).toEqual([
				"ws-private",
				"ws-public",
			]);
			expect(rows.find((row) => row.id === WORKSPACE)).toMatchObject({
				visibility: "private",
				ownerName: "member@example.com",
			});
		});

		it("lists recorded inspections newest first with inspector names", async () => {
			const inspections = await listOsWorkspaceInspections(db, scope);
			expect(inspections).toHaveLength(1);
			expect(inspections[0]).toMatchObject({
				inspectorName: "Ada Admin",
			});
		});
	});
}
