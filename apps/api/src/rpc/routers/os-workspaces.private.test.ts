import { eq } from "drizzle-orm";
import { createDbQueryClient } from "@tedix/db/query-client";
import { publishWorkspaceAction } from "@tedix/db/queries/workspace-feed/action-publication";
import { publishOutputProjection } from "@tedix/db/queries/workspace-feed/output-publication";
/**
 * Private workspaces: one member owns one; nobody else in the organization can
 * list, read, search, export or share it or its outputs. There is no admin
 * override (the same owner-only rule as personal resource delegations).
 */

import { DatabaseSync } from "node:sqlite";
import { createRouterClient } from "@orpc/server";
import { createDbClient } from "@tedix/db/client";
import { auditEvents } from "@tedix/db/schema/audit-events";
import { skillRuns, skillWorkflowSources } from "@tedix/db/schema/cognitive";
import { organizationMembers } from "@tedix/db/schema/organization-members";
import {
	osShareLinkInvitees,
	osShareLinks,
	osShareSessions,
} from "@tedix/db/schema/os-shares";
import {
	handleOsShareOpen,
	handleOsShareSessionOutput,
	handleOsShareSessionRead,
} from "../../lib/os-share-redemption";
import {
	osGadgetExecutions,
	osGadgetRevisions,
	osGadgets,
	osOutputRevisions,
	osOutputs,
	osWorkspaceResources,
	osWorkspaces,
	osWorkspaceSummaries,
} from "@tedix/db/schema/os-workspaces";
import { userConfigs } from "@tedix/db/schema/user-configs";
import { kernelRuntimeRuns } from "@tedix/db/schema/cognitive-runtime";
import {
	osWorkspaceAccessEdges,
	osWorkspaceCollaborators,
	osWorkspaceShareLinks,
} from "@tedix/db/schema/os-collaborators";
import {
	workspaceActivity,
	workspaceFeedCursors,
	workspaceFeedLedger,
	workspaceOutputIndex,
	workspaceWorkLinks,
} from "@tedix/db/schema/workspace-feed";
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
			osShareLinkInvitees,
			osWorkspaceCollaborators,
			osWorkspaceAccessEdges,
			osWorkspaceShareLinks,
			kernelRuntimeRuns,
			userConfigs,
			auditEvents,
			organizationMembers,
			osWorkspaceResources,
			osWorkspaceSummaries,
			skillRuns,
			skillWorkflowSources,
			workspaceFeedLedger,
			workspaceFeedCursors,
			workspaceActivity,
			workspaceOutputIndex,
			workspaceWorkLinks,
		),
	);
	sqlite.exec(`
		CREATE TABLE organizations (id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL, slug TEXT DEFAULT 'fictional', type TEXT DEFAULT 'organization', descope_tenant_id TEXT, logo_url TEXT, metadata TEXT);
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

	// The MCP gateway asks exactly this before forwarding `/mcp/workspaces/{id}`.
	it("shows the gateway's access check shared workspaces only, unless a tedi is named", async () => {
		const env = createEnv();
		const { workspace, team } = await seed(env);
		const gateway = (tediId?: string) =>
			createRouterClient(osWorkspacesContractRouter, {
				context: {
					db: createDbClient(env.DB),
					env,
					organizationId: "org-1",
					url: new URL(
						"https://api.tedix.test/rpc/osWorkspaces/workspaces/get",
					),
					headers: new Headers({
						"X-Service-Binding": "true",
						"X-Tedix-Tedi-Scopes": "apps:read",
						...(tediId ? { "X-Tedix-Tedi-Id": tediId } : {}),
					}),
				} as BaseContext,
			});
		await expect(
			gateway().workspaces.get({ workspaceId: team.id }),
		).resolves.toMatchObject({ workspace: { id: team.id } });
		await expect(
			gateway().workspaces.get({ workspaceId: workspace.id }),
		).rejects.toMatchObject(notFound);
		await expect(
			gateway("kai-primary").workspaces.get({ workspaceId: workspace.id }),
		).rejects.toMatchObject(notFound);
		await expect(
			gateway("robin-primary").workspaces.get({ workspaceId: workspace.id }),
		).resolves.toMatchObject({ workspace: { id: workspace.id } });
	});

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

	it("has no link of its own, but its owner shares one file from it", async () => {
		const env = createEnv();
		const { workspace, output } = await seed(env);
		const owner = shares(env, OWNER);
		await expect(
			owner.shares.create({
				resourceType: "workspace",
				resourceId: workspace.id,
				role: "use",
			}),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		const { share } = await owner.shares.create({
			resourceType: "output",
			resourceId: output.id,
		});
		expect(share).toMatchObject({ access: "anyone_with_link", role: "viewer" });
		expect(share.stoppedByPrivateWorkspace).toBeUndefined();

		const db = createDbQueryClient(env.DB);
		const opened = await handleOsShareOpen(db, share.publicId, "org-1");
		expect(opened.status).toBe(200);
		const body = (await opened.json()) as {
			sessionToken: string;
			resource: Record<string, unknown>;
		};
		expect(body.resource).toMatchObject({
			type: "output",
			output: { id: output.id },
		});
		// The visitor holds one file: no listing, and no sibling by id.
		expect(body.resource).not.toHaveProperty("files");
		expect(body.resource).not.toHaveProperty("gadgets");
		const { output: sibling } = await member(env, OWNER).outputs.create({
			kind: "document",
			title: "Sibling notes",
			workspaceId: workspace.id,
			content: { kind: "document", blocks: [] },
		});
		expect(
			(await handleOsShareSessionOutput(db, body.sessionToken, sibling.id))
				.status,
		).toBe(404);
		expect(
			(await handleOsShareSessionOutput(db, body.sessionToken, output.id))
				.status,
		).toBe(404);
		// Another organization's host never answers for it.
		expect((await handleOsShareOpen(db, share.publicId, "org-2")).status).toBe(
			404,
		);

		// Turning the link off closes the open session and the address.
		await owner.shares.setDisabled({ shareId: share.id, disabled: true });
		expect((await handleOsShareSessionRead(db, body.sessionToken)).status).toBe(
			404,
		);
		expect((await handleOsShareOpen(db, share.publicId, "org-1")).status).toBe(
			404,
		);
		await owner.shares.setDisabled({ shareId: share.id, disabled: false });
		expect((await handleOsShareOpen(db, share.publicId, "org-1")).status).toBe(
			200,
		);
		await owner.shares.revoke({ shareId: share.id });
		expect((await handleOsShareOpen(db, share.publicId, "org-1")).status).toBe(
			404,
		);
	});

	it("keeps a file's link from everyone who does not run the workspace", async () => {
		const env = createEnv();
		const { output } = await seed(env);
		const { share } = await shares(env, OWNER).shares.create({
			resourceType: "output",
			resourceId: output.id,
			access: "invited",
		});
		for (const outsider of [
			shares(env, OTHER),
			createRouterClient(osSharesContractRouter, {
				context: context(env, ADMIN, {
					permissions: ["settings:manage"],
					userRole: "admin",
				}),
			}),
		]) {
			const scope = { shareId: share.id };
			await expect(
				outsider.shares.list({
					resourceType: "output",
					resourceId: output.id,
				}),
			).rejects.toMatchObject(notFound);
			await expect(outsider.shares.previewRevoke(scope)).rejects.toMatchObject(
				notFound,
			);
			await expect(outsider.shares.revoke(scope)).rejects.toMatchObject(
				notFound,
			);
			await expect(
				outsider.shares.setDisabled({ ...scope, disabled: true }),
			).rejects.toMatchObject(notFound);
			await expect(
				outsider.shares.update({ ...scope, access: "anyone_with_link" }),
			).rejects.toMatchObject(notFound);
			await expect(
				outsider.shares.restrict({ ...scope, maxRole: "viewer", reason: "x" }),
			).rejects.toMatchObject(notFound);
			await expect(outsider.shares.delete(scope)).rejects.toMatchObject(
				notFound,
			);
			await expect(outsider.shares.invitees.list(scope)).rejects.toMatchObject(
				notFound,
			);
			await expect(
				outsider.shares.invitees.add({ ...scope, email: "kai@example.test" }),
			).rejects.toMatchObject(notFound);
		}
		const [row] = await createDbQueryClient(env.DB)
			.select()
			.from(osShareLinks)
			.where(eq(osShareLinks.id, share.id));
		expect(row).toMatchObject({
			access: "invited",
			revokedAt: null,
			disabledAt: null,
			standalone: true,
		});
	});

	it("lets the owner, without an admin role, choose and narrow who a file's link reaches", async () => {
		const env = createEnv();
		const { output } = await seed(env);
		const owner = createRouterClient(osSharesContractRouter, {
			context: context(env, OWNER, { permissions: ["os:read", "os:author"] }),
		});
		const { share } = await owner.shares.create({
			resourceType: "output",
			resourceId: output.id,
		});
		const db = createDbQueryClient(env.DB);
		const visitor = (await (
			await handleOsShareOpen(db, share.publicId, "org-1")
		).json()) as { sessionToken: string };
		await expect(
			owner.shares.update({ shareId: share.id, access: "invited" }),
		).resolves.toMatchObject({
			share: { access: "invited" },
			revokedSessionCount: 1,
		});
		// The signed-out visitor is cut off; only an invited person opens it.
		expect(
			(await handleOsShareSessionRead(db, visitor.sessionToken)).status,
		).toBe(404);
		const { invitee } = await owner.shares.invitees.add({
			shareId: share.id,
			email: "guest@example.test",
		});
		const asGuest = async () => ({
			userId: "guest-user",
			email: "guest@example.test",
		});
		const stranger = async () => ({
			userId: "stranger",
			email: "stranger@example.test",
		});
		const open = (identify?: typeof asGuest) =>
			handleOsShareOpen(db, share.publicId, "org-1", undefined, identify);
		expect((await open(stranger)).status).toBe(404);
		const invited = await open(asGuest);
		expect(invited.status).toBe(200);
		const session = ((await invited.json()) as { sessionToken: string })
			.sessionToken;
		// A removed person loses the file on their next read.
		await owner.shares.invitees.remove({
			shareId: share.id,
			inviteeId: invitee.id,
		});
		expect(
			(await handleOsShareSessionRead(db, session, undefined, asGuest)).status,
		).toBe(404);
		expect((await open(asGuest)).status).toBe(404);
	});

	it("previews who loses and gains access, and the change then does exactly that", async () => {
		const env = createEnv();
		const { output } = await seed(env);
		const owner = createRouterClient(osSharesContractRouter, {
			context: context(env, OWNER, { permissions: ["os:read", "os:author"] }),
		});
		const { share } = await owner.shares.create({
			resourceType: "output",
			resourceId: output.id,
		});
		const nobody = { people: 0, organization: false, anyoneWithLink: false };
		const db = createDbQueryClient(env.DB);
		const signedOut = () => handleOsShareOpen(db, share.publicId, "org-1");
		const visitor = (await (await signedOut()).json()) as {
			sessionToken: string;
		};
		// Kai is an organization member outside the workspace; the guest is not.
		const { invitee: kai } = await owner.shares.invitees.add({
			shareId: share.id,
			email: "kai@example.test",
		});
		await owner.shares.invitees.add({
			shareId: share.id,
			email: "guest@example.test",
		});
		const preview = (
			change: Parameters<typeof owner.shares.previewChange>[0]["change"],
		) => owner.shares.previewChange({ shareId: share.id, change });

		await expect(
			preview({ kind: "access", access: "invited" }),
		).resolves.toEqual({
			loses: { ...nobody, anyoneWithLink: true },
			gains: nobody,
			remaining: { ...nobody, people: 2 },
			keepThroughWorkspace: 0,
			openNow: 1,
		});
		// A preview changes nothing.
		expect(
			(await handleOsShareSessionRead(db, visitor.sessionToken)).status,
		).toBe(200);
		await owner.shares.update({ shareId: share.id, access: "invited" });
		expect((await signedOut()).status).toBe(200);
		expect(await (await signedOut()).json()).toMatchObject({
			needsEmailCode: true,
		});
		expect(
			(await handleOsShareSessionRead(db, visitor.sessionToken)).status,
		).toBe(404);

		await expect(
			preview({ kind: "removeInvitee", inviteeId: kai.id }),
		).resolves.toMatchObject({
			loses: { ...nobody, people: 1 },
			remaining: { ...nobody, people: 1 },
			openNow: 0,
		});
		await expect(
			preview({ kind: "access", access: "organization" }),
		).resolves.toMatchObject({
			loses: { ...nobody, people: 1 },
			gains: { ...nobody, organization: true },
		});
		await expect(preview({ kind: "off" })).resolves.toMatchObject({
			loses: { ...nobody, people: 2 },
			gains: nobody,
			remaining: nobody,
		});
		await owner.shares.setDisabled({ shareId: share.id, disabled: true });
		await expect(preview({ kind: "off" })).resolves.toMatchObject({
			loses: nobody,
		});
		await expect(preview({ kind: "on" })).resolves.toMatchObject({
			loses: nobody,
			gains: { ...nobody, people: 2 },
		});

		// Nobody outside the workspace can ask, admin or not.
		for (const outsider of [
			shares(env, OTHER),
			createRouterClient(osSharesContractRouter, {
				context: context(env, ADMIN, {
					permissions: ["settings:manage"],
					userRole: "admin",
				}),
			}),
		])
			await expect(
				outsider.shares.previewChange({
					shareId: share.id,
					change: { kind: "off" },
				}),
			).rejects.toMatchObject(notFound);
		await expect(
			createRouterClient(osSharesContractRouter, {
				context: context(env, OWNER, { permissions: ["os:read"] }),
			}).shares.previewChange({ shareId: share.id, change: { kind: "off" } }),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
	});

	it("does not count an invited person who is in the workspace as losing access", async () => {
		const env = createEnv();
		const { teamOutput } = await seed(env);
		const owner = shares(env, OWNER);
		const { share } = await owner.shares.create({
			resourceType: "output",
			resourceId: teamOutput.id,
			access: "invited",
		});
		await owner.shares.invitees.add({
			shareId: share.id,
			email: "kai@example.test",
		});
		await owner.shares.invitees.add({
			shareId: share.id,
			email: "guest@example.test",
		});
		// Kai opens the organization's workspace anyway; only the guest loses.
		await expect(
			owner.shares.previewChange({
				shareId: share.id,
				change: { kind: "off" },
			}),
		).resolves.toMatchObject({
			loses: { people: 1, organization: false, anyoneWithLink: false },
			keepThroughWorkspace: 1,
		});
	});

	it("keeps a link made before the workspace turned private off until its owner turns it on", async () => {
		const env = createEnv();
		const { team, teamOutput } = await seed(env);
		const owner = shares(env, OWNER);
		const { share } = await owner.shares.create({
			resourceType: "output",
			resourceId: teamOutput.id,
		});
		const { share: workspaceShare } = await owner.shares.create({
			resourceType: "workspace",
			resourceId: team.id,
			role: "use",
		});
		const db = createDbQueryClient(env.DB);
		const open = (publicId: string) => handleOsShareOpen(db, publicId, "org-1");
		expect((await open(share.publicId)).status).toBe(200);
		await member(env, OWNER).workspaces.update({
			workspaceId: team.id,
			visibility: "private",
		});
		expect((await open(share.publicId)).status).toBe(404);
		expect((await open(workspaceShare.publicId)).status).toBe(404);
		await expect(
			owner.shares.list({ resourceType: "output", resourceId: teamOutput.id }),
		).resolves.toMatchObject({
			items: [{ id: share.id, stoppedByPrivateWorkspace: true }],
		});
		// Only the owner's own choice revives it; the workspace link stays shut.
		await expect(
			shares(env, OTHER).shares.setDisabled({
				shareId: share.id,
				disabled: false,
			}),
		).rejects.toMatchObject(notFound);
		expect((await open(share.publicId)).status).toBe(404);
		const on = await owner.shares.setDisabled({
			shareId: share.id,
			disabled: false,
		});
		expect(on.share.stoppedByPrivateWorkspace).toBeUndefined();
		expect((await open(share.publicId)).status).toBe(200);
		await owner.shares.setDisabled({
			shareId: workspaceShare.id,
			disabled: false,
		});
		expect((await open(workspaceShare.publicId)).status).toBe(404);
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

it("keeps a fictional member's private Inbox and Social sources out of every other viewer's deck inputs", async () => {
	const env = createEnv();
	const owner = member(env, OWNER);
	const other = member(env, OTHER);
	const admin = member(env, ADMIN, {
		permissions: ["os:read", "os:author", "os:admin", "settings:manage"],
		userRole: "owner",
	});
	const spaces: string[] = [];
	const outputs: string[] = [];
	for (const name of ["Inbox", "Social"]) {
		const { workspace } = await owner.workspaces.create({
			name,
			visibility: "private",
		});
		spaces.push(workspace.id);
		const { output } = await owner.outputs.create({
			kind: "sheet",
			workspaceId: workspace.id,
			title: `Cards ${name}`,
			content: {
				kind: "sheet",
				columns: ["Source", "Why", "Useful", "Reason", "Done", "Result"],
				rows: [
					[
						`${name} private proposal`,
						`Only Robin decides this`,
						true,
						"",
						false,
						"",
					],
				],
			},
		});
		outputs.push(output.id);
	}
	const owned = (await owner.workspaces.list({ limit: 50 })).items.map(
		(w) => w.id,
	);
	for (const id of spaces) expect(owned).toContain(id);
	for (const viewer of [other, admin]) {
		const visible = (await viewer.workspaces.list({ limit: 50 })).items.map(
			(w) => w.id,
		);
		expect(spaces.filter((id) => visible.includes(id))).toEqual([]);
		for (const workspaceId of spaces) {
			await expect(
				viewer.workspaces.get({ workspaceId }),
			).rejects.toMatchObject(notFound);
			await expect(
				viewer.outputs.list({ workspaceId, limit: 50 }),
			).rejects.toMatchObject(notFound);
		}
		for (const outputId of outputs)
			await expect(viewer.outputs.get({ outputId })).rejects.toMatchObject(
				notFound,
			);
	}
});

it("filters recorded workspace activity on the server and preserves safe action provenance", async () => {
	const env = createEnv();
	const { workspace: privateWorkspace, team, teamOutput } = await seed(env);
	const db = createDbQueryClient(env.DB);
	// Shared-storage writes deliberately leave no object index. Model the object
	// publisher explicitly so this test exercises artifact provenance filtering.
	expect(await db.select().from(workspaceOutputIndex)).toEqual([]);
	const [output] = await db
		.select()
		.from(osOutputs)
		.where(eq(osOutputs.id, teamOutput.id));
	const [revision] = await db
		.select()
		.from(osOutputRevisions)
		.where(eq(osOutputRevisions.id, teamOutput.currentRevisionId!));
	await publishOutputProjection(db, output!, revision!);
	const publish = (workspaceId: string, id: string, revisionId?: string) =>
		publishWorkspaceAction(db, {
			organizationId: "org-1",
			workspaceId,
			kind: "run",
			id,
			revision: 1,
			actor: { kind: "external_agent", id: "agent-fixture" },
			changeRecordId: id,
			at: "2026-11-08T10:00:00Z",
			summary: {
				action: {
					resource: "output",
					operation: "revise",
					outcome: "applied",
					surface: "workspace_object",
					traceId: "turn-fixture",
					...(revisionId ? { revisionId } : {}),
				},
			},
		});
	await publish(privateWorkspace.id, "private-action");
	await publish(team.id, "team-action", teamOutput.currentRevisionId!);
	await publish(team.id, "missing-artifact", "missing-revision");
	await publish(team.id, "recorded-hold");
	const other = member(env, OTHER);
	const page = await other.workspaces.activity({ limit: 50 });
	expect(page.coverage).toBe("recorded_only");
	expect(page.items.some((item) => item.entityId === "private-action")).toBe(
		false,
	);
	expect(page.items.some((item) => item.entityId === "missing-artifact")).toBe(
		false,
	);
	expect(
		page.items.find((item) => item.entityId === "team-action"),
	).toMatchObject({
		actor: { kind: "external_agent", id: "agent-fixture" },
		changeRecordId: "team-action",
		action: { surface: "workspace_object", traceId: "turn-fixture" },
		artifact: {
			outputId: teamOutput.id,
			revisionId: teamOutput.currentRevisionId,
		},
	});
	expect(
		(
			await member(env, OWNER).workspaces.activity({
				workspaceId: privateWorkspace.id,
				limit: 50,
			})
		).items.some((item) => item.entityId === "private-action"),
	).toBe(true);
	await db
		.update(workspaceOutputIndex)
		.set({ accessEnvelope: null })
		.where(eq(workspaceOutputIndex.outputId, teamOutput.id));
	const restricted = await other.workspaces.activity({
		workspaceId: team.id,
		limit: 50,
	});
	expect(restricted.items.map((item) => item.entityId)).not.toContain(
		"team-action",
	);
	expect(restricted.items.map((item) => item.entityId)).not.toContain(
		teamOutput.id,
	);
	expect(restricted.items.map((item) => item.entityId)).toContain(
		"recorded-hold",
	);
});

async function publishHiddenActions(
	env: ReturnType<typeof createEnv>,
	workspaceId: string,
	count: number,
) {
	const db = createDbQueryClient(env.DB);
	for (let index = 0; index < count; index += 1) {
		await publishWorkspaceAction(db, {
			organizationId: "org-1",
			workspaceId,
			kind: "run",
			id: `page-${index}`,
			revision: 1,
			actor: { kind: "external_agent", id: "fixture-agent" },
			changeRecordId: `page-${index}`,
			at: "2026-11-08T10:00:00Z",
			summary: {
				action: {
					resource: "output",
					operation: "revise",
					outcome: "applied",
					surface: "workspace_object",
					// Only the oldest action links a revision the viewer can verify.
					...(index ? { revisionId: "unavailable" } : {}),
				},
			},
		});
	}
}

it("reads past hidden records so the first page shows visible activity", async () => {
	const env = createEnv();
	const owner = member(env, OWNER);
	const { workspace } = await owner.workspaces.create({ name: "History" });
	await publishHiddenActions(env, workspace.id, 7);
	const first = await owner.workspaces.activity({
		workspaceId: workspace.id,
		limit: 50,
	});
	expect(first.items.map((item) => item.entityId)).toEqual(["page-0"]);
	expect(first.next).toBeNull();
});

it("continues beyond an empty filtered page without skipping recorded activity", async () => {
	const env = createEnv();
	const owner = member(env, OWNER);
	const { workspace } = await owner.workspaces.create({ name: "History" });
	// More hidden records than one request reads before giving up.
	await publishHiddenActions(env, workspace.id, 22);
	const first = await owner.workspaces.activity({
		workspaceId: workspace.id,
		limit: 50,
	});
	expect(first.items).toEqual([]);
	expect(first.next).toBeTruthy();
	const second = await owner.workspaces.activity({
		workspaceId: workspace.id,
		limit: 50,
		before: first.next!,
	});
	expect(second.items.map((item) => item.entityId)).toEqual(["page-0"]);
	expect(second.next).toBeNull();
	expect(second.coverage).toBe("recorded_only");
});
