import { DatabaseSync } from "node:sqlite";
import { Hono } from "hono";
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
} from "@tedix/db/schema/os-workspaces";
import { organizations } from "@tedix/db/schema/organizations";
import { organizationMembers } from "@tedix/db/schema/organization-members";
import { skillRuns } from "@tedix/db/schema/cognitive";
import {
	osWorkspaceAccessEdges,
	osWorkspaceCollaborators,
	osWorkspaceShareLinks,
} from "@tedix/db/schema/os-collaborators";
import { verifyWorkspaceAppSession } from "@tedix/auth/workspace-app-session";
import { eq } from "drizzle-orm";
import { describe, expect, it, vi, onTestFinished } from "vite-plus/test";
import { userContext } from "../rpc/test-context";
import { createOsAppRuntimeRouter } from "../rpc/routers/os-app-runtime";
import {
	appTriggerWebhookPath,
	appTriggerWebhookSecret,
	dispatchDueAppTriggers,
	handleAppTriggerWebhook,
} from "./os-app-triggers";

const workspaceId = "11111111-1111-4111-8111-111111111111";
const gadgetId = "22222222-2222-4222-8222-222222222222";
const revisionId = "33333333-3333-4333-8333-333333333333";
const key = "fictional-trigger-key";
const nineUtc = Date.UTC(2026, 9, 26, 9, 0);

const triggers = [
	{
		id: "morning",
		kind: "schedule",
		cron: "0 9 * * *",
		method: "sweep",
		args: ["inbox"],
	},
	{ id: "inbound", kind: "webhook", method: "receive" },
	{ id: "scouted", kind: "skill", slot: "scout", method: "review" },
];

async function fixture(options: { author?: string } = {}) {
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
			organizations,
			organizationMembers,
			skillRuns,
			osWorkspaceAccessEdges,
			osWorkspaceCollaborators,
			osWorkspaceShareLinks,
		),
	);
	const facade = createD1Facade(sqlite);
	const db = createDbClient(facade);
	await db
		.insert(organizations)
		.values({ id: "org-1", name: "Fictional Org", slug: "fictional" });
	await db.insert(organizationMembers).values({
		id: "member-1",
		organizationId: "org-1",
		descopeUserId: "user-1",
		email: "one@example.test",
		name: "One",
		role: "member",
		status: "active",
	});
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
		name: "Inbox",
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
			config: { version: 1, triggers },
			resourceGrants: [{ slot: "sheet", operations: ["outputs.patch"] }],
		}),
		createdByKind: "user",
		createdById: options.author ?? "user-1",
		createdAt: "2026-10-01 00:00:00",
	});
	const files = { "server.js": "export class App {}", "client.js": "" };
	await db.insert(osGadgetCode).values({
		revisionId,
		organizationId: "org-1",
		gadgetId,
		files: JSON.stringify(files),
		codeLength: files["server.js"].length,
	});
	const fetch = vi.fn(async (_request: Request) => Response.json({ ok: true }));
	const env = {
		ENVIRONMENT: "development",
		API_URL: "https://api.example.test",
		OS_URL: "https://os.example.test",
		DB: facade,
		SECRETS_MASTER_KEY: key,
		TEDI_SERVICE: { fetch: (request: Request) => fetch(request) },
	} as unknown as CloudflareEnv;
	const calls = async () =>
		Promise.all(
			fetch.mock.calls.map(async ([request]) => {
				const body = (await request.clone().json()) as {
					session: string;
					method: string;
					args: unknown[];
				};
				return {
					...body,
					session: await verifyWorkspaceAppSession(key, body.session),
				};
			}),
		);
	return { db, env, fetch, calls };
}

describe("workspace app triggers", () => {
	it("runs a schedule once per fire time, as the revision author with the app's grants", async () => {
		const f = await fixture();
		expect(await dispatchDueAppTriggers(f.env, nineUtc)).toMatchObject({
			ran: 1,
			failed: 0,
		});
		const [call] = await f.calls();
		expect(call).toMatchObject({
			method: "sweep",
			args: [
				"inbox",
				{
					trigger: "morning",
					kind: "schedule",
					firedAt: "2026-10-26T09:00:00.000Z",
				},
			],
			session: {
				principal: { kind: "app_trigger", id: `${gadgetId}:morning` },
				role: "build",
				actorUserId: "user-1",
				grants: [{ slot: "sheet", operations: ["outputs.patch"] }],
			},
		});
		expect(call!.session.actorPermissions).toContain("os:author");
		// The same tick again, and a tick with no fire time, run nothing.
		expect(await dispatchDueAppTriggers(f.env, nineUtc)).toMatchObject({
			ran: 0,
			duplicate: 1,
		});
		expect(
			await dispatchDueAppTriggers(f.env, nineUtc + 10 * 60_000),
		).toMatchObject({ ran: 0, duplicate: 0 });
		expect(f.fetch).toHaveBeenCalledTimes(1);
		const runs = await f.db.select().from(osGadgetExecutions);
		expect(runs).toMatchObject([
			{
				gadgetId,
				status: "completed",
				createdByKind: "service",
				createdById: "app-trigger:morning",
			},
		]);
		expect(JSON.parse(runs[0]!.policyDecision)).toMatchObject({
			trigger: { id: "morning", kind: "schedule" },
		});
	});

	it("gives a trigger no grants once its author is no longer a member", async () => {
		const f = await fixture({ author: "user-gone" });
		await dispatchDueAppTriggers(f.env, nineUtc);
		const [call] = await f.calls();
		expect(call!.session).toMatchObject({ role: "use", grants: [] });
		expect(call!.session.actorUserId).toBeUndefined();
	});

	it("runs a skill trigger once for each finished run of the slotted skill", async () => {
		const f = await fixture();
		await f.db.insert(osWorkspaceResources).values({
			id: crypto.randomUUID(),
			organizationId: "org-1",
			workspaceId,
			slot: "scout",
			providerId: "tedix",
			connectionScope: "tenant",
			resourceType: "skill",
			providerResourceId: "skill-1",
			name: "Scout",
			createdByKind: "user",
			createdById: "user-1",
		});
		const run = (id: string, completedAt: string) =>
			f.db.insert(skillRuns).values({
				id,
				organizationId: "org-1",
				skillId: "skill-1",
				tediId: "tedi-1",
				workflowInstanceId: `wf-${id}`,
				runtimeEnvironment: "development",
				status: "completed",
				result: { summary: "3 new threads", cards: 3 },
				startedAt: completedAt,
				completedAt,
			});
		await run("run-old", "2026-09-01T00:00:00.000Z");
		const later = nineUtc + 30 * 60_000;
		// A run finished before the trigger was saved never fires it.
		expect(await dispatchDueAppTriggers(f.env, later)).toMatchObject({
			ran: 0,
		});
		await run("run-1", "2026-10-26T09:20:00.000Z");
		expect(await dispatchDueAppTriggers(f.env, later)).toMatchObject({
			ran: 1,
		});
		expect(await dispatchDueAppTriggers(f.env, later)).toMatchObject({
			ran: 0,
			duplicate: 1,
		});
		const [call] = await f.calls();
		expect(call).toMatchObject({
			method: "review",
			args: [
				{
					trigger: "scouted",
					kind: "skill",
					run: { id: "run-1", status: "completed", cards: 3 },
				},
			],
		});
	});

	it("runs a webhook trigger only for a fresh, correctly signed delivery", async () => {
		const f = await fixture();
		const app = new Hono<{ Bindings: CloudflareEnv }>();
		app.post("/webhooks/app-triggers/:orgId/:gadgetId/:triggerId", (c) =>
			handleAppTriggerWebhook(c),
		);
		const path = appTriggerWebhookPath({
			organizationId: "org-1",
			gadgetId,
			triggerId: "inbound",
		});
		const secret = await appTriggerWebhookSecret(key, {
			organizationId: "org-1",
			gadgetId,
			triggerId: "inbound",
		});
		const sign = async (body: string, timestamp: number, withKey = secret) => {
			const imported = await crypto.subtle.importKey(
				"raw",
				new TextEncoder().encode(withKey),
				{ name: "HMAC", hash: "SHA-256" },
				false,
				["sign"],
			);
			const mac = await crypto.subtle.sign(
				"HMAC",
				imported,
				new TextEncoder().encode(`${timestamp}.${body}`),
			);
			return `sha256=${Array.from(new Uint8Array(mac), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
		};
		const deliver = async (
			body: string,
			timestamp: number,
			signature: string,
			target = path,
		) =>
			app.request(
				target,
				{
					method: "POST",
					body,
					headers: {
						"X-Tedix-Timestamp": String(timestamp),
						"X-Tedix-Signature": signature,
					},
				},
				f.env,
			);
		const now = Math.floor(Date.now() / 1000);
		const body = JSON.stringify({ subject: "New lead" });
		const signature = await sign(body, now);
		const first = await deliver(body, now, signature);
		expect(first.status).toBe(200);
		expect(await first.json()).toMatchObject({ status: "ran" });
		expect(await (await deliver(body, now, signature)).json()).toMatchObject({
			status: "duplicate",
		});
		expect(
			(await deliver(body, now, await sign(body, now, "wrong"))).status,
		).toBe(401);
		expect(
			(await deliver(body, now - 3600, await sign(body, now - 3600))).status,
		).toBe(401);
		expect(
			(
				await deliver(
					body,
					now,
					signature,
					path.replace("/inbound", "/morning"),
				)
			).status,
		).toBe(401);
		const [call] = await f.calls();
		expect(f.fetch).toHaveBeenCalledTimes(1);
		expect(call).toMatchObject({
			method: "receive",
			args: [
				{ trigger: "inbound", kind: "webhook", body: { subject: "New lead" } },
			],
		});
	});

	it("shows builders the webhook address and secret, and nobody an unknown trigger", async () => {
		const f = await fixture();
		const client = createRouterClient(createOsAppRuntimeRouter(), {
			context: userContext({
				env: f.env,
				permissions: ["os:read", "os:author"],
				sub: "user-1",
			}),
		});
		const scope = { workspaceId, gadgetId };
		expect(
			await client.triggerWebhook({ ...scope, triggerId: "inbound" }),
		).toEqual({
			url: `https://api.example.test/webhooks/app-triggers/org-1/${gadgetId}/inbound`,
			secret: await appTriggerWebhookSecret(key, {
				organizationId: "org-1",
				gadgetId,
				triggerId: "inbound",
			}),
		});
		await expect(
			client.triggerWebhook({ ...scope, triggerId: "morning" }),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		await f.db
			.update(osGadgets)
			.set({ status: "archived" })
			.where(eq(osGadgets.id, gadgetId));
		await expect(
			client.triggerWebhook({ ...scope, triggerId: "inbound" }),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
	});
});
