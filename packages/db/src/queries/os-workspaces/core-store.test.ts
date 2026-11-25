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
	osWorkspaceSkillDraftGrants,
	osWorkspaceSkillDraftProposals,
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
	createOsWorkspaceResource,
	createOsWorkspaceSkillDraftProposal,
	getOsWorkspaceResource,
	getOsWorkspaceSkillDraftGrant,
	listOsWorkspaceResources,
	listOsWorkspaceSkillDraftProposals,
	rebindOsWorkspaceResource,
	removeOsWorkspaceResource,
	restoreOsWorkspaceResource,
	setOsWorkspaceSkillDraftGrant,
	updateOsWorkspaceResourceMetadata,
	withdrawOsWorkspaceSkillDraftProposal,
} from "./resources";
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
					osWorkspaceSkillDraftGrants,
					osWorkspaceSkillDraftProposals,
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

		it("keeps resource CAS and output visibility scoped to the organization", async () => {
			const resource = await createOsWorkspaceResource(db, {
				id: "linked-output",
				organizationId: "org",
				workspaceId: "public",
				providerId: "tedix",
				connectionScope: "tenant",
				resourceType: "output",
				providerResourceId: "linked-document",
				name: "Linked document",
				createdByKind: "user",
				createdById: "owner",
				createdAt: at,
				updatedAt: at,
			});
			const identity = {
				organizationId: "org",
				workspaceId: "public",
				resourceId: resource.id,
			};
			expect(
				await getOsWorkspaceResource(db, {
					...identity,
					organizationId: "other",
				}),
			).toBeUndefined();
			expect(
				(
					await listOsWorkspaceResources(db, {
						...identity,
						hideInactiveOutputs: true,
					})
				).map((row) => row.id),
			).not.toContain(resource.id);
			await db.insert(coreTable(db, workspaceOutputIndex)).values({
				id: "linked-document:1",
				organizationId: "org",
				workspaceId: "public",
				outputId: "linked-document",
				revision: 1,
				revisionId: "linked-r1",
				isCurrent: 1,
				outputKind: "document",
				title: "Linked document",
				status: "active",
				outputCreatedByKind: "user",
				outputCreatedById: "owner",
				outputCreatedAt: at,
				revisionCreatedByKind: "user",
				revisionCreatedById: "owner",
				revisionCreatedAt: at,
				updatedAt: at,
			});
			expect(
				(
					await listOsWorkspaceResources(db, {
						...identity,
						hideInactiveOutputs: true,
					})
				).map((row) => row.id),
			).toContain(resource.id);
			const now = "2026-11-20T12:01:00.000Z";
			const update = {
				...identity,
				expectedUpdatedAt: at,
				now,
				metadata: '{"title":"雪"}',
			};
			expect(
				await updateOsWorkspaceResourceMetadata(db, {
					...update,
					organizationId: "other",
				}),
			).toBeUndefined();
			expect(await updateOsWorkspaceResourceMetadata(db, update)).toMatchObject(
				{ metadata: update.metadata },
			);
			expect(
				await updateOsWorkspaceResourceMetadata(db, update),
			).toBeUndefined();
			const rebound = await rebindOsWorkspaceResource(db, {
				...identity,
				expectedUpdatedAt: now,
				now: "2026-11-20T12:02:00.000Z",
				connectionScope: "user",
				personalOwnerUserId: "owner",
				connectionInstanceId: "account",
				providerAccess: { canRead: true, canWrite: false },
			});
			expect(rebound?.providerAccess).toEqual({
				canRead: true,
				canWrite: false,
			});
			expect(
				await removeOsWorkspaceResource(db, {
					...identity,
					expectedUpdatedAt: rebound!.updatedAt,
					now: "2026-11-20T12:03:00.000Z",
				}),
			).toMatchObject({ status: "removed" });
			expect(
				await restoreOsWorkspaceResource(db, {
					...identity,
					now: "2026-11-20T12:04:00.000Z",
				}),
			).toMatchObject({ status: "active", removedAt: null });
		});

		it("preserves draft grant booleans, proposal replay and exact withdrawal identity", async () => {
			const scope = {
				organizationId: "org",
				workspaceId: "public",
				resourceId: "draft",
				memberId: "member",
			};
			const grant = {
				...scope,
				skillId: "skill",
				enabled: true,
				expiresAt: at,
				grantedBy: "owner",
				updatedAt: at,
			};
			expect(await setOsWorkspaceSkillDraftGrant(db, grant)).toMatchObject({
				enabled: true,
			});
			expect(
				await setOsWorkspaceSkillDraftGrant(db, { ...grant, enabled: false }),
			).toMatchObject({ enabled: false });
			expect(
				await getOsWorkspaceSkillDraftGrant(db, {
					...scope,
					organizationId: "other",
				}),
			).toBeUndefined();
			const proposal = {
				...scope,
				id: "draft-proposal",
				skillId: "skill",
				sourceRevision: 1,
				baseContent: "Old",
				baseFiles: { "server.js": "old" },
				content: "New",
				files: { "server.js": "雪" },
				reason: "Change",
				payloadDigest: "digest",
				createdAt: at,
			};
			expect(
				await createOsWorkspaceSkillDraftProposal(db, proposal),
			).toMatchObject({ files: proposal.files });
			expect(
				await createOsWorkspaceSkillDraftProposal(db, {
					...proposal,
					content: "Replay",
				}),
			).toMatchObject({ content: "New" });
			expect(
				await listOsWorkspaceSkillDraftProposals(db, {
					...scope,
					memberId: "another",
				}),
			).toEqual([]);
			const withdrawal = {
				...scope,
				proposalId: proposal.id,
				now: "2026-11-20T12:05:00.000Z",
			};
			expect(
				await withdrawOsWorkspaceSkillDraftProposal(db, {
					...withdrawal,
					memberId: "another",
				}),
			).toMatchObject({ status: "pending" });
			expect(
				await withdrawOsWorkspaceSkillDraftProposal(db, withdrawal),
			).toMatchObject({ status: "withdrawn", withdrawnAt: withdrawal.now });
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
