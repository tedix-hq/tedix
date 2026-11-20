import { workspaceOutputFixture } from "../../../test/workspace-output-fixture";
/**
 * Workspace collaborators end to end over D1: direct adds, share links, the
 * live permission graph, lazy revocation, and the role-scoped capability.
 * People in two fictional organizations; the workspace is private to Robin.
 */
import { DatabaseSync } from "node:sqlite";
import { createRouterClient } from "@orpc/server";
import { createDbClient } from "@tedix/db/client";
import {
	kernelConversations,
	kernelConversationGrants,
	kernelRuntimeEvents,
} from "@tedix/db/schema/cognitive-runtime";
import { ensureHomeConversationAccess } from "./kernel/run-store";
import { kernelRuntimeContractRouter } from "./kernel-runtime";
import { workspaceSessionAccess } from "../../services/os-workspace-session-access";
import { auditEvents } from "@tedix/db/schema/audit-events";
import { organizationMembers } from "@tedix/db/schema/organization-members";
import {
	osWorkspaceAccessEdges,
	osWorkspaceCollaborators,
	osWorkspaceEvents,
	osWorkspaceShareKeys,
	osWorkspaceShareLinks,
} from "@tedix/db/schema/os-collaborators";
import { osShareLinks } from "@tedix/db/schema/os-shares";
import {
	osCollaborationProposals,
	osGadgetRevisions,
	osGadgets,
	osWorkspaceSummaries,
	osWorkspaceResources,
	osWorkspaces,
} from "@tedix/db/schema/os-workspaces";
import { osOutputs } from "@tedix/db/tenant-store/outputs-schema";
import { tedis } from "@tedix/db/schema/tedis";
import { providerInstallations } from "@tedix/db/schema/provider-installations";
import { userConfigs } from "@tedix/db/schema/user-configs";
import {
	workspaceActivity,
	workspaceFeedCursors,
	workspaceFeedLedger,
	workspaceOutputIndex,
	workspaceWorkLinks,
} from "@tedix/db/schema/workspace-feed";
import { savePushConfig } from "@tedix/db/queries/web-push";
import { createD1Facade } from "@tedix/db/test/d1-facade";
import { schemaDdl } from "@tedix/db/test/schema-ddl";
import { describe, expect, it, onTestFinished, vi } from "vite-plus/test";
import type { BaseContext } from "../orpc";
import { readWorkspaceRuntimeRole } from "@tedix/db/queries/os-workspace-access";
import { ensureWorkspaceSkillDependencyLinks } from "./os-workspaces-shared";
import { assertOsWorkspaceVisible } from "../../services/os-workspace-visibility";
import { requireWorkspaceCollaboratorAccess } from "../../services/os-workspace-collaborators";
import { osCollaboratorsContractRouter } from "./os-collaborators";
import { osWorkspacesContractRouter } from "./os-workspaces";

vi.mock("@block65/webcrypto-web-push", () => ({
	buildPushPayload: vi.fn(async (message: { data: string }) => ({
		method: "POST",
		body: message.data,
	})),
}));

const ROBIN = "member-robin"; // owner, org-1
const KAI = "member-kai"; // org-1
const ZOE = "member-zoe"; // org-2
const LEE = "member-lee"; // org-2
const STRANGER = "member-sam"; // org-2, never added

function createEnv() {
	const sqlite = new DatabaseSync(":memory:");
	onTestFinished(() => sqlite.close());
	sqlite.exec("PRAGMA foreign_keys = OFF;");
	sqlite.exec(
		schemaDdl(
			tedis,
			kernelConversations,
			kernelConversationGrants,
			kernelRuntimeEvents,
			osWorkspaces,
			osWorkspaceSummaries,
			osWorkspaceResources,
			osOutputs,
			providerInstallations,
			osCollaborationProposals,
			osGadgets,
			osGadgetRevisions,
			osShareLinks,
			userConfigs,
			auditEvents,
			organizationMembers,
			osWorkspaceCollaborators,
			osWorkspaceAccessEdges,
			osWorkspaceShareLinks,
			osWorkspaceShareKeys,
			osWorkspaceEvents,
			workspaceFeedLedger,
			workspaceFeedCursors,
			workspaceActivity,
			workspaceOutputIndex,
			workspaceWorkLinks,
		),
	);
	sqlite.exec(`
		CREATE TABLE organizations (id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL, slug TEXT DEFAULT 'fictional', type TEXT DEFAULT 'organization', descope_tenant_id TEXT, logo_url TEXT);
		INSERT INTO organizations (id, name) VALUES ('org-1', 'Fictional Org'), ('org-2', 'Other Fictional Org');
		INSERT INTO organization_members (id, organization_id, descope_user_id, email, name, role, status)
		VALUES ('m-robin','org-1','member-robin','robin@example.test','Robin','member','active'),
		       ('m-kai','org-1','member-kai','kai@example.test','Kai','member','active'),
		       ('m-zoe','org-2','member-zoe','zoe@example.test','Zoe','member','active'),
		       ('m-lee','org-2','member-lee','lee@example.test','Lee','member','active'),
		       ('m-sam','org-2','member-sam','sam@example.test','Sam','member','active');
	`);
	workspaceOutputFixture(sqlite, { coreSchemaExists: true });
	const env = {
		ENVIRONMENT: "test",
		API_URL: "https://api.tedix.test",
		DB: createD1Facade(sqlite),
	} as CloudflareEnv;
	return { env, sqlite };
}

function context(env: CloudflareEnv, sub: string): BaseContext {
	const organizationId = [ROBIN, KAI].includes(sub) ? "org-1" : "org-2";
	return {
		authType: "user",
		db: createDbClient(env.DB) as BaseContext["db"],
		env,
		headers: new Headers(),
		organizationId,
		url: new URL("https://api.tedix.test/rpc/os-collaborators"),
		user: {
			aud: "test",
			dct: organizationId,
			exp: 2,
			iat: 1,
			iss: "https://auth.tedix.test",
			permissions: ["os:read", "os:author", "os:admin"],
			roles: [],
			sub,
		},
	} as BaseContext;
}

function as(env: CloudflareEnv, sub: string) {
	return createRouterClient(osCollaboratorsContractRouter, {
		context: context(env, sub),
	});
}

function workspacesAs(env: CloudflareEnv, sub: string) {
	return createRouterClient(osWorkspacesContractRouter, {
		context: context(env, sub),
	});
}

async function seed() {
	const { env, sqlite } = createEnv();
	const { workspace } = await workspacesAs(env, ROBIN).workspaces.create({
		name: "Reddit research",
		visibility: "private",
	});
	return { env, sqlite, workspaceId: workspace.id };
}

const DENIED = {
	code: "FORBIDDEN",
	message: "You don't have access to this workspace",
};

describe("workspace collaborators", () => {
	it("gives a linked skill's tedi a durable build edge and preserves an existing use grant", async () => {
		const { env, sqlite, workspaceId } = await seed();
		const tediId = "12345678-1234-4234-8234-123456789abc";
		sqlite
			.prepare(
				"INSERT INTO tedis (id, organization_id, name, slug, status, scope) VALUES (?, 'org-1', 'Research helper', 'research', 'active', 'organization')",
			)
			.run(tediId);
		const ctx = context(env, ROBIN);
		const input = {
			organizationId: "org-1",
			workspaceId,
			skill: { tediId, content: "", files: null },
		};
		await ensureWorkspaceSkillDependencyLinks(ctx, input);
		const role = () =>
			readWorkspaceRuntimeRole(
				ctx.db,
				{ organizationId: "org-1", workspaceId },
				{ actorId: tediId, actorKind: "tedi" },
			);
		expect(await role()).toBe("build");
		await as(env, ROBIN).setRole({ workspaceId, userId: tediId, role: "use" });
		await ensureWorkspaceSkillDependencyLinks(ctx, input);
		expect(await role()).toBe("use");
	});

	it.each(["private", "org"] as const)(
		"invites and removes a tedi principal in a %s workspace",
		async (visibility) => {
			const { env, sqlite, workspaceId } = await seed();
			const tediId = "12345678-1234-4234-8234-123456789abc";
			sqlite
				.prepare("UPDATE os_workspaces SET visibility = ? WHERE id = ?")
				.run(visibility, workspaceId);
			sqlite
				.prepare(
					"INSERT INTO tedis (id, organization_id, name, slug, status, scope) VALUES (?, 'org-1', 'Research helper', 'research', 'active', 'organization')",
				)
				.run(tediId);
			const tediContext = {
				...context(env, ROBIN),
				authType: "tedi",
				user: undefined,
				tediId,
			} as BaseContext;
			const workspace = (
				await context(env, ROBIN).db.select().from(osWorkspaces)
			)[0]!;
			const role = () =>
				readWorkspaceRuntimeRole(
					tediContext.db,
					{ organizationId: "org-1", workspaceId },
					{ actorId: tediId, actorKind: "tedi" },
				);
			// Without a role of its own a tedi keeps what it had before: an
			// organization workspace stays open to it, a private one stays hidden.
			const withoutRole = () =>
				visibility === "private"
					? expect(
							assertOsWorkspaceVisible(tediContext, workspace),
						).rejects.toMatchObject({ code: "NOT_FOUND" })
					: expect(
							assertOsWorkspaceVisible(tediContext, workspace),
						).resolves.toBeUndefined();
			expect(await role()).toBeNull();
			await withoutRole();
			const { collaborator } = await as(env, ROBIN).add({
				workspaceId,
				tediId,
				role: "use",
			});
			expect(collaborator).toMatchObject({
				userId: tediId,
				principalKind: "tedi",
				role: "use",
			});
			expect(await role()).toBe("use");
			await expect(
				requireWorkspaceCollaboratorAccess(
					tediContext,
					workspaceId,
					"metadata.read",
				),
			).resolves.toMatchObject({ role: "use" });
			await as(env, ROBIN).add({ workspaceId, tediId, role: "build" });
			expect(await role()).toBe("build");
			await expect(
				assertOsWorkspaceVisible(tediContext, workspace),
			).resolves.toBeUndefined();
			expect(
				(await as(env, ROBIN).list({ workspaceId })).collaborators,
			).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						userId: tediId,
						principalKind: "tedi",
						canRemove: true,
					}),
				]),
			);
			await as(env, ROBIN).remove({
				workspaceId,
				target: { kind: "user", userId: tediId },
			});
			expect(await role()).toBeNull();
			await withoutRole();
		},
	);
	it("refuses inviting a tedi from another organization", async () => {
		const { env, sqlite, workspaceId } = await seed();
		const tediId = "12345678-1234-4234-8234-123456789abc";
		sqlite
			.prepare(
				"INSERT INTO tedis (id, organization_id, name, slug, status, scope) VALUES (?, 'org-2', 'Other helper', 'other', 'active', 'organization')",
			)
			.run(tediId);
		await expect(
			as(env, ROBIN).add({ workspaceId, tediId, role: "build" }),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
	});

	it.each([
		"open",
		"accepted",
		"merged",
		"stale",
		"foreign",
		"wrong-app",
		"archived",
	])(
		"revalidates a %s app code scope against the stored proposal",
		async (condition) => {
			const { env, workspaceId } = await seed();
			const db = context(env, ROBIN).db;
			const gadgetId = "44444444-4444-4444-8444-444444444444";
			const proposalId = "55555555-5555-4555-8555-555555555555";
			const baseRevisionId = "66666666-6666-4666-8666-666666666666";
			await db.insert(osGadgets).values({
				id: gadgetId,
				organizationId: "org-1",
				workspaceId,
				name: "Draft app",
				status: condition === "archived" ? "archived" : "active",
				createdByKind: "user",
				createdById: ROBIN,
			});
			await db.insert(osCollaborationProposals).values({
				id: proposalId,
				organizationId: condition === "foreign" ? "org-2" : "org-1",
				workspaceId,
				documentType: "gadget",
				documentId: condition === "wrong-app" ? "another-app" : gadgetId,
				baseRevisionId: condition === "stale" ? "another-base" : baseRevisionId,
				baseRevision: 1,
				status:
					condition === "accepted"
						? "accepted"
						: condition === "merged"
							? "merged"
							: "open",
				sourceKind: "user",
				sourceId: ROBIN,
				content: "{}",
				createdByKind: "user",
				createdById: ROBIN,
			});
			const response = await workspaceSessionAccess(
				new Request("https://api/__internal/workspace-session-access", {
					method: "POST",
					body: JSON.stringify({
						workspaceId,
						userIds: [ROBIN, STRANGER],
						appDraft: { gadgetId, proposalId, baseRevisionId },
					}),
				}),
				env,
			);
			expect(await response.json()).toEqual(
				condition === "open"
					? { roles: { [ROBIN]: "build", [STRANGER]: null } }
					: { roles: {} },
			);
		},
	);
	it("cuts an in-flight chat poll even when the removed collaborator still owns its conversation", async () => {
		const { env, workspaceId, sqlite } = await seed();
		await as(env, ROBIN).add({
			workspaceId,
			email: "kai@example.test",
			role: "build",
		});
		const ctx = context(env, KAI);
		ctx.user!.permissions = [...ctx.user!.permissions, "tedis:read"];
		await ctx.db.insert(kernelConversations).values({
			id: "chat-1",
			organizationId: "org-1",
			conversationId: "chat-1",
			workspaceId,
			lastMessageAt: new Date().toISOString(),
		});
		await ctx.db.insert(kernelConversationGrants).values({
			id: "grant-1",
			organizationId: "org-1",
			conversationId: "chat-1",
			granteeDescopeUserId: KAI,
			access: "owner",
		});
		await ensureHomeConversationAccess(ctx, {
			organizationId: "org-1",
			conversationId: "chat-1",
			required: "read",
		});
		const client = createRouterClient(kernelRuntimeContractRouter, {
			context: ctx,
		});
		const poll = client.readConversationEvents({
			conversationId: "chat-1",
			waitMs: 2_000,
		});
		const denied = expect(poll).rejects.toMatchObject({ code: "FORBIDDEN" });
		await new Promise((resolve) => setTimeout(resolve, 50));
		await as(env, ROBIN).remove({
			workspaceId,
			target: { kind: "user", userId: KAI },
		});
		await denied;
		expect(
			sqlite
				.prepare(
					"SELECT access FROM kernel_conversation_grants WHERE id = 'grant-1'",
				)
				.get(),
		).toMatchObject({ access: "owner" });
	});
	it("cuts a suspended browser seat even when its explicit workspace share remains", async () => {
		const { env, workspaceId, sqlite } = await seed();
		await as(env, ROBIN).add({
			workspaceId,
			email: "kai@example.test",
			role: "build",
		});
		sqlite
			.prepare(
				"UPDATE organization_members SET kind = 'browser_agent', represented_user_id = ? WHERE descope_user_id = ?",
			)
			.run(ROBIN, KAI);
		const read = async () => {
			const response = await workspaceSessionAccess(
				new Request("https://api/__internal/workspace-session-access", {
					method: "POST",
					body: JSON.stringify({ workspaceId, userIds: [ROBIN, KAI] }),
				}),
				env,
			);
			return response.json();
		};
		expect(await read()).toEqual({
			roles: { [ROBIN]: "build", [KAI]: "build" },
		});
		sqlite
			.prepare(
				"UPDATE organization_members SET status = 'deactivated' WHERE descope_user_id = ?",
			)
			.run(KAI);
		expect(await read()).toEqual({ roles: { [ROBIN]: "build", [KAI]: null } });
	});

	it("rechecks live session roles after a cascading downgrade and removal", async () => {
		const { env, workspaceId } = await seed();
		await as(env, ROBIN).add({
			workspaceId,
			email: "kai@example.test",
			role: "build",
		});
		await as(env, KAI).add({
			workspaceId,
			email: "zoe@example.test",
			role: "build",
		});
		await as(env, ROBIN).add({
			workspaceId,
			email: "zoe@example.test",
			role: "use",
		});
		const read = async () => {
			const response = await workspaceSessionAccess(
				new Request("https://api/__internal/workspace-session-access", {
					method: "POST",
					body: JSON.stringify({
						workspaceId,
						userIds: [ROBIN, KAI, ZOE, STRANGER],
					}),
				}),
				env,
			);
			return response.json();
		};
		expect(await read()).toEqual({
			roles: {
				[ROBIN]: "build",
				[KAI]: "build",
				[ZOE]: "build",
				[STRANGER]: null,
			},
		});
		await as(env, ROBIN).remove({
			workspaceId,
			target: { kind: "user", userId: KAI },
		});
		expect(await read()).toEqual({
			roles: { [ROBIN]: "build", [KAI]: null, [ZOE]: "use", [STRANGER]: null },
		});
		expect(await as(env, ZOE).access({ workspaceId })).toEqual({
			role: "use",
			leave: "allowed",
		});
		await expect(as(env, KAI).access({ workspaceId })).rejects.toMatchObject(
			DENIED,
		);
		await as(env, ROBIN).remove({
			workspaceId,
			target: { kind: "user", userId: ZOE },
		});
		expect(await read()).toEqual({
			roles: { [ROBIN]: "build", [KAI]: null, [ZOE]: null, [STRANGER]: null },
		});
	});
	it("hands use collaborators only the use allowlist", async () => {
		const { env, workspaceId } = await seed();
		await as(env, ROBIN).add({
			workspaceId,
			email: "kai@example.test",
			role: "build",
		});
		await as(env, KAI).add({
			workspaceId,
			email: "ZOE@example.test",
			role: "use",
		});

		const opened = await as(env, ZOE).open({ workspaceId });
		expect(opened.role).toBe("use");
		expect(opened.isOwner).toBe(false);
		expect(opened.workspace).toEqual({
			id: workspaceId,
			title: "Reddit research",
			ownerName: "Robin",
		});
		expect(opened.capability.operations).toEqual([
			"app.connect",
			"app.render",
			"metadata.read",
			"presence.read",
		]);
		expect(opened.capability.actingUserId).toBe(ZOE);
		expect(await as(env, ZOE).presence({ workspaceId })).toEqual({
			workspaceId,
			userId: ZOE,
			displayName: "Zoe",
			role: "use",
		});

		await expect(as(env, ZOE).list({ workspaceId })).rejects.toMatchObject({
			code: "FORBIDDEN",
		});
		await expect(
			as(env, ZOE).add({ workspaceId, email: "lee@example.test", role: "use" }),
		).rejects.toMatchObject({ code: "FORBIDDEN" });

		const kai = await as(env, KAI).open({ workspaceId });
		expect(kai.role).toBe("build");
		expect(kai.capability.operations).toContain("sharing.write");
		expect(await as(env, ROBIN).presence({ workspaceId })).toEqual({
			workspaceId,
			userId: ROBIN,
			displayName: "Robin",
			role: "owner",
		});
	});

	it("denies strangers without revealing the workspace", async () => {
		const { env, workspaceId } = await seed();
		await expect(as(env, STRANGER).open({ workspaceId })).rejects.toMatchObject(
			DENIED,
		);
		await expect(
			as(env, STRANGER).presence({ workspaceId }),
		).rejects.toMatchObject(DENIED);
		await expect(
			as(env, STRANGER).open({ workspaceId: crypto.randomUUID() }),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		await expect(
			as(env, ROBIN).add({
				workspaceId,
				email: "nobody@example.test",
				role: "use",
			}),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
	});

	it("streams access changes to members and refuses people without access", async () => {
		const { env, workspaceId } = await seed();
		const baseline = await as(env, ROBIN).events({ workspaceId });
		expect(baseline.kinds).toEqual([]);
		// Nothing new: the held request answers empty with the same cursor.
		expect(
			await as(env, ROBIN).events({
				workspaceId,
				after: baseline.cursor,
				waitMs: 0,
			}),
		).toEqual({ cursor: baseline.cursor, kinds: [] });
		await as(env, ROBIN).add({
			workspaceId,
			email: "kai@example.test",
			role: "build",
		});
		const afterAdd = await as(env, KAI).events({
			workspaceId,
			after: baseline.cursor,
			waitMs: 0,
		});
		expect(afterAdd.kinds).toEqual(["access"]);
		expect(afterAdd.cursor).toBeGreaterThan(baseline.cursor);
		// Losing access ends the stream: the next read is refused.
		await as(env, ROBIN).remove({
			workspaceId,
			target: { kind: "user", userId: KAI },
		});
		await expect(
			as(env, KAI).events({ workspaceId, after: afterAdd.cursor, waitMs: 0 }),
		).rejects.toMatchObject(DENIED);
		await expect(
			as(env, STRANGER).events({ workspaceId }),
		).rejects.toMatchObject(DENIED);
	});

	it("gives an unrelated user a generic FORBIDDEN with no workspace metadata", async () => {
		const { env, workspaceId } = await seed();
		await as(env, ROBIN).add({
			workspaceId,
			email: "kai@example.test",
			role: "build",
		});
		await as(env, ROBIN).createLink({ workspaceId, role: "use" });
		const error = await as(env, STRANGER)
			.open({ workspaceId })
			.then(
				() => null,
				(caught: unknown) => caught,
			);
		expect(error).toMatchObject(DENIED);
		const serialized = JSON.stringify({
			...(error as object),
			message: (error as Error).message,
			data: (error as { data?: unknown }).data ?? null,
		});
		for (const leak of [
			"Reddit research",
			"Robin",
			"robin@example.test",
			"Kai",
			ROBIN,
			KAI,
		])
			expect(serialized).not.toContain(leak);
		// A wrong share key changes nothing.
		await expect(
			as(env, STRANGER).open({
				workspaceId,
				shareKey: "AAAAAAAAAAAAAAAAAAAAAA",
			}),
		).rejects.toMatchObject(DENIED);
	});

	it("deletes collaborators, edges, links and keys with the workspace", async () => {
		const { env, sqlite, workspaceId } = await seed();
		await as(env, ROBIN).add({
			workspaceId,
			email: "kai@example.test",
			role: "build",
		});
		const { key } = await as(env, ROBIN).createLink({
			workspaceId,
			role: "use",
		});
		await as(env, ZOE).open({ workspaceId, shareKey: key });
		const { workspace: other } = await workspacesAs(
			env,
			ROBIN,
		).workspaces.create({ name: "Kept", visibility: "private" });
		await as(env, ROBIN).add({
			workspaceId: other.id,
			email: "kai@example.test",
			role: "use",
		});
		const count = (table: string) =>
			(
				sqlite.prepare(`SELECT count(*) AS n FROM ${table}`).get() as {
					n: number;
				}
			).n;
		const tables = [
			"os_workspace_collaborators",
			"os_workspace_access_edges",
			"os_workspace_share_links",
			"os_workspace_share_keys",
		];
		expect(tables.map(count)).toEqual([3, 3, 1, 1]);

		const robin = workspacesAs(env, ROBIN);
		await robin.workspaces.archive({ workspaceId });
		await robin.workspaces.delete({ workspaceId });
		// Only the other workspace's grant to Kai remains.
		expect(tables.map(count)).toEqual([1, 1, 0, 0]);
		await expect(as(env, KAI).open({ workspaceId })).rejects.toMatchObject({
			code: "NOT_FOUND",
		});
		expect((await as(env, KAI).open({ workspaceId: other.id })).role).toBe(
			"use",
		);
	});

	it("redeems a hashed share key in the open call and revokes by flag", async () => {
		const { env, sqlite, workspaceId } = await seed();
		const { link, key } = await as(env, ROBIN).createLink({
			workspaceId,
			role: "use",
			label: "Reviewers",
		});
		expect(key).toMatch(/^[A-Za-z0-9_-]{22}$/);
		const stored = sqlite
			.prepare("SELECT key_hash FROM os_workspace_share_keys")
			.all() as { key_hash: string }[];
		expect(stored).toHaveLength(1);
		expect(stored[0]!.key_hash).toMatch(/^[0-9a-f]{64}$/);
		expect(stored[0]!.key_hash).not.toContain(key);

		const opened = await as(env, LEE).open({ workspaceId, shareKey: key });
		expect(opened.role).toBe("use");
		// The edge persists; no key is needed afterwards.
		expect((await as(env, LEE).open({ workspaceId })).role).toBe("use");

		const { key: second } = await as(env, ROBIN).copyLink({
			workspaceId,
			linkId: link.id,
		});
		expect(second).not.toBe(key);

		const preview = await as(env, ROBIN).previewRemove({
			workspaceId,
			target: { kind: "link", linkId: link.id },
		});
		expect(preview.affected).toEqual([
			{
				principalKind: "user",
				userId: LEE,
				email: "lee@example.test",
				name: "Lee",
				oldRole: "use",
				newRole: null,
			},
		]);
		await as(env, ROBIN).remove({
			workspaceId,
			target: { kind: "link", linkId: link.id },
		});
		expect(
			sqlite.prepare("SELECT revoked_at FROM os_workspace_share_links").get(),
		).toMatchObject({ revoked_at: expect.any(String) });
		await expect(as(env, LEE).open({ workspaceId })).rejects.toMatchObject(
			DENIED,
		);
		await expect(
			as(env, ZOE).open({ workspaceId, shareKey: second }),
		).rejects.toMatchObject(DENIED);
		expect((await as(env, ROBIN).list({ workspaceId })).links).toEqual([]);
	});

	it("gives each person one default link per role and re-uses it on every copy", async () => {
		const { env, sqlite, workspaceId } = await seed();
		await as(env, ROBIN).add({
			workspaceId,
			email: "kai@example.test",
			role: "build",
		});
		const robin = as(env, ROBIN);
		// Twice in a row and twice at once: one link, a new key each time.
		const first = await robin.createLink({ workspaceId, role: "use" });
		const second = await robin.createLink({ workspaceId, role: "use" });
		const [third, fourth] = await Promise.all([
			robin.createLink({ workspaceId, role: "use" }),
			robin.createLink({ workspaceId, role: "use" }),
		]);
		const copies = [first, second, third, fourth];
		expect(new Set(copies.map((copy) => copy.link.id))).toEqual(
			new Set([first.link.id]),
		);
		expect(new Set(copies.map((copy) => copy.key)).size).toBe(4);
		expect(second.link).toEqual(first.link);
		expect(
			sqlite
				.prepare("SELECT key_hash FROM os_workspace_share_keys")
				.all()
				.map((row) => (row as { key_hash: string }).key_hash),
		).toEqual(expect.not.arrayContaining(copies.map((copy) => copy.key)));
		// Every key opens the workspace through the same link.
		for (const [person, copy] of [
			[ZOE, first],
			[LEE, fourth],
		] as const)
			expect(
				(await as(env, person).open({ workspaceId, shareKey: copy.key })).role,
			).toBe("use");
		expect(
			sqlite
				.prepare(
					"SELECT DISTINCT link_id FROM os_workspace_access_edges WHERE kind = 'link'",
				)
				.all(),
		).toEqual([{ link_id: first.link.id }]);

		// A label, another role and another person each get their own link.
		const named = await robin.createLink({
			workspaceId,
			role: "use",
			label: "Reviewers",
		});
		const namedAgain = await robin.createLink({
			workspaceId,
			role: "use",
			label: "Reviewers",
		});
		const build = await robin.createLink({ workspaceId, role: "build" });
		const kai = await as(env, KAI).createLink({ workspaceId, role: "use" });
		expect(
			new Set(
				[first, named, namedAgain, build, kai].map((made) => made.link.id),
			).size,
		).toBe(5);
		expect(
			(await as(env, KAI).createLink({ workspaceId, role: "use" })).link.id,
		).toBe(kai.link.id);
		expect((await robin.list({ workspaceId })).links).toHaveLength(5);

		// Turning the default link off ends its keys; the next copy is a new link.
		await robin.remove({
			workspaceId,
			target: { kind: "link", linkId: first.link.id },
		});
		await expect(
			as(env, STRANGER).open({ workspaceId, shareKey: second.key }),
		).rejects.toMatchObject(DENIED);
		const fresh = await robin.createLink({ workspaceId, role: "use" });
		expect(fresh.link.id).not.toBe(first.link.id);
		expect(
			(await as(env, STRANGER).open({ workspaceId, shareKey: fresh.key })).role,
		).toBe("use");

		// Someone who can only use the workspace cannot make a build link.
		await robin.add({ workspaceId, email: "kai@example.test", role: "use" });
		await expect(
			as(env, KAI).createLink({ workspaceId, role: "build" }),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
	});

	it("caps link joiners at the link creator's role", async () => {
		const { env, workspaceId } = await seed();
		await as(env, ROBIN).add({
			workspaceId,
			email: "kai@example.test",
			role: "build",
		});
		const { key } = await as(env, KAI).createLink({
			workspaceId,
			role: "build",
		});
		expect((await as(env, ZOE).open({ workspaceId, shareKey: key })).role).toBe(
			"build",
		);
		// Kai drops to use: Zoe drops with him, live, with no rewrite of her edge.
		await as(env, ROBIN).add({
			workspaceId,
			email: "kai@example.test",
			role: "use",
		});
		expect((await as(env, ZOE).open({ workspaceId })).role).toBe("use");
	});

	it("previews and applies transitive removal, with keepUsers re-rooting", async () => {
		const { env, workspaceId } = await seed();
		await as(env, ROBIN).add({
			workspaceId,
			email: "kai@example.test",
			role: "build",
		});
		await as(env, KAI).add({
			workspaceId,
			email: "zoe@example.test",
			role: "build",
		});
		await as(env, ZOE).add({
			workspaceId,
			email: "lee@example.test",
			role: "use",
		});

		const target = { kind: "user" as const, userId: KAI };
		const preview = await as(env, ROBIN).previewRemove({ workspaceId, target });
		expect(preview.affected.map((a) => [a.userId, a.newRole])).toEqual([
			[KAI, null],
			[LEE, null],
			[ZOE, null],
		]);

		const removed = await as(env, ROBIN).remove({
			workspaceId,
			target,
			keepUserIds: [ZOE],
		});
		expect(removed.affected.map((a) => a.userId)).toEqual([KAI]);
		await expect(as(env, KAI).open({ workspaceId })).rejects.toMatchObject(
			DENIED,
		);
		expect((await as(env, ZOE).open({ workspaceId })).role).toBe("build");
		// Lee was added by Zoe, so keeping Zoe keeps Lee.
		expect((await as(env, LEE).open({ workspaceId })).role).toBe("use");

		// Undo: re-adding Kai restores him; his outgoing grants were never deleted.
		await as(env, ROBIN).add({
			workspaceId,
			email: "kai@example.test",
			role: "build",
		});
		expect((await as(env, KAI).open({ workspaceId })).role).toBe("build");
	});

	it("cuts live app sessions for everyone whose role fell, and only then", async () => {
		const { env, workspaceId } = await seed();
		const cuts: unknown[] = [];
		env.TEDI_SERVICE = {
			fetch: async (request: Request) => {
				expect(new URL(request.url).pathname).toBe(
					"/__internal/workspace-app/revoke",
				);
				expect(request.headers.get("X-Service-Binding")).toBe("true");
				cuts.push(await request.json());
				return Response.json({ restarted: 1 });
			},
		} as unknown as CloudflareEnv["TEDI_SERVICE"];
		await as(env, ROBIN).add({
			workspaceId,
			email: "kai@example.test",
			role: "build",
		});
		await as(env, KAI).add({
			workspaceId,
			email: "zoe@example.test",
			role: "build",
		});
		await as(env, ROBIN).add({
			workspaceId,
			email: "zoe@example.test",
			role: "use",
		});

		// Removing Kai drops Kai and downgrades Zoe from build to use.
		await as(env, ROBIN).remove({
			workspaceId,
			target: { kind: "user", userId: KAI },
		});
		expect(cuts).toEqual([
			expect.objectContaining({
				organizationId: "org-1",
				workspaceId,
				principalIds: [KAI, ZOE],
			}),
		]);
		expect((await as(env, ZOE).open({ workspaceId })).role).toBe("use");

		// Removing a grant that changes nobody's role cuts nothing.
		await as(env, ROBIN).add({
			workspaceId,
			email: "kai@example.test",
			role: "build",
		});
		await as(env, ROBIN).add({
			workspaceId,
			email: "lee@example.test",
			role: "use",
		});
		await as(env, KAI).add({
			workspaceId,
			email: "lee@example.test",
			role: "use",
		});
		await as(env, KAI).remove({
			workspaceId,
			target: { kind: "user", userId: LEE },
		});
		expect(cuts).toHaveLength(1);
	});

	it("lets non-owners remove only their own grant", async () => {
		const { env, workspaceId } = await seed();
		await as(env, ROBIN).add({
			workspaceId,
			email: "kai@example.test",
			role: "build",
		});
		await as(env, ROBIN).add({
			workspaceId,
			email: "lee@example.test",
			role: "use",
		});
		await as(env, KAI).add({
			workspaceId,
			email: "zoe@example.test",
			role: "use",
		});
		await as(env, ROBIN).add({
			workspaceId,
			email: "zoe@example.test",
			role: "use",
		});

		await expect(
			as(env, KAI).remove({
				workspaceId,
				target: { kind: "user", userId: LEE },
			}),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		await expect(
			as(env, KAI).remove({
				workspaceId,
				target: { kind: "user", userId: ROBIN },
			}),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });

		// Kai's edge goes; Robin's edge keeps Zoe in.
		const removed = await as(env, KAI).remove({
			workspaceId,
			target: { kind: "user", userId: ZOE },
		});
		expect(removed.affected).toEqual([]);
		expect((await as(env, ZOE).open({ workspaceId })).role).toBe("use");

		const listed = await as(env, KAI).list({ workspaceId });
		expect(
			listed.collaborators.map((c) => [c.userId, c.role, c.canRemove]),
		).toEqual([
			[KAI, "build", false],
			[LEE, "use", false],
			[ZOE, "use", false],
		]);
	});

	it("lists a shared workspace as new once the person is added, until dismissed", async () => {
		const { env, workspaceId } = await seed();
		await as(env, ROBIN).add({
			workspaceId,
			email: "zoe@example.test",
			role: "use",
		});
		const listed = {
			workspaceId,
			title: "Reddit research",
			ownerName: "Robin",
		};
		expect((await as(env, ZOE).listShared({})).items).toMatchObject([
			{ ...listed, isNew: true },
		]);
		// It is on nobody else's list: not the sharer's, not a stranger's.
		expect((await as(env, ROBIN).listShared({})).items).toEqual([]);
		expect((await as(env, STRANGER).listShared({})).items).toEqual([]);
		await as(env, ZOE).open({ workspaceId });
		expect((await as(env, ZOE).listShared({})).items).toMatchObject([
			{ ...listed, isNew: false },
		]);
		await as(env, ZOE).dismissShared({ workspaceId });
		expect((await as(env, ZOE).listShared({})).items).toEqual([]);
		// Dismissing hides it; it does not revoke access.
		expect((await as(env, ZOE).open({ workspaceId })).role).toBe("use");
	});

	it("lets same-organization build collaborators in, but only the owner archives", async () => {
		const { env, workspaceId } = await seed();
		const kai = workspacesAs(env, KAI);
		await expect(kai.workspaces.get({ workspaceId })).rejects.toMatchObject({
			code: "NOT_FOUND",
		});
		await as(env, ROBIN).add({
			workspaceId,
			email: "kai@example.test",
			role: "use",
		});
		// A use collaborator never reaches the full workspace routes.
		await expect(kai.workspaces.get({ workspaceId })).rejects.toMatchObject({
			code: "NOT_FOUND",
		});
		await as(env, ROBIN).add({
			workspaceId,
			email: "kai@example.test",
			role: "build",
		});
		expect((await kai.workspaces.get({ workspaceId })).workspace.id).toBe(
			workspaceId,
		);
		await expect(kai.workspaces.archive({ workspaceId })).rejects.toMatchObject(
			{
				code: "NOT_FOUND",
			},
		);
	});

	it("lets only the owner change a person's role, and dependents follow", async () => {
		const { env, workspaceId } = await seed();
		const { key } = await as(env, ROBIN).createLink({
			workspaceId,
			role: "build",
		});
		await as(env, KAI).open({ workspaceId, shareKey: key });
		await as(env, KAI).add({
			workspaceId,
			email: "zoe@example.test",
			role: "build",
		});
		const byOwner = await as(env, ROBIN).list({ workspaceId });
		expect(byOwner.collaborators.every((c) => c.canChangeRole)).toBe(true);
		expect(byOwner.links.every((l) => l.canEdit)).toBe(true);
		const byKai = await as(env, KAI).list({ workspaceId });
		expect(byKai.collaborators.some((c) => c.canChangeRole)).toBe(false);
		expect(byKai.links.some((l) => l.canEdit)).toBe(false);

		await expect(
			as(env, KAI).setRole({ workspaceId, userId: ZOE, role: "use" }),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		await expect(
			as(env, ROBIN).setRole({ workspaceId, userId: ROBIN, role: "use" }),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		await expect(
			as(env, ROBIN).setRole({ workspaceId, userId: STRANGER, role: "use" }),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		await expect(
			as(env, STRANGER).setRole({ workspaceId, userId: KAI, role: "use" }),
		).rejects.toMatchObject(DENIED);

		// Kai joined through the build link; his role is set without it.
		const changed = await as(env, ROBIN).setRole({
			workspaceId,
			userId: KAI,
			role: "use",
		});
		expect(changed.affected.map((a) => [a.userId, a.newRole])).toEqual([
			[KAI, "use"],
			[ZOE, "use"],
		]);
		expect((await as(env, KAI).open({ workspaceId })).role).toBe("use");
		expect((await as(env, ZOE).open({ workspaceId })).role).toBe("use");

		await as(env, ROBIN).setRole({ workspaceId, userId: KAI, role: "build" });
		expect((await as(env, ZOE).open({ workspaceId })).role).toBe("build");
		const listed = await as(env, ROBIN).list({ workspaceId });
		expect(listed.collaborators.find((c) => c.userId === KAI)).toMatchObject({
			role: "build",
			addedBy: ["Robin"],
		});
	});

	it("edits a link's label and role in place, keeping its keys", async () => {
		const { env, sqlite, workspaceId } = await seed();
		const { link, key } = await as(env, ROBIN).createLink({
			workspaceId,
			role: "use",
			label: "Reviewers",
		});
		await as(env, LEE).open({ workspaceId, shareKey: key });
		await as(env, ROBIN).add({
			workspaceId,
			email: "kai@example.test",
			role: "build",
		});
		await expect(
			as(env, KAI).updateLink({ workspaceId, linkId: link.id, role: "build" }),
		).rejects.toMatchObject({ code: "FORBIDDEN" });

		const raised = await as(env, ROBIN).updateLink({
			workspaceId,
			linkId: link.id,
			role: "build",
			label: "Builders",
		});
		expect(raised.link).toMatchObject({
			id: link.id,
			role: "build",
			label: "Builders",
		});
		expect(raised).not.toHaveProperty("key");
		expect(raised.affected).toEqual([]);
		expect(
			sqlite.prepare("SELECT count(*) AS n FROM os_workspace_share_keys").get(),
		).toMatchObject({ n: 1 });
		expect((await as(env, LEE).open({ workspaceId })).role).toBe("build");
		expect((await as(env, ZOE).open({ workspaceId, shareKey: key })).role).toBe(
			"build",
		);

		const lowered = await as(env, ROBIN).updateLink({
			workspaceId,
			linkId: link.id,
			role: "use",
			label: null,
		});
		expect(lowered.link.label).toBeNull();
		expect(lowered.affected.map((a) => [a.userId, a.newRole])).toEqual([
			[LEE, "use"],
			[ZOE, "use"],
		]);

		await as(env, ROBIN).remove({
			workspaceId,
			target: { kind: "link", linkId: link.id },
		});
		await expect(
			as(env, ROBIN).updateLink({ workspaceId, linkId: link.id, role: "use" }),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
	});

	it("lets an organization admin, not any member, change roles in an organization workspace", async () => {
		const { env, sqlite } = createEnv();
		const { workspace } = await workspacesAs(env, ROBIN).workspaces.create({
			name: "Team space",
			visibility: "org",
		});
		const workspaceId = workspace.id;
		await as(env, ROBIN).add({
			workspaceId,
			email: "zoe@example.test",
			role: "build",
		});
		await expect(
			as(env, KAI).setRole({ workspaceId, userId: ZOE, role: "use" }),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		sqlite.exec(
			"UPDATE organization_members SET role = 'admin' WHERE id = 'm-kai'",
		);
		await as(env, KAI).setRole({ workspaceId, userId: ZOE, role: "use" });
		expect((await as(env, ZOE).access({ workspaceId })).role).toBe("use");
	});
});

describe("telling a person that a workspace was shared with them", () => {
	/** Turn push on, give everyone a device, and collect what is sent. */
	async function seedWithDevices() {
		const seeded = await seed();
		const env = {
			...seeded.env,
			VAPID_PUBLIC_KEY: "public",
			VAPID_PRIVATE_KEY: "private",
			VAPID_SUBJECT: "mailto:push@example.test",
		} as CloudflareEnv;
		const db = context(env, ROBIN).db;
		for (const [sub, organizationId] of [
			[ROBIN, "org-1"],
			[KAI, "org-1"],
			[ZOE, "org-2"],
			[LEE, "org-2"],
			[STRANGER, "org-2"],
		] as const) {
			const userId = `user-${sub}`;
			seeded.sqlite
				.prepare(
					"UPDATE organization_members SET user_id = ? WHERE descope_user_id = ?",
				)
				.run(userId, sub);
			await savePushConfig(
				db,
				{ organizationId, userId },
				"subscription:device",
				{
					endpoint: `https://fcm.googleapis.com/${sub}`,
					expirationTime: null,
					keys: { p256dh: "B".repeat(87), auth: "A".repeat(22) },
				},
			);
		}
		const sent: Array<{ endpoint: string; payload: Record<string, string> }> =
			[];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (endpoint: string, init: { body: string }) => {
				sent.push({ endpoint, payload: JSON.parse(init.body) });
				return new Response(null, { status: 201 });
			}),
		);
		onTestFinished(() => vi.unstubAllGlobals());
		return { ...seeded, env, sent };
	}

	it("sends one push to the invited person and to nobody else", async () => {
		const { env, workspaceId, sent } = await seedWithDevices();
		await as(env, ROBIN).add({
			workspaceId,
			email: "zoe@example.test",
			role: "use",
		});
		expect(sent).toEqual([
			{
				endpoint: `https://fcm.googleapis.com/${ZOE}`,
				payload: {
					title: "Robin shared Reddit research with you",
					body: "Open it in Tedix under Workspaces, Shared with you.",
					url: `/shared/workspace/${workspaceId}`,
					conversationId: `workspace:${workspaceId}`,
					tag: `share:${workspaceId}`,
				},
			},
		]);
		// Changing the role of someone who already has access is not news.
		await as(env, ROBIN).add({
			workspaceId,
			email: "zoe@example.test",
			role: "build",
		});
		expect(sent).toHaveLength(1);
	});

	it("tells nobody when the person was not added", async () => {
		const { env, workspaceId, sent } = await seedWithDevices();
		// Nobody with that email.
		await expect(
			as(env, ROBIN).add({
				workspaceId,
				email: "nobody@example.test",
				role: "use",
			}),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		// A stranger cannot hand out access, so Lee never hears the name.
		await expect(
			as(env, STRANGER).add({
				workspaceId,
				email: "lee@example.test",
				role: "use",
			}),
		).rejects.toMatchObject(DENIED);
		// Someone who may only use the workspace cannot give more than that.
		await as(env, ROBIN).add({
			workspaceId,
			email: "kai@example.test",
			role: "use",
		});
		sent.length = 0;
		await expect(
			as(env, KAI).add({
				workspaceId,
				email: "lee@example.test",
				role: "build",
			}),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		// The owner adding themselves is refused too.
		await expect(
			as(env, ROBIN).add({
				workspaceId,
				email: "robin@example.test",
				role: "use",
			}),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		expect(sent).toEqual([]);
		expect((await as(env, LEE).listShared({})).items).toEqual([]);
	});

	it("keeps the access when the push cannot be delivered or push is off", async () => {
		const { env, workspaceId, sent } = await seedWithDevices();
		vi.mocked(fetch).mockRejectedValueOnce(new Error("offline"));
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		onTestFinished(() => warn.mockRestore());
		await as(env, ROBIN).add({
			workspaceId,
			email: "zoe@example.test",
			role: "use",
		});
		expect(sent).toEqual([]);
		expect((await as(env, ZOE).open({ workspaceId })).role).toBe("use");
		// With no push keys installed nothing is sent, and the list still says New.
		const off = { ...env, VAPID_PRIVATE_KEY: undefined } as CloudflareEnv;
		await as(off, ROBIN).add({
			workspaceId,
			email: "lee@example.test",
			role: "use",
		});
		expect(sent).toEqual([]);
		expect((await as(off, LEE).listShared({})).items).toMatchObject([
			{ workspaceId, isNew: true },
		]);
	});

	it("takes a never-opened workspace off the list when the access is taken back", async () => {
		const { env, workspaceId } = await seedWithDevices();
		await as(env, ROBIN).add({
			workspaceId,
			email: "zoe@example.test",
			role: "use",
		});
		expect((await as(env, ZOE).listShared({})).items).toHaveLength(1);
		await as(env, ROBIN).remove({
			workspaceId,
			target: { kind: "user", userId: ZOE },
		});
		expect((await as(env, ZOE).listShared({})).items).toEqual([]);
	});
});

describe("leaving a workspace", () => {
	it("lets an invited person leave: their access ends and it drops off their list", async () => {
		const { env, sqlite, workspaceId } = await seed();
		await as(env, ROBIN).add({
			workspaceId,
			email: "zoe@example.test",
			role: "use",
		});
		await as(env, ZOE).open({ workspaceId });
		// Someone who can only use the workspace may still leave it.
		expect(await as(env, ZOE).access({ workspaceId })).toEqual({
			role: "use",
			leave: "allowed",
		});
		expect(await as(env, ZOE).leave({ workspaceId })).toEqual({ left: true });
		await expect(as(env, ZOE).open({ workspaceId })).rejects.toMatchObject(
			DENIED,
		);
		expect((await as(env, ZOE).listShared({})).items).toEqual([]);
		expect(
			sqlite
				.prepare(
					"SELECT count(*) AS n FROM os_workspace_access_edges WHERE target_user_id = ?",
				)
				.get(ZOE),
		).toMatchObject({ n: 0 });
		expect((await as(env, ROBIN).list({ workspaceId })).collaborators).toEqual(
			[],
		);
		// Leaving twice is refused like any other call from outside.
		await expect(as(env, ZOE).leave({ workspaceId })).rejects.toMatchObject(
			DENIED,
		);
	});

	it("takes the access a leaver gave to others with them, and says so first", async () => {
		const { env, workspaceId } = await seed();
		await as(env, ROBIN).add({
			workspaceId,
			email: "kai@example.test",
			role: "build",
		});
		await as(env, KAI).add({
			workspaceId,
			email: "zoe@example.test",
			role: "use",
		});
		await as(env, ROBIN).add({
			workspaceId,
			email: "lee@example.test",
			role: "use",
		});
		const preview = await as(env, KAI).previewRemove({
			workspaceId,
			target: { kind: "user", userId: KAI },
		});
		expect(
			preview.affected.map((person) => [person.userId, person.newRole]),
		).toEqual([
			[KAI, null],
			[ZOE, null],
		]);
		// The same removal call, aimed at yourself, is leaving.
		await as(env, KAI).remove({
			workspaceId,
			target: { kind: "user", userId: KAI },
		});
		await expect(as(env, KAI).open({ workspaceId })).rejects.toMatchObject(
			DENIED,
		);
		await expect(as(env, ZOE).open({ workspaceId })).rejects.toMatchObject(
			DENIED,
		);
		// Someone the owner invited is untouched.
		expect((await as(env, LEE).open({ workspaceId })).role).toBe("use");
	});

	it("refuses the owner", async () => {
		const { env, workspaceId } = await seed();
		expect((await as(env, ROBIN).access({ workspaceId })).leave).toBe("owner");
		await expect(as(env, ROBIN).leave({ workspaceId })).rejects.toMatchObject({
			code: "BAD_REQUEST",
			message: "You own this workspace, so you can't leave it",
		});
		await expect(
			as(env, ROBIN).remove({
				workspaceId,
				target: { kind: "user", userId: ROBIN },
			}),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		expect((await as(env, ROBIN).open({ workspaceId })).isOwner).toBe(true);
	});

	it("refuses someone whose access comes from the whole organization", async () => {
		const { env } = createEnv();
		const { workspace } = await workspacesAs(env, ROBIN).workspaces.create({
			name: "Team space",
			visibility: "org",
		});
		const workspaceId = workspace.id;
		expect((await as(env, KAI).access({ workspaceId })).leave).toBe(
			"organization",
		);
		await expect(as(env, KAI).leave({ workspaceId })).rejects.toMatchObject({
			code: "BAD_REQUEST",
			message:
				"Everyone in the organization has access to this workspace, so you can't leave it",
		});
		expect((await as(env, KAI).open({ workspaceId })).role).toBe("build");
		// A guest from another organization, invited by name, can leave it.
		await as(env, ROBIN).add({
			workspaceId,
			email: "zoe@example.test",
			role: "use",
		});
		expect((await as(env, ZOE).access({ workspaceId })).leave).toBe("allowed");
		await as(env, ZOE).leave({ workspaceId });
		await expect(as(env, ZOE).open({ workspaceId })).rejects.toMatchObject(
			DENIED,
		);
	});

	it("refuses someone who joined through a share link until the link is off", async () => {
		const { env, workspaceId } = await seed();
		const { link, key } = await as(env, ROBIN).createLink({
			workspaceId,
			role: "use",
		});
		await as(env, ZOE).open({ workspaceId, shareKey: key });
		// Invited by name as well: the link would still let her straight back in.
		await as(env, ROBIN).add({
			workspaceId,
			email: "zoe@example.test",
			role: "use",
		});
		expect((await as(env, ZOE).access({ workspaceId })).leave).toBe("link");
		await expect(as(env, ZOE).leave({ workspaceId })).rejects.toMatchObject({
			code: "BAD_REQUEST",
			message:
				"You have access through a share link, so leaving wouldn't remove it. Ask the owner to turn the link off",
		});
		expect((await as(env, ZOE).open({ workspaceId })).role).toBe("use");
		expect((await as(env, ZOE).listShared({})).items).toHaveLength(1);

		await as(env, ROBIN).remove({
			workspaceId,
			target: { kind: "link", linkId: link.id },
		});
		expect((await as(env, ZOE).access({ workspaceId })).leave).toBe("allowed");
		await as(env, ZOE).leave({ workspaceId });
		await expect(as(env, ZOE).open({ workspaceId })).rejects.toMatchObject(
			DENIED,
		);
	});

	it("never lets leaving remove anyone else", async () => {
		const { env, workspaceId } = await seed();
		for (const email of ["zoe@example.test", "lee@example.test"])
			await as(env, ROBIN).add({ workspaceId, email, role: "use" });
		// A use collaborator cannot remove another person.
		await expect(
			as(env, ZOE).remove({
				workspaceId,
				target: { kind: "user", userId: LEE },
			}),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		await expect(
			as(env, ZOE).previewRemove({
				workspaceId,
				target: { kind: "user", userId: LEE },
			}),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		// A build collaborator cannot remove someone they did not add.
		await as(env, ROBIN).add({
			workspaceId,
			email: "kai@example.test",
			role: "build",
		});
		await expect(
			as(env, KAI).remove({
				workspaceId,
				target: { kind: "user", userId: LEE },
			}),
		).rejects.toMatchObject({
			code: "FORBIDDEN",
			message: "You can only remove people you added",
		});
		// Someone with no access learns nothing and removes nothing.
		await expect(
			as(env, STRANGER).leave({ workspaceId }),
		).rejects.toMatchObject(DENIED);
		await expect(
			as(env, STRANGER).remove({
				workspaceId,
				target: { kind: "user", userId: LEE },
			}),
		).rejects.toMatchObject(DENIED);
		expect((await as(env, LEE).open({ workspaceId })).role).toBe("use");
	});
});

describe("people suggestions for invites", () => {
	function teamReader(env: CloudflareEnv, sub: string, permissions: string[]) {
		const base = context(env, sub);
		return createRouterClient(osCollaboratorsContractRouter, {
			context: {
				...base,
				user: { ...base.user, permissions },
			} as BaseContext,
		});
	}

	it("finds people by part of a name or email, in the caller's organization only", async () => {
		const { env, sqlite } = createEnv();
		sqlite.exec(`
			INSERT INTO organization_members (id, organization_id, descope_user_id, email, name, role, status, kind)
			VALUES ('m-kira','org-1','member-kira','kira@example.test','Kira Fictional','member','active','human'),
			       ('m-kit','org-1','member-kit','kit@example.test','Kit Invited','member','invited','human'),
			       ('m-kbot','org-1','member-kbot','kbot@example.test','Kai Helper','member','active','external_agent'),
			       ('m-kay','org-2','member-kay','kay@example.test','Kai Elsewhere','member','active','human');
		`);
		const robin = teamReader(env, ROBIN, ["team:read"]);
		// A name match, case-insensitive: only active people, never agents, never org-2.
		expect((await robin.suggestPeople({ query: "KAI" })).people).toEqual([
			{
				userId: KAI,
				email: "kai@example.test",
				name: "Kai",
				principalKind: "user",
			},
		]);
		// An email match.
		expect(
			(await robin.suggestPeople({ query: "kira@" })).people.map(
				(person) => person.userId,
			),
		).toEqual(["member-kira"]);
		// The caller is never suggested to themselves.
		expect((await robin.suggestPeople({ query: "robin" })).people).toEqual([]);
		// Someone from the other organization sees their own colleagues only.
		expect(
			(
				await teamReader(env, ZOE, ["team:read"]).suggestPeople({
					query: "kai",
				})
			).people,
		).toEqual([
			{
				principalKind: "user",
				userId: "member-kay",
				email: "kay@example.test",
				name: "Kai Elsewhere",
			},
		]);
	});

	it("matches the typed text as written and keeps to the limit", async () => {
		const { env } = createEnv();
		const zoe = teamReader(env, ZOE, ["team:read"]);
		// % and _ are not wildcards.
		expect((await zoe.suggestPeople({ query: "%" })).people).toEqual([]);
		expect((await zoe.suggestPeople({ query: "l_e" })).people).toEqual([]);
		const everyone = await zoe.suggestPeople({ query: "example.test" });
		expect(everyone.people.map((person) => person.name)).toEqual([
			"Lee",
			"Sam",
		]);
		expect(
			(await zoe.suggestPeople({ query: "example.test", limit: 1 })).people,
		).toHaveLength(1);
	});

	it("needs the permission the Team page needs, and a signed-in person", async () => {
		const { env } = createEnv();
		await expect(
			teamReader(env, ROBIN, ["os:read"]).suggestPeople({ query: "kai" }),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		const base = context(env, ROBIN);
		const noOrganization = createRouterClient(osCollaboratorsContractRouter, {
			context: {
				...base,
				organizationId: undefined,
				user: { ...base.user, permissions: ["team:read"] },
			} as BaseContext,
		});
		await expect(
			noOrganization.suggestPeople({ query: "kai" }),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
	});
});
