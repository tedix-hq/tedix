/**
 * Workspace collaborators end to end over D1: direct adds, share links, the
 * live permission graph, lazy revocation, and the role-scoped capability.
 * People in two fictional organizations; the workspace is private to Robin.
 */
import { DatabaseSync } from "node:sqlite";
import { createRouterClient } from "@orpc/server";
import { createDbClient } from "@tedix/db/client";
import { auditEvents } from "@tedix/db/schema/audit-events";
import { organizationMembers } from "@tedix/db/schema/organization-members";
import {
	osWorkspaceAccessEdges,
	osWorkspaceCollaborators,
	osWorkspaceShareKeys,
	osWorkspaceShareLinks,
} from "@tedix/db/schema/os-collaborators";
import { osShareLinks } from "@tedix/db/schema/os-shares";
import {
	osGadgetRevisions,
	osCollaborationProposals,
	osGadgets,
	osWorkspaces,
} from "@tedix/db/schema/os-workspaces";
import { tedis } from "@tedix/db/schema/tedis";
import { userConfigs } from "@tedix/db/schema/user-configs";
import { createD1Facade } from "@tedix/db/test/d1-facade";
import { schemaDdl } from "@tedix/db/test/schema-ddl";
import { describe, expect, it, onTestFinished } from "vite-plus/test";
import type { BaseContext } from "../orpc";
import { osCollaboratorsContractRouter } from "./os-collaborators";
import { osWorkspacesContractRouter } from "./os-workspaces";

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
			osWorkspaces,
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
		),
	);
	sqlite.exec(`
		CREATE TABLE organizations (id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL);
		INSERT INTO organizations (id, name) VALUES ('org-1', 'Fictional Org'), ('org-2', 'Other Fictional Org');
		INSERT INTO organization_members (id, organization_id, descope_user_id, email, name, role, status)
		VALUES ('m-robin','org-1','member-robin','robin@example.test','Robin','member','active'),
		       ('m-kai','org-1','member-kai','kai@example.test','Kai','member','active'),
		       ('m-zoe','org-2','member-zoe','zoe@example.test','Zoe','member','active'),
		       ('m-lee','org-2','member-lee','lee@example.test','Lee','member','active'),
		       ('m-sam','org-2','member-sam','sam@example.test','Sam','member','active');
	`);
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

		await expect(as(env, ZOE).list({ workspaceId })).rejects.toMatchObject({
			code: "FORBIDDEN",
		});
		await expect(
			as(env, ZOE).add({ workspaceId, email: "lee@example.test", role: "use" }),
		).rejects.toMatchObject({ code: "FORBIDDEN" });

		const kai = await as(env, KAI).open({ workspaceId });
		expect(kai.role).toBe("build");
		expect(kai.capability.operations).toContain("sharing.write");
	});

	it("denies strangers without revealing the workspace", async () => {
		const { env, workspaceId } = await seed();
		await expect(as(env, STRANGER).open({ workspaceId })).rejects.toMatchObject(
			DENIED,
		);
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

	it("lists a shared workspace after first open, until dismissed", async () => {
		const { env, workspaceId } = await seed();
		await as(env, ROBIN).add({
			workspaceId,
			email: "zoe@example.test",
			role: "use",
		});
		expect((await as(env, ZOE).listShared({})).items).toEqual([]);
		await as(env, ZOE).open({ workspaceId });
		expect((await as(env, ZOE).listShared({})).items).toMatchObject([
			{ workspaceId, title: "Reddit research", ownerName: "Robin" },
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
});
