import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { coreTable } from "../../core-store/client";
import { createDbQueryClient, type DbQueryClient } from "../../query-client";
import {
	osWorkspaceAccessEdges,
	osWorkspaceCollaborators,
	osWorkspaceShareKeys,
	osWorkspaceShareLinks,
} from "../../schema/os-collaborators";
import {
	osGadgetCode,
	osGadgetCodeBlobs,
	osGadgetRevisions,
	osGadgets,
	osWorkspaceResources,
	osWorkspaces,
} from "../../schema/os-workspaces";
import { workspaceOutputIndex } from "../../schema/workspace-feed";
import { userConfigs } from "../../schema/user-configs";
import { createD1Facade } from "../../test/d1-facade";
import { createPGliteFacade } from "../../test/pglite-facade";
import { tableDdl } from "../../test/schema-ddl";
import {
	countArchivedOsWorkspacePurgeCandidates,
	listArchivedOsWorkspacePurgeCandidates,
} from "./archived-purge";
import { confirmOsWorkspaceFile } from "./files";
import {
	buildOsGadgetRevisionCodeStatements,
	osGadgetCodeSha256,
} from "./gadget-code";
import {
	choosePersonalOsWorkspace,
	createOsWorkspace,
	deleteOsWorkspace,
	getOsWorkspace,
	getPersonalOsWorkspace,
	listOsWorkspaces,
	updateOsWorkspace,
} from "./workspaces";

const at = "2026-11-20T12:00:00.000Z";
for (const store of ["d1", "postgres"] as const) {
	describe(`workspace core store: ${store}`, () => {
		let db: DbQueryClient;
		let close: () => void | Promise<void>;
		beforeAll(async () => {
			if (store === "d1") {
				const sqlite = new DatabaseSync(":memory:");
				sqlite.exec(
					"PRAGMA foreign_keys = ON; CREATE TABLE organizations(id TEXT PRIMARY KEY); CREATE TABLE projects(id TEXT PRIMARY KEY); INSERT INTO organizations VALUES ('org'),('other')",
				);
				for (const table of [
					osWorkspaces,
					osWorkspaceResources,
					workspaceOutputIndex,
					osWorkspaceAccessEdges,
					osWorkspaceCollaborators,
					osWorkspaceShareKeys,
					osWorkspaceShareLinks,
					userConfigs,
					osGadgets,
					osGadgetRevisions,
					osGadgetCode,
					osGadgetCodeBlobs,
				])
					for (const ddl of tableDdl(table)) sqlite.exec(ddl);
				db = createDbQueryClient(
					createD1Facade(sqlite, { maxBoundParams: 100 }),
				);
				close = () => sqlite.close();
			} else {
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
					"INSERT INTO organizations(id,name,slug) VALUES ('org','Org','org'),('other','Other','other')",
				);
			}
		}, 30000);
		afterAll(async () => {
			await close?.();
		});

		it("keeps private workspaces private with large viewer sets and native booleans", async () => {
			const base = {
				organizationId: "org",
				createdByKind: "user" as const,
				createdById: "owner",
			};
			await createOsWorkspace(db, {
				...base,
				id: "public",
				name: "ÉCOLE 100%_quoted",
				createdAt: at,
			});
			await createOsWorkspace(db, {
				...base,
				id: "private",
				name: "Private",
				visibility: "private",
				ownerUserId: "owner",
				machineAccess: true,
			});
			expect(
				(await listOsWorkspaces(db, "org", { userIds: [] })).map(
					(row) => row.id,
				),
			).toEqual(["public"]);
			const ids = Array.from({ length: 300 }, (_, index) => `absent-${index}`);
			expect(
				(await listOsWorkspaces(db, "org", { userIds: [...ids, "owner"] }))
					.map((row) => row.id)
					.sort(),
			).toEqual(["private", "public"]);
			expect(
				(
					await listOsWorkspaces(db, "org", {
						userIds: [],
						workspaceIds: [...ids, "private"],
					})
				)
					.map((row) => row.id)
					.sort(),
			).toEqual(["private", "public"]);
			expect(
				(
					await getOsWorkspace(db, {
						organizationId: "org",
						workspaceId: "private",
					})
				)?.machineAccess,
			).toBe(true);
			expect(
				await getOsWorkspace(db, {
					organizationId: "other",
					workspaceId: "private",
				}),
			).toBeUndefined();
			expect(
				(
					await listOsWorkspaces(
						db,
						"org",
						{ userIds: [] },
						{ search: "École 100%_" },
					)
				).map((row) => row.id),
			).toEqual(["public"]);
			expect(
				await listOsWorkspaces(db, "org", { userIds: [] }, { search: "école" }),
			).toEqual([]);
			expect(
				await updateOsWorkspace(
					db,
					{ organizationId: "other", workspaceId: "private" },
					{ machineAccess: false },
				),
			).toBeUndefined();
			expect(
				(
					await choosePersonalOsWorkspace(db, {
						organizationId: "org",
						ownerUserId: "owner",
						workspaceId: "private",
					})
				)?.id,
			).toBe("private");
			expect(
				(
					await getPersonalOsWorkspace(db, {
						organizationId: "org",
						ownerUserId: "owner",
					})
				)?.id,
			).toBe("private");
			await expect(
				deleteOsWorkspace(db, {
					organizationId: "org",
					workspaceId: "private",
					expectedOwnerUserId: "someone",
				}),
			).rejects.toThrow();
			expect(
				await deleteOsWorkspace(db, {
					organizationId: "org",
					workspaceId: "private",
					expectedOwnerUserId: "owner",
				}),
			).toBe(true);
			expect(
				await getPersonalOsWorkspace(db, {
					organizationId: "org",
					ownerUserId: "owner",
				}),
			).toBeUndefined();
		});

		it("stores resource metadata without writing workspace-owned documents", async () => {
			await confirmOsWorkspaceFile(db, {
				resource: {
					id: "resource",
					organizationId: "org",
					workspaceId: "public",
					providerId: "tedix",
					connectionScope: "tenant",
					resourceType: "file",
					providerResourceId: "document",
					slot: "document",
					name: "Document",
					createdByKind: "user",
					createdById: "owner",
					metadata: JSON.stringify({ title: "Quote' and 雪", pinned: true }),
				},
			});
			const [row] = await db.select().from(coreTable(db, osWorkspaceResources));
			expect(JSON.parse(row!.metadata!)).toEqual({
				title: "Quote' and 雪",
				pinned: true,
			});
			await expect(
				confirmOsWorkspaceFile(db, {
					output: {
						id: "forbidden",
						organizationId: "org",
						kind: "document",
						title: "Forbidden",
						createdByKind: "user",
						createdById: "owner",
					},
				}),
			).rejects.toThrow("workspace object service");
		});

		it("uses the same exclusive archive cutoff for pages and counts", async () => {
			await createOsWorkspace(db, {
				id: "archived",
				organizationId: "org",
				name: "Archive",
				status: "archived",
				updatedAt: at,
				createdByKind: "user",
				createdById: "owner",
			});
			const scope = { organizationId: "org", archivedBefore: at };
			expect(await countArchivedOsWorkspacePurgeCandidates(db, scope)).toBe(0);
			const later = { ...scope, archivedBefore: "2026-11-20T12:00:01.000Z" };
			expect(await countArchivedOsWorkspacePurgeCandidates(db, later)).toBe(1);
			expect(
				(
					await listArchivedOsWorkspacePurgeCandidates(db, {
						...later,
						limit: 10,
					})
				).map((row) => row.id),
			).toEqual(["archived"]);
		});

		it("guards code writes on their revision and rolls back blobs on a later pointer failure", async () => {
			await db.insert(coreTable(db, osGadgets)).values({
				id: "gadget",
				organizationId: "org",
				workspaceId: "public",
				name: "App",
				createdByKind: "user",
				createdById: "owner",
			});
			await db.insert(coreTable(db, osGadgetRevisions)).values({
				id: "revision",
				organizationId: "org",
				gadgetId: "gadget",
				revision: 1,
				manifest: "{}",
				createdByKind: "user",
				createdById: "owner",
			});
			const files = '{"server.js":"export default 1"}';
			const sha256 = await osGadgetCodeSha256(files);
			const params = {
				files,
				sha256,
				codeLength: files.length,
				createdAt: at,
				revisionId: "revision",
			};
			await db.batch(
				buildOsGadgetRevisionCodeStatements(db, {
					...params,
					revisionId: "missing",
				}),
			);
			expect(await db.select().from(coreTable(db, osGadgetCodeBlobs))).toEqual(
				[],
			);
			await db.batch(buildOsGadgetRevisionCodeStatements(db, params));
			const [code] = await db.select().from(coreTable(db, osGadgetCode));
			expect(code).toMatchObject({
				revisionId: "revision",
				files: "",
				filesSha256: sha256,
			});
			const otherFiles = '{"server.js":"export default 2"}';
			const otherSha = await osGadgetCodeSha256(otherFiles);
			await expect(
				db.batch(
					buildOsGadgetRevisionCodeStatements(db, {
						...params,
						files: otherFiles,
						sha256: otherSha,
					}),
				),
			).rejects.toThrow();
			const blobs = coreTable(db, osGadgetCodeBlobs);
			expect(
				await db.select().from(blobs).where(eq(blobs.sha256, otherSha)),
			).toEqual([]);
		});
	});
}
