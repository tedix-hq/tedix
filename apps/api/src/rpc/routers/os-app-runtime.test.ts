import { DatabaseSync } from "node:sqlite";
import { createRouterClient } from "@orpc/server";
import { createDbClient } from "@tedix/db/client";
import { createD1Facade } from "@tedix/db/test/d1-facade";
import { schemaDdl } from "@tedix/db/test/schema-ddl";
import {
	osWorkspaces,
	osCollaborationProposals,
	osGadgets,
	osGadgetRevisions,
	osGadgetCode,
	osGadgetExecutions,
	osWorkspaceResources,
	osOutputs,
	osOutputRevisions,
} from "@tedix/db/schema/os-workspaces";
import { kernelConversations } from "@tedix/db/schema/cognitive-runtime";
import { auditEvents } from "@tedix/db/schema/audit-events";
import { osCollaborationProcedures } from "./os-workspace-collaboration";
import { organizations } from "@tedix/db/schema/organizations";
import { organizationMembers } from "@tedix/db/schema/organization-members";
import {
	osWorkspaceAccessEdges,
	osWorkspaceCollaborators,
	osWorkspaceShareLinks,
	osWorkspaceShareKeys,
} from "@tedix/db/schema/os-collaborators";
import { eq } from "drizzle-orm";
import {
	mintWorkspaceAppSession,
	verifyWorkspaceAppSession,
} from "@tedix/auth/workspace-app-session";
import { describe, expect, it, vi, onTestFinished } from "vite-plus/test";
import { userContext, apiKeyContext } from "../test-context";
import { createOsAppRuntimeRouter } from "./os-app-runtime";
import { OsDerivedAccessEnvelopeSchema } from "@tedix/api-contract/schemas/os-workspaces";

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
			kernelConversations,
			auditEvents,
			osCollaborationProposals,
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
			config: { version: 1, settings: { tags: ["Relevant"] } },
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
			config: { version: 1, settings: { tags: ["Relevant"] } },
			grants: [{ slot: "sheet", operations: ["outputs.read"] }],
		});
	});
	it("forwards only stored code and the validated invocation over the runtime binding", async () => {
		const { router, env, fetch, db } = await fixture();
		const client = createRouterClient(router, {
			context: userContext({ env, sub: "user-2" }),
		});
		const { session } = await client.open(scope);
		expect(
			await client.call({ ...scope, session, method: "count", args: [] }),
		).toEqual({ result: { count: 1 } });
		const receipts = await db.select().from(osGadgetExecutions);
		expect(receipts).toMatchObject([
			{
				gadgetId,
				revisionId,
				status: "completed",
				createdByKind: "user",
				createdById: "user-2",
				grantedCapabilities: JSON.stringify(["app.call"]),
				input: JSON.stringify({ method: "count", args: [] }),
				output: JSON.stringify({ count: 1 }),
			},
		]);
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
	it("records a failed use-role call without claiming a successful write", async () => {
		const { router, env, db, fetch } = await fixture();
		const reader = createRouterClient(router, {
			context: userContext({ env, sub: "user-2" }),
		});
		const { session } = await reader.open(scope);
		fetch.mockResolvedValueOnce(new Response("Unavailable", { status: 503 }));
		await expect(
			reader.call({ ...scope, session, method: "rate", args: [] }),
		).rejects.toMatchObject({ code: "BAD_GATEWAY" });
		const [receipt] = await db.select().from(osGadgetExecutions);
		expect(receipt).toMatchObject({
			status: "failed",
			revisionId,
			createdById: "user-2",
			output: null,
		});
		expect(JSON.parse(receipt!.policyDecision)).toMatchObject({
			allowed: true,
			role: "use",
		});
	});
	it("rejects a stale pinned revision before dispatch or creating a receipt", async () => {
		const { client, db, fetch } = await fixture();
		const { session } = await client.open(scope);
		await db
			.update(osGadgets)
			.set({ currentRevisionId: previewId })
			.where(eq(osGadgets.id, gadgetId));
		await expect(
			client.call({ ...scope, session, method: "rate", args: [] }),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(fetch).not.toHaveBeenCalled();
		expect(await db.select().from(osGadgetExecutions)).toEqual([]);
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
	it("rechecks connection slots and current grants before the provider adapter", async () => {
		const { client, db, router, env } = await fixture();
		const manifest = {
			entry: "tedix:runtime/v1",
			capabilities: [],
			resourceGrants: [{ slot: "calendar", operations: ["connections.call"] }],
		};
		await db
			.update(osGadgetRevisions)
			.set({ manifest: JSON.stringify(manifest) })
			.where(eq(osGadgetRevisions.id, revisionId));
		const { session } = await client.open(scope);
		const internal = createRouterClient(router, {
			context: userContext({ env, headers: { "X-Service-Binding": "true" } }),
		});
		const request = {
			session,
			operation: "connections.call" as const,
			slot: "calendar",
			args: null,
		};
		await expect(internal.capability(request)).rejects.toMatchObject({
			code: "NOT_FOUND",
		});
		await expect(
			internal.capability({ ...request, slot: "another-slot" }),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		await db
			.update(osGadgetRevisions)
			.set({ manifest: JSON.stringify({ ...manifest, resourceGrants: [] }) })
			.where(eq(osGadgetRevisions.id, revisionId));
		await expect(internal.capability(request)).rejects.toMatchObject({
			code: "FORBIDDEN",
		});
	});
	it("refuses expired runtime sessions before dispatch", async () => {
		const { client, fetch } = await fixture();
		let session: string;
		vi.useFakeTimers({ toFake: ["Date"] });
		try {
			vi.setSystemTime(Date.now() - 301_000);
			session = (await client.open(scope)).session;
		} finally {
			vi.useRealTimers();
		}
		await expect(
			client.call({ ...scope, session, method: "count", args: [] }),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(fetch).not.toHaveBeenCalled();
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

describe("workspace app runtime API under attack", () => {
	const outputId = "77777777-7777-4777-8777-777777777777";
	const outputRevisionId = "88888888-8888-4888-8888-888888888888";
	const otherGadgetId = "99999999-9999-4999-8999-999999999999";
	const document = {
		kind: "document",
		blocks: [{ type: "paragraph", text: "Granted content" }],
	};
	type Fixture = Awaited<ReturnType<typeof fixture>>;

	async function collaborator(f: Fixture, role: "use" | "build" = "use") {
		await f.db.insert(osWorkspaceCollaborators).values({
			id: crypto.randomUUID(),
			organizationId: "org-1",
			workspaceId,
			userId: "outside",
		});
		await f.db.insert(osWorkspaceAccessEdges).values({
			id: crypto.randomUUID(),
			organizationId: "org-1",
			workspaceId,
			targetUserId: "outside",
			kind: "user",
			edgeKey: "user:user-1",
			sharerUserId: "user-1",
			role,
		});
		return createRouterClient(f.router, {
			context: userContext({
				env: f.env,
				sub: "outside",
				organizationId: "org-other",
			}),
		});
	}

	it.each(["use", "build"] as const)(
		"serves only client code and granted sourceless Outputs to a cross-org %s collaborator",
		async (role) => {
			const f = await fixture();
			await seedOutput(f.db);
			const outside = await collaborator(f, role);
			const opened = await outside.client(scope);
			expect(opened).toMatchObject({
				role,
				revisionId,
				revision: 1,
				client: "",
				settings: { tags: ["Relevant"] },
				grants: [{ slot: "sheet", operations: ["outputs.read"] }],
			});
			expect(Object.keys(opened).sort()).toEqual(
				[
					"client",
					"expiresAt",
					"grants",
					"revision",
					"revisionId",
					"role",
					"session",
					"settings",
				].sort(),
			);
			expect(JSON.stringify(opened)).not.toContain("server.js");
			expect(
				await outside.readOutput({
					...scope,
					session: opened.session,
					slot: "sheet",
				}),
			).toEqual(document);
			expect(
				await outside.call({
					...scope,
					session: opened.session,
					method: "count",
					args: [],
				}),
			).toEqual({ result: { count: 1 } });
			await expect(
				outside.readOutput({
					...scope,
					session: opened.session,
					slot: "ungranted",
				}),
			).rejects.toMatchObject({ code: "FORBIDDEN" });
			await expect(
				f.client.readOutput({
					...scope,
					session: opened.session,
					slot: "sheet",
				}),
			).rejects.toMatchObject({ code: "FORBIDDEN" });
			await expect(
				outside.readOutput({
					...scope,
					session: `${opened.session}x`,
					slot: "sheet",
				}),
			).rejects.toMatchObject({ code: "FORBIDDEN" });
			await f.db.delete(osWorkspaceAccessEdges);
			await expect(outside.client(scope)).rejects.toMatchObject({
				code: "FORBIDDEN",
			});
			await expect(
				outside.readOutput({
					...scope,
					session: opened.session,
					slot: "sheet",
				}),
			).rejects.toMatchObject({ code: "FORBIDDEN" });
		},
	);

	it.each([
		null,
		"invalid",
		JSON.stringify({
			version: 1,
			sources: [
				{
					workspaceId,
					workspaceResourceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
					providerId: "notion",
					connectionScope: "tenant",
					resourceType: "page",
					providerResourceId: "page-1",
					requiredScopes: [],
					operations: ["read"],
				},
			],
		}),
	])(
		"denies cross-org Output reads with absent, malformed or sourced envelopes: %s",
		async (accessEnvelope) => {
			if (accessEnvelope && accessEnvelope !== "invalid")
				OsDerivedAccessEnvelopeSchema.parse(JSON.parse(accessEnvelope));
			const f = await fixture();
			await seedOutput(f.db);
			const outside = await collaborator(f);
			const { session } = await outside.client(scope);
			await f.db
				.update(osOutputRevisions)
				.set({ accessEnvelope })
				.where(eq(osOutputRevisions.id, outputRevisionId));
			await expect(
				outside.readOutput({ ...scope, session, slot: "sheet" }),
			).rejects.toMatchObject({ code: "FORBIDDEN" });
			await expect(
				internalClient(f).capability(read(session)),
			).rejects.toMatchObject({ code: "FORBIDDEN" });
		},
	);

	it("rechecks grants, role, revision, expiry and workspace binding on browser Output reads", async () => {
		const f = await fixture();
		await seedOutput(f.db, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
		const outside = await collaborator(f, "build");
		const { session } = await outside.client(scope);
		await expect(
			outside.readOutput({ ...scope, session, slot: "sheet" }),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		await f.db
			.update(osOutputs)
			.set({ workspaceId })
			.where(eq(osOutputs.id, outputId));
		await f.db.update(osWorkspaceAccessEdges).set({ role: "use" });
		await expect(
			outside.readOutput({ ...scope, session, slot: "sheet" }),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		const current = await outside.client(scope);
		await f.db
			.update(osGadgetRevisions)
			.set({
				manifest: JSON.stringify({
					entry: "tedix:runtime/v1",
					capabilities: [],
					resourceGrants: [],
				}),
			})
			.where(eq(osGadgetRevisions.id, revisionId));
		await expect(
			outside.readOutput({ ...scope, session: current.session, slot: "sheet" }),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		await f.db
			.update(osGadgets)
			.set({ currentRevisionId: otherGadgetId })
			.where(eq(osGadgets.id, gadgetId));
		await expect(
			outside.readOutput({ ...scope, session: current.session, slot: "sheet" }),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		await f.db
			.update(osGadgets)
			.set({ currentRevisionId: revisionId })
			.where(eq(osGadgets.id, gadgetId));
		vi.useFakeTimers({ toFake: ["Date"] });
		try {
			vi.setSystemTime(Date.now() + 301_000);
			await expect(
				outside.readOutput({
					...scope,
					session: current.session,
					slot: "sheet",
				}),
			).rejects.toMatchObject({ code: "FORBIDDEN" });
		} finally {
			vi.useRealTimers();
		}
	});

	async function grantAll(db: Fixture["db"]) {
		await db
			.update(osGadgetRevisions)
			.set({
				manifest: JSON.stringify({
					entry: "tedix:runtime/v1",
					capabilities: [],
					config: { version: 1 },
					resourceGrants: [
						{ slot: "sheet", operations: ["outputs.read", "outputs.write"] },
					],
				}),
			})
			.where(eq(osGadgetRevisions.id, revisionId));
	}

	async function seedOutput(
		db: Fixture["db"],
		outputWorkspaceId = workspaceId,
	) {
		await db.insert(osOutputs).values({
			id: outputId,
			organizationId: "org-1",
			workspaceId: outputWorkspaceId,
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
			content: JSON.stringify(document),
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
	}

	function internalClient(f: Fixture) {
		return createRouterClient(f.router, {
			context: userContext({
				env: f.env,
				headers: { "X-Service-Binding": "true" },
			}),
		});
	}

	const write = (session: string, expectedRevision = 1) => ({
		session,
		operation: "outputs.write" as const,
		slot: "sheet",
		args: {
			content: {
				kind: "document",
				blocks: [{ type: "paragraph", text: `Edit ${expectedRevision}` }],
			},
			expectedRevision,
		},
	});
	const read = (session: string) => ({
		session,
		operation: "outputs.read" as const,
		slot: "sheet",
		args: null,
	});

	it("recomputes access on every call and capability after a member leaves", async () => {
		const f = await fixture();
		await seedOutput(f.db);
		const reader = createRouterClient(f.router, {
			context: userContext({ env: f.env, sub: "user-2" }),
		});
		const { session } = await reader.open(scope);
		const internal = internalClient(f);
		expect(await internal.capability(read(session))).toMatchObject({
			output: { id: outputId },
		});
		await f.db
			.update(organizationMembers)
			.set({ status: "deactivated" })
			.where(eq(organizationMembers.id, "member-2"));
		await expect(
			reader.call({ ...scope, session, method: "count", args: [] }),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		await expect(internal.capability(read(session))).rejects.toMatchObject({
			code: "FORBIDDEN",
		});
		expect(f.fetch).not.toHaveBeenCalled();
	});

	it("drops writes from a build session the moment its holder is downgraded", async () => {
		const f = await fixture();
		await grantAll(f.db);
		await seedOutput(f.db);
		const { session } = await f.client.open(scope);
		const internal = internalClient(f);
		expect(await internal.capability(write(session))).toMatchObject({
			ok: true,
		});
		await f.db
			.update(organizationMembers)
			.set({ role: "viewer" })
			.where(eq(organizationMembers.id, "member-1"));
		await expect(internal.capability(write(session, 2))).rejects.toMatchObject({
			code: "FORBIDDEN",
		});
		const revisions = await f.db
			.select()
			.from(osOutputRevisions)
			.where(eq(osOutputRevisions.outputId, outputId));
		expect(revisions).toHaveLength(2);
	});

	it("never grants a use session a write, a skill run or a connection call", async () => {
		const f = await fixture();
		await grantAll(f.db);
		await seedOutput(f.db);
		const reader = createRouterClient(f.router, {
			context: userContext({ env: f.env, sub: "user-2" }),
		});
		const { session, role } = await reader.open(scope);
		expect(role).toBe("use");
		const internal = internalClient(f);
		await expect(internal.capability(write(session))).rejects.toMatchObject({
			code: "FORBIDDEN",
		});
		for (const operation of ["skills.run", "connections.call"] as const)
			await expect(
				internal.capability({ ...read(session), operation }),
			).rejects.toMatchObject({ code: "FORBIDDEN" });
	});

	it("keeps preview sessions read-only even for a builder with a write grant", async () => {
		const f = await fixture();
		await grantAll(f.db);
		await seedOutput(f.db);
		const { session } = await f.client.preview({
			...scope,
			revisionId,
			previewId,
		});
		const internal = internalClient(f);
		expect(await internal.capability(read(session))).toMatchObject({
			output: { id: outputId },
		});
		await expect(internal.capability(write(session))).rejects.toMatchObject({
			code: "FORBIDDEN",
		});
	});

	it("does not let one app's session call another app in the same workspace", async () => {
		const f = await fixture();
		await f.db.insert(osGadgets).values({
			id: otherGadgetId,
			organizationId: "org-1",
			workspaceId,
			name: "Other",
			currentRevisionId: revisionId,
			createdByKind: "user",
			createdById: "user-1",
		});
		const { session } = await f.client.open(scope);
		await expect(
			f.client.call({
				workspaceId,
				gadgetId: otherGadgetId,
				session,
				method: "count",
				args: [],
			}),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(f.fetch).not.toHaveBeenCalled();
	});

	it("refuses sessions it did not sign, at the call and at the capability", async () => {
		const f = await fixture();
		await seedOutput(f.db);
		const { session } = await f.client.open(scope);
		const {
			expiresAt: _expiresAt,
			sessionId: _sessionId,
			...claims
		} = await verifyWorkspaceAppSession(key, session);
		const forged = (
			await mintWorkspaceAppSession("fictional-forged-key", {
				...claims,
				role: "owner",
			})
		).token;
		await expect(
			f.client.call({ ...scope, session: forged, method: "count", args: [] }),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		await expect(internalClient(f).capability(read(forged))).rejects.toThrow();
		expect(f.fetch).not.toHaveBeenCalled();
	});

	it("gives machine sessions no resource capability", async () => {
		const f = await fixture();
		await seedOutput(f.db);
		const machine = createRouterClient(f.router, {
			context: apiKeyContext({ env: f.env, scopes: ["apps:read"] }),
		});
		const { session } = await machine.open(scope);
		await expect(
			internalClient(f).capability(read(session)),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
	});

	it("refuses a trace that names another tenant or workspace for an app", async () => {
		const f = await fixture();
		const internal = internalClient(f);
		const trace = {
			...scope,
			organizationId: "org-1",
			tailId: crypto.randomUUID(),
			revisionId,
			events: [],
		};
		await expect(
			internal.recordTail({ ...trace, organizationId: "org-2" }),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		await expect(
			internal.recordTail({ ...trace, workspaceId: previewId }),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		expect(await f.db.select().from(osGadgetExecutions)).toEqual([]);
	});

	it("refuses a slot bound to an Output of another workspace", async () => {
		const f = await fixture();
		await seedOutput(f.db, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
		const { session } = await f.client.open(scope);
		await expect(
			internalClient(f).capability(read(session)),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
	});
});

describe("app chat drafts", () => {
	async function chatFixture() {
		const f = await fixture();
		await f.db.insert(kernelConversations).values({
			id: "org-1:chat-1",
			organizationId: "org-1",
			conversationId: "chat-1",
			workspaceId,
			lastMessageAt: new Date().toISOString(),
		});
		const collaboration = createRouterClient(osCollaborationProcedures, {
			context: f.context,
		});
		const input = {
			...scope,
			conversationId: "chat-1",
			expectedRevisionId: revisionId,
			edits: [
				{
					path: "server.js",
					before: "export class App {}",
					after: "export class App { count() { return 2; } }",
				},
			],
		};
		return { ...f, collaboration, input };
	}
	it("reads mainline files, proposes without changing them, and dispatches the proposal files", async () => {
		const f = await chatFixture();
		const { proposal } = await f.client.proposeEdit(f.input);
		expect(proposal).toMatchObject({
			status: "open",
			sourceKind: "chat",
			sourceId: "chat-1",
			baseRevisionId: revisionId,
		});
		expect((await f.db.select().from(osGadgetCode))[0]!.files).toContain(
			"export class App {}",
		);
		expect(await f.db.select().from(osGadgetRevisions)).toHaveLength(1);
		const { session } = await f.client.draft({
			...scope,
			proposalId: proposal.id,
		});
		expect(await verifyWorkspaceAppSession(key, session)).toMatchObject({
			previewId: proposal.id,
			proposalId: proposal.id,
		});
		await f.client.call({ ...scope, session, method: "count", args: [] });
		expect(await (f.fetch.mock.calls[0]![0] as Request).json()).toMatchObject({
			files: { "server.js": f.input.edits[0]!.after },
		});
		await f.db
			.update(osCollaborationProposals)
			.set({
				content: JSON.stringify({
					...(proposal.content as object),
					files: { "server.js": "changed", "client.js": "" },
				}),
			})
			.where(eq(osCollaborationProposals.id, proposal.id));
		await expect(
			f.client.call({ ...scope, session, method: "count", args: [] }),
		).rejects.toMatchObject({ code: "CONFLICT" });
	});
	it("accepts into a revision with code, aborts live code, and the next open loads it", async () => {
		const f = await chatFixture();
		const old = await f.client.open(scope);
		const { proposal } = await f.client.proposeEdit(f.input);
		const { session } = await f.client.draft({
			...scope,
			proposalId: proposal.id,
		});
		const accepted = await f.collaboration.accept({
			proposalId: proposal.id,
			expectedSequence: 0,
			rationale: "Reviewed draft",
			evidenceRefs: [],
		});
		const merged = await f.collaboration.merge({
			proposalId: proposal.id,
			expectedSequence: accepted.proposal.sequence,
			rationale: "Apply draft",
			evidenceRefs: [],
		});
		expect(merged.revision.revision).toBe(2);
		expect(await (f.fetch.mock.calls[0]![0] as Request).json()).toMatchObject({
			proposalId: proposal.id,
			merged: true,
		});
		const next = await f.client.open(scope);
		expect(next.revisionId).toBe(merged.revision.id);
		await f.client.call({
			...scope,
			session: next.session,
			method: "count",
			args: [],
		});
		expect(await (f.fetch.mock.calls[1]![0] as Request).json()).toMatchObject({
			files: { "server.js": f.input.edits[0]!.after },
		});
		await expect(
			f.client.call({ ...scope, session, method: "count", args: [] }),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		await expect(
			f.client.call({
				...scope,
				session: old.session,
				method: "count",
				args: [],
			}),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
	});
	it("rejects a draft, removes its facet, and refuses reuse", async () => {
		const f = await chatFixture();
		const { proposal } = await f.client.proposeEdit(f.input);
		const { session } = await f.client.draft({
			...scope,
			proposalId: proposal.id,
		});
		await f.collaboration.reject({
			proposalId: proposal.id,
			expectedSequence: 0,
			rationale: "Discard draft",
			evidenceRefs: [],
		});
		expect(await (f.fetch.mock.calls[0]![0] as Request).json()).toMatchObject({
			proposalId: proposal.id,
			merged: false,
		});
		await expect(
			f.client.draft({ ...scope, proposalId: proposal.id }),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		await expect(
			f.client.call({ ...scope, session, method: "count", args: [] }),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		expect(await f.db.select().from(osGadgetRevisions)).toHaveLength(1);
	});
	it("rejects stale, ambiguous and unlinked chat edits, and use-only previews", async () => {
		const f = await chatFixture();
		await expect(
			f.client.proposeEdit({ ...f.input, conversationId: "unknown" }),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		await expect(
			f.client.proposeEdit({ ...f.input, expectedRevisionId: previewId }),
		).rejects.toMatchObject({ code: "CONFLICT" });
		await expect(
			f.client.proposeEdit({
				...f.input,
				edits: [{ path: "server.js", before: "missing", after: "x" }],
			}),
		).rejects.toMatchObject({ code: "CONFLICT" });
		const { proposal } = await f.client.proposeEdit(f.input);
		const reader = createRouterClient(f.router, {
			context: userContext({ env: f.env, sub: "user-2" }),
		});
		await expect(
			reader.draft({ ...scope, proposalId: proposal.id }),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		await expect(reader.proposeEdit(f.input)).rejects.toMatchObject({
			code: "FORBIDDEN",
		});
		await f.db
			.update(osCollaborationProposals)
			.set({ workspaceId: previewId })
			.where(eq(osCollaborationProposals.id, proposal.id));
		await expect(
			f.client.draft({ ...scope, proposalId: proposal.id }),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
	});
	it.each(["reject", "merge"] as const)(
		"retries %s cleanup without another revision",
		async (decision) => {
			const f = await chatFixture();
			const { proposal } = await f.client.proposeEdit(f.input);
			const input = {
				proposalId: proposal.id,
				expectedSequence: 0,
				rationale: "Reviewed",
				evidenceRefs: [],
			};
			if (decision === "merge") await f.collaboration.accept(input);
			f.fetch.mockResolvedValueOnce(
				new Response("Unavailable", { status: 503 }),
			);
			await expect(f.collaboration[decision](input)).rejects.toMatchObject({
				code: "BAD_GATEWAY",
			});
			const result = await f.collaboration[decision](input);
			expect(result.proposal.status).toBe(
				decision === "merge" ? "merged" : "rejected",
			);
			expect(await f.db.select().from(osGadgetRevisions)).toHaveLength(
				decision === "merge" ? 2 : 1,
			);
			expect(f.fetch).toHaveBeenCalledTimes(2);
		},
	);
	it("invalidates a preview when only the draft manifest changes", async () => {
		const f = await chatFixture();
		const { proposal } = await f.client.proposeEdit(f.input);
		const { session } = await f.client.draft({
			...scope,
			proposalId: proposal.id,
		});
		await f.db
			.update(osCollaborationProposals)
			.set({ sequence: 1 })
			.where(eq(osCollaborationProposals.id, proposal.id));
		await expect(
			f.client.call({ ...scope, session, method: "count", args: [] }),
		).rejects.toMatchObject({ code: "CONFLICT" });
		expect(f.fetch).not.toHaveBeenCalled();
	});
});

describe("Code drafts and rebasing", () => {
	async function draftFixture() {
		const f = await fixture();
		const revision = await f.db
			.select()
			.from(osGadgetRevisions)
			.where(eq(osGadgetRevisions.id, revisionId));
		const content = {
			manifest: JSON.parse(revision[0].manifest),
			files: { "server.js": "export class App {}", "client.js": "draft" },
		};
		const saved = await f.client.saveDraft({
			...scope,
			expectedRevisionId: revisionId,
			content,
		});
		return { ...f, content, proposal: saved.proposal };
	}
	it("saves builder Code edits as a proposal without advancing mainline", async () => {
		const f = await draftFixture();
		expect(f.proposal).toMatchObject({
			sourceKind: "user",
			sourceId: "user-1",
			status: "open",
			baseRevisionId: revisionId,
		});
		expect((await f.client.open(scope)).revisionId).toBe(revisionId);
		const code = await f.db
			.select()
			.from(osGadgetCode)
			.where(eq(osGadgetCode.revisionId, revisionId));
		expect(JSON.parse(code[0].files)["client.js"]).toBe("");
	});
	it("rebases independent files and resets accepted drafts for review under sequence CAS", async () => {
		const f = await draftFixture();
		await f.db.insert(osGadgetRevisions).values({
			id: previewId,
			organizationId: "org-1",
			gadgetId,
			revision: 2,
			manifest: JSON.stringify(f.content.manifest),
			createdByKind: "user",
			createdById: "user-1",
		});
		await f.db.insert(osGadgetCode).values({
			revisionId: previewId,
			organizationId: "org-1",
			gadgetId,
			files: JSON.stringify({ "server.js": "main edit", "client.js": "" }),
			codeLength: 9,
		});
		await f.db
			.update(osGadgets)
			.set({ currentRevisionId: previewId })
			.where(eq(osGadgets.id, gadgetId));
		const merged = await f.client.mergeDraft({
			...scope,
			proposalId: f.proposal.id,
			expectedSequence: 0,
		});
		expect(merged.conflicts).toEqual([]);
		expect(merged.files).toEqual({
			"server.js": "main edit",
			"client.js": "draft",
		});
		await f.db
			.update(osCollaborationProposals)
			.set({ status: "accepted", decidedById: "user-1", decidedByKind: "user" })
			.where(eq(osCollaborationProposals.id, f.proposal.id));
		const saved = await f.client.saveDraft({
			...scope,
			expectedRevisionId: previewId,
			proposalId: f.proposal.id,
			expectedSequence: 0,
			content: { manifest: JSON.parse(merged.manifest), files: merged.files },
		});
		expect(saved.proposal).toMatchObject({
			id: f.proposal.id,
			sequence: 1,
			status: "open",
			baseRevisionId: previewId,
			decidedById: null,
		});
		await expect(
			f.client.saveDraft({
				...scope,
				expectedRevisionId: previewId,
				proposalId: f.proposal.id,
				expectedSequence: 0,
				content: f.content,
			}),
		).rejects.toMatchObject({ code: "CONFLICT" });
	});
	it("shows overlapping file and manifest edits, then merges the resolved revision", async () => {
		const f = await draftFixture();
		const changedManifest = {
			...f.content.manifest,
			config: { ...f.content.manifest.config, settings: { tags: ["Main"] } },
		};
		await f.db.insert(osGadgetRevisions).values({
			id: previewId,
			organizationId: "org-1",
			gadgetId,
			revision: 2,
			manifest: JSON.stringify(changedManifest),
			createdByKind: "user",
			createdById: "user-1",
		});
		await f.db.insert(osGadgetCode).values({
			revisionId: previewId,
			organizationId: "org-1",
			gadgetId,
			files: JSON.stringify({ ...f.content.files, "client.js": "main" }),
			codeLength: 4,
		});
		await f.db
			.update(osGadgets)
			.set({ currentRevisionId: previewId })
			.where(eq(osGadgets.id, gadgetId));
		const draftManifest = {
			...f.content.manifest,
			config: { ...f.content.manifest.config, settings: { tags: ["Draft"] } },
		};
		await f.db
			.update(osCollaborationProposals)
			.set({
				content: JSON.stringify({ ...f.content, manifest: draftManifest }),
			})
			.where(eq(osCollaborationProposals.id, f.proposal.id));
		const merged = await f.client.mergeDraft({
			...scope,
			proposalId: f.proposal.id,
			expectedSequence: 0,
		});
		expect(merged.conflicts).toEqual(["client.js", "manifest.json"]);
		expect(merged.files["client.js"]).toContain("<<<<<<< Draft\ndraft");
		expect(merged.files["client.js"]).toContain("=======\nmain");
		expect(merged.manifest).toContain(">>>>>>> Mainline");
		const saved = await f.client.saveDraft({
			...scope,
			expectedRevisionId: previewId,
			proposalId: f.proposal.id,
			expectedSequence: 0,
			content: {
				manifest: changedManifest,
				files: { ...f.content.files, "client.js": "resolved" },
			},
		});
		const collaboration = createRouterClient(osCollaborationProcedures, {
			context: f.context,
		});
		const decision = {
			proposalId: f.proposal.id,
			expectedSequence: saved.proposal.sequence,
			rationale: "Reviewed conflict resolution",
			evidenceRefs: [],
		};
		await collaboration.accept(decision);
		const applied = await collaboration.merge(decision);
		expect(applied.revision.revision).toBe(3);
		expect((await f.client.open(scope)).revisionId).toBe(applied.revision.id);
	});
	it("never applies unresolved markers from a producer preview", async () => {
		const f = await draftFixture();
		await f.db
			.update(osCollaborationProposals)
			.set({
				status: "accepted",
				content: JSON.stringify({
					...f.content,
					files: {
						...f.content.files,
						"client.js":
							"<<<<<<< Draft\ndraft\n=======\nmain\n>>>>>>> Mainline",
					},
				}),
			})
			.where(eq(osCollaborationProposals.id, f.proposal.id));
		const collaboration = createRouterClient(osCollaborationProcedures, {
			context: f.context,
		});
		await expect(
			collaboration.merge({
				proposalId: f.proposal.id,
				expectedSequence: 0,
				rationale: "Apply preview",
				evidenceRefs: [],
			}),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		expect((await f.client.open(scope)).revisionId).toBe(revisionId);
	});
	it("rejects stale Code bases, unresolved markers and another app's proposals", async () => {
		const f = await draftFixture();
		await expect(
			f.client.saveDraft({
				...scope,
				expectedRevisionId: previewId,
				content: f.content,
			}),
		).rejects.toMatchObject({ code: "CONFLICT" });
		await expect(
			f.client.saveDraft({
				...scope,
				expectedRevisionId: revisionId,
				content: {
					...f.content,
					files: {
						...f.content.files,
						"client.js": "<<<<<<< Draft\nx\n=======\ny\n>>>>>>> Mainline",
					},
				},
			}),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		await f.db
			.update(osCollaborationProposals)
			.set({ documentId: previewId })
			.where(eq(osCollaborationProposals.id, f.proposal.id));
		await expect(
			f.client.mergeDraft({
				...scope,
				proposalId: f.proposal.id,
				expectedSequence: 0,
			}),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
	});
	it("denies viewers and machines Code writes and draft comparison", async () => {
		const f = await draftFixture();
		const viewer = createRouterClient(f.router, {
			context: userContext({
				env: f.env,
				sub: "user-2",
				permissions: ["os:read", "os:author"],
			}),
		});
		await expect(
			viewer.saveDraft({
				...scope,
				expectedRevisionId: revisionId,
				content: f.content,
			}),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		await expect(
			viewer.mergeDraft({
				...scope,
				proposalId: f.proposal.id,
				expectedSequence: 0,
			}),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		const machine = createRouterClient(f.router, {
			context: apiKeyContext({ env: f.env }),
		});
		await expect(
			machine.saveDraft({
				...scope,
				expectedRevisionId: revisionId,
				content: f.content,
			}),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
	});
});
