/**
 * Private workspaces: one member owns one; nobody else in the organization can
 * list, read, search, export or share it or its outputs. There is no admin
 * override (the same owner-only rule as personal resource delegations).
 */

import { DatabaseSync } from "node:sqlite";
import { createRouterClient } from "@orpc/server";
import { createDbClient } from "@tedix/db/client";
import { auditEvents } from "@tedix/db/schema/audit-events";
import { skillRuns } from "@tedix/db/schema/cognitive";
import { organizationMembers } from "@tedix/db/schema/organization-members";
import { osShareLinks, osShareSessions } from "@tedix/db/schema/os-shares";
import {
	osGadgetExecutions,
	osGadgetRevisions,
	osGadgets,
	osOutputRevisions,
	osOutputs,
	osWorkspaceResources,
	osWorkspaces,
} from "@tedix/db/schema/os-workspaces";
import { userConfigs } from "@tedix/db/schema/user-configs";
import { createD1Facade } from "@tedix/db/test/d1-facade";
import { schemaDdl } from "@tedix/db/test/schema-ddl";
import { describe, expect, it, onTestFinished } from "vite-plus/test";
import { tedis } from "@tedix/db/schema/tedis";
import { stripServiceBindingMarker } from "@tedix/worker-kit/request-auth";
import { isOsWorkspaceVisibleTo } from "@tedix/db/queries/os-workspaces/workspaces";
import { resolveOsWorkspaceViewer } from "../../services/os-workspace-visibility";
import type { BaseContext } from "../orpc";
import { osSharesContractRouter } from "./os-shares";
import { osWorkspacesContractRouter } from "./os-workspaces";

const OWNER = "member-robin";
const OTHER = "member-kai";
const ADMIN = "member-ada";

function createEnv(): CloudflareEnv {
	const sqlite = new DatabaseSync(":memory:");
	onTestFinished(() => sqlite.close());
	sqlite.exec("PRAGMA foreign_keys = OFF;");
	sqlite.exec(
		schemaDdl(
			tedis,
			osWorkspaces,
			osGadgets,
			osGadgetRevisions,
			osGadgetExecutions,
			osOutputs,
			osOutputRevisions,
			osShareLinks,
			osShareSessions,
			userConfigs,
			auditEvents,
			organizationMembers,
			osWorkspaceResources,
			skillRuns,
		),
	);
	sqlite.exec(`
		CREATE TABLE organizations (id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL);
		INSERT INTO organizations (id, name) VALUES ('org-1', 'Fictional Org');
		INSERT INTO tedis (id, organization_id, name, slug, status, scope, owner_user_id, descope_user_id)
		VALUES ('robin-primary','org-1','Robin helper','robin-primary','active','personal','member-robin','tedi-identity-1'),
		       ('kai-primary','org-1','Kai helper','kai-primary','active','personal','member-kai','tedi-identity-3'),
		       ('shared-org-tedi','org-1','Team helper','shared-org-tedi','active','organization',NULL,'tedi-identity-2');
		INSERT INTO organization_members (id, organization_id, descope_user_id, email, role, status)
		VALUES ('m-robin','org-1','member-robin','robin@example.test','member','active'),
		       ('m-kai','org-1','member-kai','kai@example.test','member','active'),
		       ('m-ada','org-1','member-ada','ada@example.test','admin','active'),
		       ('m-gone','org-1','member-gone','gone@example.test','member','deactivated');
	`);
	return {
		ENVIRONMENT: "test",
		API_URL: "https://api.tedix.test",
		DB: createD1Facade(sqlite),
	} as CloudflareEnv;
}

function context(
	env: CloudflareEnv,
	sub: string,
	options: { permissions?: string[]; userRole?: string } = {},
): BaseContext {
	return {
		authType: "user",
		db: createDbClient(env.DB) as BaseContext["db"],
		env,
		headers: new Headers(),
		organizationId: "org-1",
		url: new URL("https://api.tedix.test/rpc/os-workspaces"),
		user: {
			aud: "test",
			dct: "tenant-1",
			exp: 2,
			iat: 1,
			iss: "https://auth.tedix.test",
			permissions: options.permissions ?? ["os:read", "os:author", "os:admin"],
			roles: [],
			sub,
		},
		userRole: options.userRole,
	} as BaseContext;
}

function member(
	env: CloudflareEnv,
	sub: string,
	options?: Parameters<typeof context>[2],
) {
	return createRouterClient(osWorkspacesContractRouter, {
		context: context(env, sub, options),
	});
}

function shares(env: CloudflareEnv, sub: string) {
	return createRouterClient(osSharesContractRouter, {
		context: context(env, sub),
	});
}

async function seed(env: CloudflareEnv) {
	const owner = member(env, OWNER);
	const { workspace: team } = await owner.workspaces.create({ name: "Team" });
	const { workspace } = await owner.workspaces.create({
		name: "Robin (private)",
		visibility: "private",
	});
	const { output } = await owner.outputs.create({
		kind: "document",
		title: "What Tedix knows about you",
		workspaceId: workspace.id,
		content: {
			kind: "document",
			blocks: [{ type: "paragraph", text: "Works with Fictional Customer" }],
		},
	});
	const { output: teamOutput } = await owner.outputs.create({
		kind: "document",
		title: "Team notes",
		workspaceId: team.id,
		content: { kind: "document", blocks: [] },
	});
	return { workspace, output, team, teamOutput };
}

const notFound = { code: "NOT_FOUND" };

describe("private OS workspaces", () => {
	it("are created owned by the calling member and visible to them", async () => {
		const env = createEnv();
		const { workspace, output } = await seed(env);
		expect(workspace).toMatchObject({
			visibility: "private",
			ownerUserId: OWNER,
		});
		const owner = member(env, OWNER);
		const listed = await owner.workspaces.list({ limit: 50 });
		expect(listed.items.map((w) => w.name)).toContain("Robin (private)");
		await expect(
			owner.workspaces.get({ workspaceId: workspace.id }),
		).resolves.toMatchObject({ workspace: { id: workspace.id } });
		await expect(
			owner.outputs.get({ outputId: output.id }),
		).resolves.toMatchObject({ output: { id: output.id } });
		await expect(
			owner.outputs.patchDocument({
				outputId: output.id,
				ops: [
					{ op: "insert", index: 1, block: { type: "paragraph", text: "ok" } },
				],
			}),
		).resolves.toMatchObject({ revision: { revision: 2 } });
	});

	it.each([
		["another member", OTHER, {}],
		[
			"an organization admin",
			ADMIN,
			{ permissions: ["settings:manage"], userRole: "owner" },
		],
	] as const)(
		"are invisible to %s: list, read, search, write, export and share",
		async (_label, sub, options) => {
			const env = createEnv();
			const { workspace, output, teamOutput } = await seed(env);
			const other = member(env, sub, options);

			const listed = await other.workspaces.list({ limit: 50 });
			expect(listed.items.map((w) => w.id)).not.toContain(workspace.id);
			await expect(
				other.workspaces.get({ workspaceId: workspace.id }),
			).rejects.toMatchObject(notFound);

			const outputs = await other.outputs.list({ limit: 50 });
			expect(outputs.items.map((o) => o.id)).toEqual([teamOutput.id]);
			const library = await other.outputs.library({ limit: 50 });
			expect(library.items.map((item) => item.output.id)).toEqual([
				teamOutput.id,
			]);
			await expect(
				other.outputs.list({ workspaceId: workspace.id, limit: 50 }),
			).rejects.toMatchObject(notFound);
			await expect(
				other.outputs.get({ outputId: output.id }),
			).rejects.toMatchObject(notFound);
			await expect(
				other.outputs.export({ outputId: output.id, format: "pdf" }),
			).rejects.toMatchObject(notFound);
			await expect(
				other.outputs.patchDocument({
					outputId: output.id,
					ops: [{ op: "delete", index: 0 }],
				}),
			).rejects.toMatchObject(notFound);
			await expect(
				other.outputs.create({
					kind: "document",
					title: "Planted",
					workspaceId: workspace.id,
					content: { kind: "document", blocks: [] },
				}),
			).rejects.toMatchObject(notFound);
			await expect(
				other.workspaces.update({
					workspaceId: workspace.id,
					visibility: "org",
				}),
			).rejects.toMatchObject(notFound);
			await expect(
				other.workspaces.archive({ workspaceId: workspace.id }),
			).rejects.toMatchObject(notFound);
			await expect(
				other.gadgets.list({ workspaceId: workspace.id, limit: 50 }),
			).rejects.toMatchObject(notFound);
			await expect(
				shares(env, sub).shares.create({
					resourceType: "output",
					resourceId: output.id,
				}),
			).rejects.toMatchObject(notFound);
		},
	);

	it("ignores an acting-user header sent by an external member request", async () => {
		const env = createEnv();
		const { workspace, output } = await seed(env);
		const spoofed = context(env, OTHER);
		spoofed.headers.set("X-Tedix-Acting-User", OWNER);
		spoofed.headers.set("X-Tedix-End-User-Id", OWNER);
		const client = createRouterClient(osWorkspacesContractRouter, {
			context: spoofed,
		});
		await expect(
			client.workspaces.get({ workspaceId: workspace.id }),
		).rejects.toMatchObject(notFound);
		await expect(
			client.outputs.get({ outputId: output.id }),
		).rejects.toMatchObject(notFound);
		const listed = await client.workspaces.list({ limit: 50 });
		expect(listed.items.map((w) => w.id)).not.toContain(workspace.id);
	});

	it.each([
		{
			tediId: "robin-primary",
			actingUser: OWNER,
			publicIngress: false,
			allowed: true,
		},
		{
			tediId: "kai-primary",
			actingUser: OWNER,
			publicIngress: false,
			allowed: false,
		},
		{
			tediId: "robin-primary",
			actingUser: OTHER,
			publicIngress: false,
			allowed: false,
		},
		{
			tediId: "shared-org-tedi",
			actingUser: OWNER,
			publicIngress: false,
			allowed: false,
		},
		{
			tediId: "shared-org-tedi",
			actingUser: undefined,
			publicIngress: false,
			allowed: false,
		},
		{
			tediId: "robin-primary",
			actingUser: OWNER,
			publicIngress: true,
			allowed: false,
		},
	])(
		"checks the bound tedi and ingress before private reads ($tediId, $actingUser, public=$publicIngress)",
		async ({ tediId, actingUser, publicIngress, allowed }) => {
			const env = createEnv();
			const { workspace, output, teamOutput } = await seed(env);
			const request = new Request(
				"https://api.tedix.test/rpc/osWorkspaces/outputs/get",
				{
					headers: {
						"X-Service-Binding": "true",
						"X-Tedix-Tedi-Id": tediId,
						"X-Tedix-Tedi-Scopes": "apps:read apps:write",
						...(actingUser ? { "X-Tedix-Acting-User": actingUser } : {}),
					},
				},
			);
			const principal = publicIngress
				? context(env, OTHER)
				: ({
						db: createDbClient(env.DB),
						env,
						organizationId: "org-1",
						url: new URL(request.url),
					} as BaseContext);
			principal.headers = (
				publicIngress ? stripServiceBindingMarker(request) : request
			).headers;
			const client = createRouterClient(osWorkspacesContractRouter, {
				context: principal,
			});
			if (allowed) {
				await expect(
					client.workspaces.get({ workspaceId: workspace.id }),
				).resolves.toMatchObject({ workspace: { id: workspace.id } });
				await expect(
					client.outputs.get({ outputId: output.id }),
				).resolves.toMatchObject({ output: { id: output.id } });
			} else {
				await expect(
					client.workspaces.get({ workspaceId: workspace.id }),
				).rejects.toMatchObject(notFound);
				await expect(
					client.outputs.get({ outputId: output.id }),
				).rejects.toMatchObject(notFound);
				await expect(
					client.outputs.patchDocument({
						outputId: output.id,
						ops: [{ op: "delete", index: 0 }],
					}),
				).rejects.toMatchObject(notFound);
				expect(
					(await client.outputs.list({ limit: 50 })).items.map((o) => o.id),
				).toEqual([teamOutput.id]);
			}
		},
	);

	it("cannot be reached with an organization API key", async () => {
		const env = createEnv();
		const { workspace, output } = await seed(env);
		const client = createRouterClient(osWorkspacesContractRouter, {
			context: {
				apiKey: {
					id: "key-1",
					name: "automation",
					organizationId: "org-1",
					scopes: ["apps:read", "apps:write"],
				},
				authType: "apikey",
				db: createDbClient(env.DB) as BaseContext["db"],
				env,
				headers: new Headers(),
				organizationId: "org-1",
				url: new URL("https://api.tedix.test/rpc/os-workspaces"),
			} as BaseContext,
		});
		const listed = await client.workspaces.list({ limit: 50 });
		expect(listed.items.map((w) => w.id)).not.toContain(workspace.id);
		await expect(
			client.outputs.get({ outputId: output.id }),
		).rejects.toMatchObject(notFound);
		await expect(
			client.workspaces.create({ name: "Keyed", visibility: "private" }),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
	});

	it("cannot be shared by the owner either", async () => {
		const env = createEnv();
		const { workspace, output } = await seed(env);
		await expect(
			shares(env, OWNER).shares.create({
				resourceType: "output",
				resourceId: output.id,
			}),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		await expect(
			shares(env, OWNER).shares.create({
				resourceType: "workspace",
				resourceId: workspace.id,
				role: "use",
			}),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
	});

	it("can be made private only by the member who created it", async () => {
		const env = createEnv();
		const { team } = await seed(env);
		await expect(
			member(env, OTHER, {
				permissions: ["settings:manage"],
				userRole: "owner",
			}).workspaces.update({ workspaceId: team.id, visibility: "private" }),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		const owner = member(env, OWNER);
		await expect(
			owner.workspaces.update({ workspaceId: team.id, visibility: "private" }),
		).resolves.toMatchObject({
			workspace: { visibility: "private", ownerUserId: OWNER },
		});
		await expect(
			member(env, OTHER).workspaces.get({ workspaceId: team.id }),
		).rejects.toMatchObject(notFound);
		await expect(
			owner.workspaces.update({ workspaceId: team.id, visibility: "org" }),
		).resolves.toMatchObject({
			workspace: { visibility: "org", ownerUserId: null },
		});
		await expect(
			member(env, OTHER).workspaces.get({ workspaceId: team.id }),
		).resolves.toMatchObject({ workspace: { id: team.id } });
	});
});

describe("giving a workspace to a member", () => {
	const admin = (env: CloudflareEnv) =>
		member(env, ADMIN, { permissions: ["settings:manage"], userRole: "admin" });

	it("lets an organization admin give an org workspace to a member, then hides it from the admin", async () => {
		const env = createEnv();
		const { team } = await seed(env);
		await expect(
			admin(env).workspaces.update({
				workspaceId: team.id,
				visibility: "private",
				ownerUserId: OTHER,
			}),
		).resolves.toMatchObject({
			workspace: { visibility: "private", ownerUserId: OTHER },
		});
		await expect(
			admin(env).workspaces.get({ workspaceId: team.id }),
		).rejects.toMatchObject(notFound);
		await expect(
			member(env, OWNER).workspaces.get({ workspaceId: team.id }),
		).rejects.toMatchObject(notFound);
		await expect(
			member(env, OTHER).workspaces.get({ workspaceId: team.id }),
		).resolves.toMatchObject({ workspace: { id: team.id } });
	});

	it("lets the owner give their private workspace to another member", async () => {
		const env = createEnv();
		const { workspace } = await seed(env);
		await expect(
			member(env, OWNER).workspaces.update({
				workspaceId: workspace.id,
				ownerUserId: OTHER,
			}),
		).resolves.toMatchObject({
			workspace: { visibility: "private", ownerUserId: OTHER },
		});
		await expect(
			member(env, OWNER).workspaces.get({ workspaceId: workspace.id }),
		).rejects.toMatchObject(notFound);
	});

	it("refuses non-admins who did not create it, admins taking it for themselves, and inactive members", async () => {
		const env = createEnv();
		const { team } = await seed(env);
		const give = (sub: string, ownerUserId: string, admin = false) =>
			member(
				env,
				sub,
				admin ? { permissions: ["settings:manage"], userRole: "admin" } : {},
			).workspaces.update({
				workspaceId: team.id,
				visibility: "private",
				ownerUserId,
			});
		await expect(give(OTHER, OTHER)).rejects.toMatchObject({
			code: "FORBIDDEN",
		});
		await expect(give(ADMIN, ADMIN, true)).rejects.toMatchObject({
			code: "FORBIDDEN",
		});
		await expect(give(ADMIN, "member-gone", true)).rejects.toMatchObject({
			code: "BAD_REQUEST",
		});
		await expect(
			member(env, OWNER).workspaces.update({
				workspaceId: team.id,
				ownerUserId: OTHER,
			}),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		await expect(
			member(env, OTHER).workspaces.get({ workspaceId: team.id }),
		).resolves.toMatchObject({ workspace: { visibility: "org" } });
	});
});

describe("a scheduled skill run in a private workspace", () => {
	const RUN = "run-inbox-1";
	async function linkedWorkspace(env: CloudflareEnv) {
		const { workspace } = await seed(env);
		const db = createDbClient(env.DB);
		await db.insert(osWorkspaceResources).values({
			id: "link-inbox",
			organizationId: "org-1",
			workspaceId: workspace.id,
			providerId: "tedix",
			connectionScope: "tenant",
			resourceType: "skill",
			providerResourceId: "skill-inbox",
			name: "Inbox cards",
			createdByKind: "user",
			createdById: OWNER,
			createdAt: "2026-10-16T08:00:00.000Z",
			updatedAt: "2026-10-16T08:00:00.000Z",
		});
		await db.insert(skillRuns).values({
			id: RUN,
			organizationId: "org-1",
			skillId: "skill-inbox",
			tediId: "shared-org-tedi",
			workflowInstanceId: "wf-1",
			runtimeEnvironment: "test",
			status: "running",
		} as typeof skillRuns.$inferInsert);
		return { workspace, db };
	}
	function runViewer(env: CloudflareEnv, runId: string, tediId: string) {
		return resolveOsWorkspaceViewer({
			authType: "service-binding",
			db: createDbClient(env.DB) as BaseContext["db"],
			env,
			headers: new Headers({ "X-Tedix-Skill-Run-Id": runId }),
			organizationId: "org-1",
			tediId,
			url: new URL("https://api.tedix.test/rpc/os-workspaces"),
		} as BaseContext);
	}

	it("sees exactly the linked private workspace while the run is running", async () => {
		const env = createEnv();
		const { workspace } = await linkedWorkspace(env);
		const viewer = await runViewer(env, RUN, "shared-org-tedi");
		expect(viewer).toEqual({ userIds: [], workspaceIds: [workspace.id] });
		expect(isOsWorkspaceVisibleTo(workspace, viewer)).toBe(true);
		expect(
			isOsWorkspaceVisibleTo({ ...workspace, id: "ws-other" }, viewer),
		).toBe(false);
	});

	it("opens nothing for another tedi, an unknown run or a finished run", async () => {
		const env = createEnv();
		const { db } = await linkedWorkspace(env);
		await expect(runViewer(env, RUN, "kai-primary")).resolves.toEqual({
			userIds: [OTHER],
		});
		await expect(
			runViewer(env, "run-unknown", "shared-org-tedi"),
		).resolves.toEqual({ userIds: [] });
		await db.update(skillRuns).set({ status: "completed" });
		await expect(runViewer(env, RUN, "shared-org-tedi")).resolves.toEqual({
			userIds: [],
		});
	});
});

describe("private workspace viewer", () => {
	function base() {
		const env = createEnv();
		return {
			env,
			db: createDbClient(env.DB),
			url: new URL("https://api.tedix.test"),
			organizationId: "org-1",
		};
	}

	it("is the human on a user token, never a forwarded acting-user claim", async () => {
		await expect(
			resolveOsWorkspaceViewer({
				...base(),
				headers: new Headers({
					"X-Tedix-Acting-User": OWNER,
					"X-Tedix-End-User-Id": OWNER,
				}),
				authType: "user",
				user: { sub: OTHER },
				descopeUserId: OWNER,
			} as BaseContext),
		).resolves.toEqual({ userIds: [OTHER] });
	});

	it("is the acting member on a trusted Home/kernel call bound to their own tedi", async () => {
		await expect(
			resolveOsWorkspaceViewer({
				...base(),
				headers: new Headers(),
				authType: "service-binding",
				tediId: "robin-primary",
				descopeUserId: OWNER,
			} as BaseContext),
		).resolves.toEqual({ userIds: [OWNER] });
	});

	it("ignores an acting user the bound tedi does not belong to", async () => {
		for (const tediId of ["robin-primary", "shared-org-tedi"]) {
			await expect(
				resolveOsWorkspaceViewer({
					...base(),
					headers: new Headers(),
					authType: "service-binding",
					tediId,
					descopeUserId: tediId === "robin-primary" ? OTHER : OWNER,
				} as BaseContext),
			).resolves.toEqual({ userIds: [] });
		}
		await expect(
			resolveOsWorkspaceViewer({
				...base(),
				headers: new Headers(),
				authType: "service-binding",
				descopeUserId: OWNER,
			} as BaseContext),
		).resolves.toEqual({ userIds: [] });
	});

	it("is the owner of a personal tedi acting on its own", async () => {
		await expect(
			resolveOsWorkspaceViewer({
				...base(),
				headers: new Headers(),
				authType: "tedi",
				tediId: "robin-primary",
				descopeUserId: "tedi-identity-1",
			} as BaseContext),
		).resolves.toEqual({ userIds: [OWNER] });
	});

	it("is nobody for API keys and unattributed service calls", async () => {
		await expect(
			resolveOsWorkspaceViewer({
				...base(),
				headers: new Headers({ "X-Tedix-Acting-User": OWNER }),
				authType: "apikey",
			} as BaseContext),
		).resolves.toEqual({ userIds: [] });
	});
});
