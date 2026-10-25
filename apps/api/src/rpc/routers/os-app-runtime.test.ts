import { DatabaseSync } from "node:sqlite";
import { createRouterClient } from "@orpc/server";
import { createDbClient } from "@tedix/db/client";
import { createD1Facade } from "@tedix/db/test/d1-facade";
import { schemaDdl } from "@tedix/db/test/schema-ddl";
import {
	osWorkspaces,
	osGadgets,
	osGadgetRevisions,
	osGadgetCode,
	osGadgetExecutions,
	osWorkspaceResources,
	osOutputs,
	osOutputRevisions,
} from "@tedix/db/schema/os-workspaces";
import { organizations } from "@tedix/db/schema/organizations";
import { organizationMembers } from "@tedix/db/schema/organization-members";
import {
	osWorkspaceAccessEdges,
	osWorkspaceCollaborators,
	osWorkspaceShareLinks,
	osWorkspaceShareKeys,
} from "@tedix/db/schema/os-collaborators";
import { eq } from "drizzle-orm";
import { verifyWorkspaceAppSession } from "@tedix/auth/workspace-app-session";
import { describe, expect, it, vi, onTestFinished } from "vite-plus/test";
import { userContext, apiKeyContext } from "../test-context";
import { createOsAppRuntimeRouter } from "./os-app-runtime";

const workspaceId = "11111111-1111-4111-8111-111111111111";
const gadgetId = "22222222-2222-4222-8222-222222222222";
const revisionId = "33333333-3333-4333-8333-333333333333";
const previewId = "44444444-4444-4444-8444-444444444444";
const key = "fictional-api-app-key";
const scope = { workspaceId, gadgetId };

async function fixture() {
	const sqlite = new DatabaseSync(":memory:");
	onTestFinished(() => sqlite.close());
	sqlite.exec("PRAGMA foreign_keys = OFF");
	sqlite.exec(
		schemaDdl(
			osWorkspaces,
			osGadgets,
			osGadgetRevisions,
			osGadgetCode,
			osGadgetExecutions,
			osWorkspaceResources,
			osOutputs,
			osOutputRevisions,
			organizations,
			organizationMembers,
			osWorkspaceAccessEdges,
			osWorkspaceCollaborators,
			osWorkspaceShareLinks,
			osWorkspaceShareKeys,
		),
	);
	const facade = createD1Facade(sqlite);
	const db = createDbClient(facade);
	await db
		.insert(organizations)
		.values({ id: "org-1", name: "Fictional Org", slug: "fictional" });
	await db.insert(organizationMembers).values([
		{
			id: "member-1",
			organizationId: "org-1",
			descopeUserId: "user-1",
			email: "one@example.test",
			name: "One",
			role: "member",
			status: "active",
		},
		{
			id: "member-2",
			organizationId: "org-1",
			descopeUserId: "user-2",
			email: "two@example.test",
			name: "Two",
			role: "viewer",
			status: "active",
		},
	]);
	await db.insert(osWorkspaces).values({
		id: workspaceId,
		organizationId: "org-1",
		name: "Fictional apps",
		createdByKind: "user",
		createdById: "user-1",
	});
	await db.insert(osGadgets).values({
		id: gadgetId,
		organizationId: "org-1",
		workspaceId,
		name: "Counter",
		currentRevisionId: revisionId,
		createdByKind: "user",
		createdById: "user-1",
	});
	await db.insert(osGadgetRevisions).values({
		id: revisionId,
		organizationId: "org-1",
		gadgetId,
		revision: 1,
		manifest: JSON.stringify({
			entry: "tedix:runtime/v1",
			capabilities: [],
			resourceGrants: [{ slot: "sheet", operations: ["outputs.read"] }],
		}),
		createdByKind: "user",
		createdById: "user-1",
	});
	const fetch = vi.fn(async (_request: Request) => Response.json({ count: 1 }));
	const env = {
		ENVIRONMENT: "test",
		DB: facade,
		SECRETS_MASTER_KEY: key,
		TEDI_SERVICE: { fetch },
	} as unknown as CloudflareEnv;
	const files = { "server.js": "export class App {}", "client.js": "" };
	await db.insert(osGadgetCode).values({
		revisionId,
		organizationId: "org-1",
		gadgetId,
		files: JSON.stringify(files),
		codeLength: files["server.js"].length,
	});
	const router = createOsAppRuntimeRouter();
	const context = userContext({
		env,
		permissions: ["os:read", "os:author"],
		sub: "user-1",
	});
	const client = createRouterClient(router, { context });
	return { db, env, router, context, client, fetch };
}

describe("workspace app runtime API admission", () => {
	it("signs the resolved principal, role, pinned revision and manifest grants", async () => {
		const { client } = await fixture();
		const opened = await client.open(scope);
		expect(opened.role).toBe("build");
		expect(await verifyWorkspaceAppSession(key, opened.session)).toMatchObject({
			organizationId: "org-1",
			...scope,
			revisionId,
			principal: { kind: "user", id: "user-1" },
			grants: [{ slot: "sheet", operations: ["outputs.read"] }],
		});
	});
	it("forwards only stored code and the validated invocation over the runtime binding", async () => {
		const { client, fetch } = await fixture();
		const { session } = await client.open(scope);
		expect(
			await client.call({ ...scope, session, method: "count", args: [] }),
		).toEqual({ result: { count: 1 } });
		const request = fetch.mock.calls[0]![0] as Request;
		expect(new URL(request.url).pathname).toBe(
			"/__internal/workspace-app/call",
		);
		expect(request.headers.get("X-Service-Binding")).toBe("true");
		expect(await request.json()).toMatchObject({
			files: { "server.js": "export class App {}" },
			method: "count",
		});
	});
	it("rejects another tenant, workspace, caller and a tampered session before dispatch", async () => {
		const { client, router, env, fetch } = await fixture();
		const { session } = await client.open(scope);
		const otherTenant = createRouterClient(router, {
			context: userContext({
				env,
				organizationId: "org-2",
				sub: "stranger",
				permissions: ["os:read"],
			}),
		});
		await expect(otherTenant.open(scope)).rejects.toMatchObject({
			code: "FORBIDDEN",
		});
		const otherCaller = createRouterClient(router, {
			context: userContext({ env, sub: "user-2", permissions: ["os:read"] }),
		});
		await expect(
			otherCaller.call({ ...scope, session, method: "count", args: [] }),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		await expect(
			client.call({
				...scope,
				workspaceId: previewId,
				session,
				method: "count",
				args: [],
			}),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		await expect(
			client.call({
				...scope,
				session: session + "bad",
				method: "count",
				args: [],
			}),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(fetch).not.toHaveBeenCalled();
	});
	it("denies preview to use-only callers and machine read scopes", async () => {
		const { router, env } = await fixture();
		const reader = createRouterClient(router, {
			context: userContext({
				env,
				sub: "user-2",
				permissions: ["os:read", "os:author"],
			}),
		});
		expect((await reader.open(scope)).role).toBe("use");
		await expect(
			reader.preview({ ...scope, revisionId, previewId }),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		const machine = createRouterClient(router, {
			context: apiKeyContext({ env, scopes: ["apps:read"] }),
		});
		expect((await machine.open(scope)).role).toBe("use");
		await expect(
			machine.preview({ ...scope, revisionId, previewId }),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
	});
	it("pins a build preview to a separate facet identity", async () => {
		const { client } = await fixture();
		const { session } = await client.preview({
			...scope,
			revisionId,
			previewId,
		});
		expect(await verifyWorkspaceAppSession(key, session)).toMatchObject({
			previewId,
			revisionId,
		});
	});
	it("rechecks a build session against the caller's current role", async () => {
		const { client, db } = await fixture();
		const { session } = await client.open(scope);
		await db
			.update(organizationMembers)
			.set({ role: "viewer" })
			.where(eq(organizationMembers.id, "member-1"));
		await expect(
			client.call({ ...scope, session, method: "count", args: [] }),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
	});
	it("keeps capability and trace writes behind the service boundary", async () => {
		const { client } = await fixture();
		const { session } = await client.open(scope);
		await expect(
			client.capability({
				session,
				operation: "outputs.read",
				slot: "sheet",
				args: null,
			}),
		).rejects.toMatchObject({ code: "UNAUTHORIZED" });
		await expect(
			client.recordTail({
				...scope,
				organizationId: "org-1",
				tailId: crypto.randomUUID(),
				revisionId,
				events: [],
			}),
		).rejects.toMatchObject({ code: "UNAUTHORIZED" });
	});
	it("allows a use app to read its granted Output but denies writes and other slots", async () => {
		const { db, router, env } = await fixture();
		const reader = createRouterClient(router, {
			context: userContext({ env, sub: "user-2" }),
		});
		const { session } = await reader.open(scope);
		const internal = createRouterClient(router, {
			context: userContext({ env, headers: { "X-Service-Binding": "true" } }),
		});
		const outputId = "55555555-5555-4555-8555-555555555555";
		const outputRevisionId = "66666666-6666-4666-8666-666666666666";
		await db.insert(osOutputs).values({
			id: outputId,
			organizationId: "org-1",
			workspaceId,
			kind: "document",
			title: "Granted document",
			currentRevisionId: outputRevisionId,
			createdByKind: "user",
			createdById: "user-1",
		});
		await db.insert(osOutputRevisions).values({
			id: outputRevisionId,
			organizationId: "org-1",
			outputId,
			revision: 1,
			content: JSON.stringify({
				kind: "document",
				blocks: [{ type: "paragraph", text: "Granted content" }],
			}),
			accessEnvelope: JSON.stringify({ version: 1, sources: [] }),
			createdByKind: "user",
			createdById: "user-1",
		});
		await db.insert(osWorkspaceResources).values({
			id: crypto.randomUUID(),
			organizationId: "org-1",
			workspaceId,
			slot: "sheet",
			providerId: "tedix",
			connectionScope: "tenant",
			resourceType: "output",
			providerResourceId: outputId,
			name: "Document",
			createdByKind: "user",
			createdById: "user-1",
		});
		expect(
			await internal.capability({
				session,
				operation: "outputs.read",
				slot: "sheet",
				args: null,
			}),
		).toMatchObject({
			output: { id: outputId },
			revision: { content: { kind: "document" } },
		});
		await expect(
			internal.capability({
				session,
				operation: "outputs.write",
				slot: "sheet",
				args: null,
			}),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		await expect(
			internal.capability({
				session,
				operation: "outputs.read",
				slot: "ungranted",
				args: null,
			}),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
	});
	it("records app trace failures in the existing gadget ledger", async () => {
		const { db, router, env } = await fixture();
		const internal = createRouterClient(router, {
			context: userContext({ env, headers: { "X-Service-Binding": "true" } }),
		});
		const trace = {
			...scope,
			organizationId: "org-1",
			tailId: crypto.randomUUID(),
			revisionId,
			events: [{ outcome: "exception" }],
		};
		expect(await internal.recordTail(trace)).toEqual({ recorded: true });
		expect(await internal.recordTail(trace)).toEqual({ recorded: true });
		const rows = await db.select().from(osGadgetExecutions);
		expect(rows).toMatchObject([
			{ gadgetId, revisionId, status: "failed", createdByKind: "service" },
		]);
	});
});
