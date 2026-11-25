import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { afterAll, beforeAll, describe, expect, it, vi } from "vite-plus/test";
import { coreTable } from "../core-store/client";
import { createDbQueryClient, type DbQueryClient } from "../query-client";
import { osApprovalRules } from "../schema/os-approval-rules";
import {
	osWorkspaceAccessEdges,
	osWorkspaceCollaborators,
	osWorkspaceEvents,
	osWorkspaceShareKeys,
	osWorkspaceShareLinks,
} from "../schema/os-collaborators";
import { osWorkspaces } from "../schema/os-workspaces";
import { organizationMembers } from "../schema/organization-members";
import {
	osShareEmailCodes,
	osShareLinkInvitees,
	osShareLinks,
	osShareSessions,
	osShareSkillReadGrants,
} from "../schema/os-shares";
import { createD1Facade } from "../test/d1-facade";
import { createPGliteFacade } from "../test/pglite-facade";
import { tableDdl } from "../test/schema-ddl";
import {
	createOsApprovalRule,
	deleteOsApprovalRule,
	findEnabledOsApprovalRuleByScope,
	findEnabledOsApprovalRulesByKind,
	setOsApprovalRuleEnabled,
} from "./os-approval-rules";
import {
	addOsShareLinkInvitee,
	consumeOsShareEmailCode,
	createOsShareLink,
	createOsShareSession,
	deleteOsShareLink,
	getLiveOsShareSession,
	isOsShareLinkInvitee,
	listOsShareResourceIdsWithActiveLinks,
	listOsShareSessionPeople,
	removeOsShareLinkInvitee,
	reserveOsShareEmailCode,
	restrictOsShareLink,
	revokeOsShareLink,
	setOsShareSkillReadGrants,
	updateOsShareLinkSettings,
} from "./os-shares";
import {
	createOrReuseOsWorkspaceDefaultShareLink,
	getActiveOsWorkspaceShareLinkByKeyHash,
	grantOsWorkspaceAccess,
	listTedixPeople,
	listOsWorkspaceOrganizationMemberRoles,
	loadOsWorkspacePermissionRows,
	revokeOsWorkspaceShareLink,
	severOsWorkspaceUserAccess,
} from "./os-collaborators";
import { getLatestOsWorkspaceEventCursor } from "./os-workspace-events";

const at = "2026-11-20T12:00:00.000Z";
const expiresAt = "2026-11-21T12:00:00.000Z";

for (const store of ["d1", "postgres"] as const) {
	describe(`share and approval core store: ${store}`, () => {
		let db: DbQueryClient;
		let close: () => void | Promise<void>;
		beforeAll(async () => {
			if (store === "d1") {
				const sqlite = new DatabaseSync(":memory:");
				sqlite.exec(
					"PRAGMA foreign_keys = ON; CREATE TABLE organizations(id TEXT PRIMARY KEY); INSERT INTO organizations VALUES ('org'), ('other')",
				);
				for (const table of [
					osApprovalRules,
					osShareLinks,
					osShareLinkInvitees,
					osShareSessions,
					osShareEmailCodes,
					osShareSkillReadGrants,
					osWorkspaceCollaborators,
					osWorkspaceAccessEdges,
					osWorkspaceShareKeys,
					osWorkspaceShareLinks,
					osWorkspaceEvents,
					osWorkspaces,
					organizationMembers,
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
						new URL("../../drizzle-pg", import.meta.url),
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

		async function share(id: string, role: "viewer" | "build" = "build") {
			return createOsShareLink(db, {
				id,
				organizationId: "org",
				resourceId: id,
				resourceType: "output",
				tokenHash: `token-${id}`,
				createdByKind: "user",
				createdById: "owner",
				createdAt: at,
				role,
			});
		}
		async function session(
			linkId: string,
			id: string,
			role: "viewer" | "build" = "build",
		) {
			return createOsShareSession(db, {
				id,
				linkId,
				sessionTokenHash: `session-${id}`,
				verifiedEmail: "person@example.test",
				createdAt: at,
				lastSeenAt: at,
				expiresAt,
				now: at,
				expectedEffectiveRole: role,
			});
		}

		it("keeps native boolean rules scoped and orders one large set globally", async () => {
			for (const [id, organizationId, actionKind, createdAt] of [
				["old-rule", "org", "kind-1", at],
				["new-rule", "org", "kind-299", expiresAt],
				["foreign-rule", "other", "kind-299", expiresAt],
			] as const)
				await createOsApprovalRule(db, {
					id,
					organizationId,
					actionKind,
					createdAt,
					createdByKind: "user",
					createdById: "owner",
					toolSlug: "notes.update",
					verb: "update",
				});
			const rows = await findEnabledOsApprovalRulesByKind(
				db,
				"org",
				Array.from({ length: 300 }, (_, i) => `kind-${i}`),
			);
			expect(rows.map((row) => row.id)).toEqual(["new-rule", "old-rule"]);
			expect(rows[0]?.enabled).toBe(true);
			expect(
				await findEnabledOsApprovalRuleByScope(db, "org", {
					actionKind: "kind-299",
				}),
			).toBeUndefined();
			expect(
				(
					await findEnabledOsApprovalRuleByScope(db, "org", {
						actionKind: "kind-299",
						toolSlug: "notes.update",
						verb: "update",
					})
				)?.id,
			).toBe("new-rule");
			expect(
				(
					await setOsApprovalRuleEnabled(
						db,
						{ organizationId: "org", ruleId: "new-rule" },
						false,
					)
				)?.enabled,
			).toBe(false);
			expect(
				await deleteOsApprovalRule(db, {
					organizationId: "other",
					ruleId: "new-rule",
				}),
			).toBe(false);
			expect(
				await deleteOsApprovalRule(db, {
					organizationId: "org",
					ruleId: "new-rule",
				}),
			).toBe(true);
			expect(
				await deleteOsApprovalRule(db, {
					organizationId: "org",
					ruleId: "new-rule",
				}),
			).toBe(false);
		});

		it("tightens and revokes sessions in one batch without allowing stale redemption", async () => {
			await share("tighten");
			expect((await session("tighten", "before"))?.id).toBe("before");
			const batch = vi.spyOn(db, "batch");
			const result = await restrictOsShareLink(db, {
				organizationId: "org",
				shareLinkId: "tighten",
				maxRole: "viewer",
				reason: "Owner policy",
				now: at,
			});
			expect(batch).toHaveBeenCalledTimes(1);
			batch.mockRestore();
			expect(result?.revokedSessionCount).toBe(1);
			expect(await getLiveOsShareSession(db, "before", at)).toBeUndefined();
			expect(await session("tighten", "stale")).toBeUndefined();
			expect(
				await restrictOsShareLink(db, {
					organizationId: "org",
					shareLinkId: "tighten",
					maxRole: "build",
					reason: "Cannot widen",
					now: at,
				}),
			).toBeUndefined();
			expect((await session("tighten", "narrow", "viewer"))?.id).toBe("narrow");
			expect(
				await revokeOsShareLink(db, {
					organizationId: "other",
					shareLinkId: "tighten",
				}),
			).toBeUndefined();
			expect(await getLiveOsShareSession(db, "narrow", at)).toBeDefined();
			await revokeOsShareLink(db, {
				organizationId: "org",
				shareLinkId: "tighten",
			});
			expect(await getLiveOsShareSession(db, "narrow", at)).toBeUndefined();
			expect(await session("tighten", "revoked", "viewer")).toBeUndefined();
		});

		it("preserves invitee idempotence and link cascades with foreign keys enabled", async () => {
			await share("invite");
			const invite = {
				id: "invitee",
				organizationId: "org",
				shareLinkId: "invite",
				email: "person@example.test",
				addedByKind: "user" as const,
				addedById: "owner",
				addedAt: at,
			};
			expect((await addOsShareLinkInvitee(db, invite)).id).toBe("invitee");
			expect(
				(await addOsShareLinkInvitee(db, { ...invite, id: "repeat" })).id,
			).toBe("invitee");
			expect(
				await isOsShareLinkInvitee(db, {
					link: { id: "invite", resourceType: "output", resourceId: "invite" },
					userId: "person",
					email: "PERSON@example.test",
				}),
			).toBe(true);
			expect(
				await removeOsShareLinkInvitee(db, {
					organizationId: "other",
					shareLinkId: "invite",
					inviteeId: "invitee",
				}),
			).toBe(false);
			await session("invite", "cascade");
			expect(
				await deleteOsShareLink(db, {
					organizationId: "other",
					shareLinkId: "invite",
				}),
			).toBe(false);
			expect(
				await deleteOsShareLink(db, {
					organizationId: "org",
					shareLinkId: "invite",
				}),
			).toBe(true);
			expect(await getLiveOsShareSession(db, "cascade", at)).toBeUndefined();
			expect(
				await db.select().from(coreTable(db, osShareLinkInvitees)),
			).toEqual([]);
		});

		it("binds large lookup sets and ends sessions when settings narrow", async () => {
			await share("settings");
			await session("settings", "settings-session");
			const missing = Array.from({ length: 300 }, (_, i) => `missing-${i}`);
			expect(
				await listOsShareResourceIdsWithActiveLinks(db, {
					organizationId: "org",
					resourceType: "output",
					resourceIds: [...missing, "settings"],
				}),
			).toEqual(new Set(["settings"]));
			expect(
				await listOsShareResourceIdsWithActiveLinks(db, {
					organizationId: "other",
					resourceType: "output",
					resourceIds: ["settings"],
				}),
			).toEqual(new Set());
			expect(
				(
					await listOsShareSessionPeople(db, {
						organizationId: "org",
						sessionIds: [...missing, "settings-session"],
					})
				).get("settings-session"),
			).toEqual({ email: "person@example.test", name: null });
			expect(
				await listOsShareSessionPeople(db, {
					organizationId: "other",
					sessionIds: ["settings-session"],
				}),
			).toEqual(new Map());
			const changed = await updateOsShareLinkSettings(db, {
				organizationId: "org",
				shareLinkId: "settings",
				set: { disabledAt: at, standalone: true },
				endSessions: true,
				now: at,
			});
			expect(changed?.share.standalone).toBe(true);
			expect(changed?.revokedSessionCount).toBe(1);
			expect(await session("settings", "disabled")).toBeUndefined();
		});

		it("reserves email challenges and consumes a matching code only once", async () => {
			await share("email");
			await updateOsShareLinkSettings(db, {
				organizationId: "org",
				shareLinkId: "email",
				set: { access: "invited" },
				endSessions: false,
			});
			for (let index = 0; index < 4; index++)
				expect(
					await reserveOsShareEmailCode(db, {
						id: `code-${index}`,
						shareLinkId: "email",
						email: "person@example.test",
						codeHash: "hash",
						ipHash: "ip",
						createdAt: at,
						expiresAt,
						windowStart: "2026-11-20T11:00:00.000Z",
					}),
				).toBe(index < 3);
			const guess = {
				linkId: "email",
				email: "person@example.test",
				codeHash: "hash",
				now: at,
			};
			expect(
				await consumeOsShareEmailCode(db, { ...guess, codeHash: "wrong" }),
			).toBe(false);
			expect(await consumeOsShareEmailCode(db, guess)).toBe(true);
			expect(await consumeOsShareEmailCode(db, guess)).toBe(false);
		});

		it("keeps collaborator edges atomic, reuses default links and revokes their keys", async () => {
			await db.insert(coreTable(db, osWorkspaces)).values({
				id: "workspace",
				organizationId: "org",
				name: "Shared space",
				createdByKind: "user",
				createdById: "owner",
			});
			const scope = {
				organizationId: "org",
				workspaceId: "workspace",
				now: at,
			};
			const edge = {
				targetUserId: "person",
				targetEmail: "person@example.test",
				targetName: "Person",
				kind: "user" as const,
				sharerUserId: "owner",
				role: "build" as const,
			};
			await grantOsWorkspaceAccess(db, { ...scope, edges: [edge] });
			await grantOsWorkspaceAccess(db, {
				...scope,
				edges: [{ ...edge, role: "use" }],
			});
			const graph = await loadOsWorkspacePermissionRows(db, scope);
			expect(graph.collaborators).toHaveLength(1);
			expect(graph.edges).toHaveLength(1);
			expect(graph.edges[0]?.role).toBe("use");
			expect(
				await getLatestOsWorkspaceEventCursor(db, "workspace"),
			).toBeGreaterThan(0);
			expect(
				(
					await loadOsWorkspacePermissionRows(db, {
						...scope,
						organizationId: "other",
					})
				).edges,
			).toEqual([]);
			await severOsWorkspaceUserAccess(db, {
				...scope,
				organizationId: "other",
				targetUserId: "person",
				keepEdges: [],
			});
			expect(
				(await loadOsWorkspacePermissionRows(db, scope)).edges,
			).toHaveLength(1);
			await severOsWorkspaceUserAccess(db, {
				...scope,
				targetUserId: "person",
				keepEdges: [],
			});
			expect((await loadOsWorkspacePermissionRows(db, scope)).edges).toEqual(
				[],
			);
			const linkParams = {
				...scope,
				creatorUserId: "owner",
				role: "use" as const,
			};
			expect(
				(
					await createOrReuseOsWorkspaceDefaultShareLink(db, {
						...linkParams,
						id: "default-1",
						keyHash: "key-1",
					})
				).id,
			).toBe("default-1");
			expect(
				(
					await createOrReuseOsWorkspaceDefaultShareLink(db, {
						...linkParams,
						id: "default-2",
						keyHash: "key-2",
					})
				).id,
			).toBe("default-1");
			expect(
				(
					await getActiveOsWorkspaceShareLinkByKeyHash(db, {
						workspaceId: "workspace",
						keyHash: "key-2",
					})
				)?.id,
			).toBe("default-1");
			await revokeOsWorkspaceShareLink(db, {
				...scope,
				linkId: "default-1",
				keepEdges: [],
			});
			expect(
				await getActiveOsWorkspaceShareLinkByKeyHash(db, {
					workspaceId: "workspace",
					keyHash: "key-2",
				}),
			).toBeUndefined();
			expect(
				await db.select().from(coreTable(db, osWorkspaceShareKeys)),
			).toEqual([]);
			const bulk = Array.from({ length: 30 }, (_, index) => ({
				...edge,
				targetUserId: `bulk-${index}`,
			}));
			const batch = vi.spyOn(db, "batch");
			await grantOsWorkspaceAccess(db, {
				...scope,
				edges: [...bulk, { ...bulk[0]!, role: "use" }],
			});
			expect(batch).toHaveBeenCalledTimes(1);
			batch.mockRestore();
			const bulkGraph = await loadOsWorkspacePermissionRows(db, scope);
			expect(bulkGraph.edges).toHaveLength(30);
			expect(
				bulkGraph.edges.find((row) => row.targetUserId === "bulk-0")?.role,
			).toBe("use");
		});

		it("rolls back collaborators if the later edge insert fails, and binds large member sets", async () => {
			const scope = {
				organizationId: "org",
				workspaceId: "workspace",
				now: at,
			};
			const before = await loadOsWorkspacePermissionRows(db, scope);
			const uuid = vi
				.spyOn(crypto, "randomUUID")
				.mockReturnValue(
					before.edges[0]!.id as ReturnType<typeof crypto.randomUUID>,
				);
			try {
				await expect(
					grantOsWorkspaceAccess(db, {
						...scope,
						edges: [
							{
								targetUserId: "rollback",
								targetEmail: null,
								targetName: null,
								kind: "user",
								sharerUserId: "owner",
								role: "use",
							},
						],
					}),
				).rejects.toThrow();
			} finally {
				uuid.mockRestore();
			}
			expect(
				(await loadOsWorkspacePermissionRows(db, scope)).collaborators.some(
					(row) => row.userId === "rollback",
				),
			).toBe(false);
			await db.insert(coreTable(db, organizationMembers)).values({
				id: "person-member",
				organizationId: "org",
				descopeUserId: "person",
				email: "person@example.test",
				name: "Person",
				role: "member",
			});
			const ids = [
				...Array.from({ length: 300 }, (_, i) => `absent-${i}`),
				"person",
			];
			expect((await listTedixPeople(db, ids)).map((row) => row.userId)).toEqual(
				["person"],
			);
			expect(
				await listOsWorkspaceOrganizationMemberRoles(db, {
					organizationId: "org",
					userIds: ids,
				}),
			).toEqual([{ userId: "person", role: "member" }]);
			expect(
				await listOsWorkspaceOrganizationMemberRoles(db, {
					organizationId: "other",
					userIds: ids,
				}),
			).toEqual([]);
		});

		it("replaces a large skill-grant set in one batch and keeps the last duplicate approval", async () => {
			await share("skills");
			const scope = { organizationId: "org", shareLinkId: "skills" };
			const grants = Array.from({ length: 30 }, (_, index) => ({
				...scope,
				id: `grant-${index}`,
				revisionId: "revision",
				slot: `slot-${index}`,
				workspaceId: "workspace",
				gadgetId: "gadget",
				resourceId: `resource-${index}`,
				providerResourceId: `provider-${index}`,
				approvedByUserId: "owner",
				approvedAt: at,
			}));
			const batch = vi.spyOn(db, "batch");
			await setOsShareSkillReadGrants(db, scope, [
				...grants,
				{ ...grants[0]!, id: "duplicate-grant", resourceId: "replacement" },
			]);
			expect(batch).toHaveBeenCalledTimes(1);
			batch.mockRestore();
			const rows = await db
				.select()
				.from(coreTable(db, osShareSkillReadGrants));
			expect(rows).toHaveLength(30);
			expect(rows.find((row) => row.slot === "slot-0")?.resourceId).toBe(
				"replacement",
			);
			await setOsShareSkillReadGrants(db, scope, []);
			expect(
				(await db.select().from(coreTable(db, osShareSkillReadGrants))).every(
					(row) => row.revokedAt !== null,
				),
			).toBe(true);
		});
	});
}
