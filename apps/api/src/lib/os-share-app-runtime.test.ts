import { DatabaseSync } from "node:sqlite";
import { createRouterClient } from "@orpc/server";
import {
	mintWorkspaceAppSession,
	verifyWorkspaceAppSession,
} from "@tedix/auth/workspace-app-session";
import { createDbClient } from "@tedix/db/client";
import { createOsShareLink } from "@tedix/db/queries/os-shares";
import { organizationMembers } from "@tedix/db/schema/organization-members";
import { organizations } from "@tedix/db/schema/organizations";
import {
	osWorkspaceAccessEdges,
	osWorkspaceCollaborators,
	osWorkspaceShareKeys,
	osWorkspaceShareLinks,
} from "@tedix/db/schema/os-collaborators";
import {
	type NewOsShareLinkRow,
	osShareLinks,
	osShareSessions,
} from "@tedix/db/schema/os-shares";
import {
	osGadgetCode,
	osGadgetExecutions,
	osGadgetRevisions,
	osGadgets,
	osOutputRevisions,
	osOutputs,
	osWorkspaceResources,
	osWorkspaces,
} from "@tedix/db/schema/os-workspaces";
import { createD1Facade } from "@tedix/db/test/d1-facade";
import { schemaDdl } from "@tedix/db/test/schema-ddl";
import { eq } from "drizzle-orm";
import { describe, expect, it, onTestFinished, vi } from "vite-plus/test";
import { userContext } from "../rpc/test-context";
import { createOsAppRuntimeRouter } from "../rpc/routers/os-app-runtime";
import {
	handleGuestAppCall,
	handleGuestAppOpen,
	handleGuestAppRead,
} from "./os-share-app-runtime";
import {
	generateOsShareToken,
	handleOsShareRedemption,
	hashOsShareToken,
} from "./os-share-redemption";

const workspaceId = "11111111-1111-4111-8111-111111111111";
const gadgetId = "22222222-2222-4222-8222-222222222222";
const revisionId = "33333333-3333-4333-8333-333333333333";
const widgetGadgetId = "55555555-5555-4555-8555-555555555555";
const widgetRevisionId = "66666666-6666-4666-8666-666666666666";
const outputId = "77777777-7777-4777-8777-777777777777";
const key = "fictional-api-app-key";
const files = {
	"server.js": "export class App { async verdicts() { return []; } }",
	"client.js": "export default function mount() {}",
};

async function fixture() {
	const sqlite = new DatabaseSync(":memory:");
	onTestFinished(() => sqlite.close());
	sqlite.exec("PRAGMA foreign_keys = OFF");
	sqlite.exec(
		schemaDdl(
			organizations,
			organizationMembers,
			osWorkspaces,
			osGadgets,
			osGadgetRevisions,
			osGadgetCode,
			osGadgetExecutions,
			osWorkspaceResources,
			osOutputs,
			osOutputRevisions,
			osShareLinks,
			osShareSessions,
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
	await db.insert(osWorkspaces).values({
		id: workspaceId,
		organizationId: "org-1",
		name: "Reddit opportunities",
		createdByKind: "user",
		createdById: "user-1",
	});
	await db.insert(osGadgets).values([
		{
			id: gadgetId,
			organizationId: "org-1",
			workspaceId,
			name: "Opportunity cards",
			currentRevisionId: revisionId,
			createdByKind: "user",
			createdById: "user-1",
		},
		{
			id: widgetGadgetId,
			organizationId: "org-1",
			workspaceId,
			name: "Launch dashboard",
			currentRevisionId: widgetRevisionId,
			createdByKind: "user",
			createdById: "user-1",
		},
	]);
	await db.insert(osGadgetRevisions).values([
		{
			id: revisionId,
			organizationId: "org-1",
			gadgetId,
			revision: 1,
			manifest: JSON.stringify({
				entry: "tedix:runtime/v1",
				capabilities: [],
				config: { version: 1, settings: { reviewer: "Maya" } },
				resourceGrants: [
					{ slot: "opportunities", operations: ["outputs.read"] },
				],
			}),
			createdByKind: "user",
			createdById: "user-1",
		},
		{
			id: widgetRevisionId,
			organizationId: "org-1",
			gadgetId: widgetGadgetId,
			revision: 1,
			manifest: JSON.stringify({
				entry: "ui://widgets/mcp-app/tedix/r/launch.html",
				capabilities: [],
			}),
			createdByKind: "user",
			createdById: "user-1",
		},
	]);
	await db.insert(osGadgetCode).values({
		revisionId,
		organizationId: "org-1",
		gadgetId,
		files: JSON.stringify(files),
		codeLength: files["server.js"].length,
	});
	await db.insert(osOutputs).values({
		id: outputId,
		organizationId: "org-1",
		workspaceId,
		kind: "sheet",
		title: "Opportunities",
		currentRevisionId: "88888888-8888-4888-8888-888888888888",
		createdByKind: "user",
		createdById: "user-1",
	});
	await db.insert(osOutputRevisions).values({
		id: "88888888-8888-4888-8888-888888888888",
		organizationId: "org-1",
		outputId,
		revision: 1,
		content: JSON.stringify({ kind: "sheet", columns: ["#"], rows: [[1]] }),
		accessEnvelope: JSON.stringify({ version: 1, sources: [] }),
		createdByKind: "user",
		createdById: "user-1",
	});
	await db.insert(osWorkspaceResources).values({
		id: crypto.randomUUID(),
		organizationId: "org-1",
		workspaceId,
		slot: "opportunities",
		providerId: "tedix",
		connectionScope: "tenant",
		resourceType: "output",
		providerResourceId: outputId,
		name: "Opportunities sheet",
		createdByKind: "user",
		createdById: "user-1",
	});
	const fetch = vi.fn(async (_request: Request) => Response.json([]));
	const env = {
		ENVIRONMENT: "test",
		DB: facade,
		SECRETS_MASTER_KEY: key,
		TEDI_SERVICE: { fetch },
	} as unknown as CloudflareEnv;
	return { db, env, fetch };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

async function seedLink(
	db: Fixture["db"],
	overrides: Partial<NewOsShareLinkRow> = {},
) {
	const token = generateOsShareToken();
	const id = crypto.randomUUID();
	await createOsShareLink(db, {
		id,
		organizationId: "org-1",
		resourceType: "gadget",
		resourceId: gadgetId,
		tokenHash: await hashOsShareToken(token),
		role: "use",
		expiresAt: null,
		revokedAt: null,
		createdByKind: "user",
		createdById: "user-1",
		createdAt: "2026-10-25T10:00:00.000Z",
		...overrides,
	});
	return { token, id };
}

/** Redeem as a signed-out guest: no recipient authorizer at all. */
async function redeem(db: Fixture["db"], token: string) {
	const response = await handleOsShareRedemption(db, token);
	if (response.status !== 200) return null;
	const body = (await response.json()) as { sessionToken: string };
	return body.sessionToken;
}

describe("share-link guests on a runtime app", () => {
	it("admits a signed-out guest through a use link to a runtime app only", async () => {
		const { db } = await fixture();
		const runtime = await seedLink(db);
		expect(await redeem(db, runtime.token)).toMatch(/^[A-Za-z0-9_-]+$/);
		const widget = await seedLink(db, { resourceId: widgetGadgetId });
		expect(await redeem(db, widget.token)).toBeNull();
		const build = await seedLink(db, { role: "build" });
		expect(await redeem(db, build.token)).toBeNull();
		const viewer = await seedLink(db, { role: "viewer" });
		expect(await redeem(db, viewer.token)).toBeNull();
		const capped = await seedLink(db, {
			role: "build",
			policyMaxRole: "use",
			policyReason: "policy",
			policyRestrictedAt: "2026-10-25T10:00:00.000Z",
		});
		expect(await redeem(db, capped.token)).not.toBeNull();
	});

	it("opens the client with a use session bound to the link, never the server code", async () => {
		const { db, env } = await fixture();
		const link = await seedLink(db);
		const sessionToken = await redeem(db, link.token);
		const response = await handleGuestAppOpen(env, db, { sessionToken });
		expect(response.status).toBe(200);
		expect(response.headers.get("Cache-Control")).toBe("no-store");
		const body = (await response.json()) as {
			session: string;
			role: string;
			revisionId: string;
			app: Record<string, unknown>;
		};
		expect(body.role).toBe("use");
		expect(body.revisionId).toBe(revisionId);
		expect(body.app).toMatchObject({
			id: gadgetId,
			name: "Opportunity cards",
			client: files["client.js"],
			settings: { reviewer: "Maya" },
			grants: [{ slot: "opportunities", operations: ["outputs.read"] }],
		});
		expect(JSON.stringify(body)).not.toContain("verdicts()");
		const session = await verifyWorkspaceAppSession(key, body.session);
		expect(session).toMatchObject({
			role: "use",
			principal: { kind: "share_session" },
			shareLinkId: link.id,
			gadgetId,
		});
		expect(session.actorUserId).toBeUndefined();
	});

	it("runs server calls as the share session and records them", async () => {
		const { db, env, fetch } = await fixture();
		const link = await seedLink(db);
		const sessionToken = await redeem(db, link.token);
		const opened = (await (
			await handleGuestAppOpen(env, db, { sessionToken })
		).json()) as { session: string };
		const response = await handleGuestAppCall(env, db, {
			sessionToken,
			session: opened.session,
			method: "verdicts",
			args: [],
		});
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ result: [] });
		expect(fetch).toHaveBeenCalledTimes(1);
		const [execution] = await db
			.select()
			.from(osGadgetExecutions)
			.where(eq(osGadgetExecutions.gadgetId, gadgetId));
		expect(execution).toMatchObject({
			status: "completed",
			createdByKind: "service",
		});
		expect(execution?.createdById).toMatch(/^share_session:/);
		expect(JSON.parse(execution!.policyDecision)).toMatchObject({
			role: "use",
			shareLinkId: link.id,
		});
	});

	it("refuses a guest an app that may reach a connected account or an unbound slot", async () => {
		const { db, env, fetch } = await fixture();
		const link = await seedLink(db);
		const sessionToken = await redeem(db, link.token);
		const opened = (await (
			await handleGuestAppOpen(env, db, { sessionToken })
		).json()) as { session: string };
		const grant = async (
			resourceGrants: Array<{ slot: string; operations: string[] }>,
		) =>
			db
				.update(osGadgetRevisions)
				.set({
					manifest: JSON.stringify({
						entry: "tedix:runtime/v1",
						capabilities: [],
						config: { version: 1 },
						resourceGrants,
					}),
				})
				.where(eq(osGadgetRevisions.id, revisionId));
		await db.insert(osWorkspaceResources).values({
			id: crypto.randomUUID(),
			organizationId: "org-1",
			workspaceId,
			slot: "notes",
			providerId: "notion",
			connectionScope: "tenant",
			resourceType: "database",
			providerResourceId: "fictional-notes-db",
			name: "Team notes",
			createdByKind: "user",
			createdById: "user-1",
		});
		for (const resourceGrants of [
			[{ slot: "notes", operations: ["outputs.read"] }],
			[{ slot: "opportunities", operations: ["connections.call"] }],
			[{ slot: "unbound", operations: ["outputs.read"] }],
		]) {
			await grant(resourceGrants);
			expect((await handleGuestAppOpen(env, db, { sessionToken })).status).toBe(
				404,
			);
			// A session opened before the grant changed is refused at the call too.
			expect(
				(
					await handleGuestAppCall(env, db, {
						sessionToken,
						session: opened.session,
						method: "verdicts",
						args: [],
					})
				).status,
			).toBe(404);
		}
		expect(fetch).not.toHaveBeenCalled();
	});

	it("reads only granted, sourceless Outputs for the guest", async () => {
		const { db, env } = await fixture();
		const link = await seedLink(db);
		const sessionToken = await redeem(db, link.token);
		const granted = await handleGuestAppRead(db, {
			sessionToken,
			slot: "opportunities",
		});
		expect(granted.status).toBe(200);
		expect(await granted.json()).toMatchObject({
			output: { id: outputId, kind: "sheet" },
			revision: { content: { kind: "sheet" } },
		});
		expect(
			(await handleGuestAppRead(db, { sessionToken, slot: "other" })).status,
		).toBe(404);
		const opened = (await (
			await handleGuestAppOpen(env, db, { sessionToken })
		).json()) as { session: string };
		await db
			.update(osOutputRevisions)
			.set({
				accessEnvelope: JSON.stringify({
					version: 1,
					sources: [{ kind: "connection", id: "conn-1" }],
				}),
			})
			.where(eq(osOutputRevisions.outputId, outputId));
		expect(
			(await handleGuestAppRead(db, { sessionToken, slot: "opportunities" }))
				.status,
		).toBe(404);
		// The app no longer opens for guests at all once it reads connected data.
		expect((await handleGuestAppOpen(env, db, { sessionToken })).status).toBe(
			404,
		);
		// The host's capability path answers the same way for a session opened before.
		const internal = createRouterClient(createOsAppRuntimeRouter(), {
			context: userContext({ env, headers: { "X-Service-Binding": "true" } }),
		});
		await expect(
			internal.capability({
				session: opened.session,
				operation: "outputs.read",
				slot: "opportunities",
				args: null,
			}),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		await db
			.update(osOutputRevisions)
			.set({ accessEnvelope: JSON.stringify({ version: 1, sources: [] }) })
			.where(eq(osOutputRevisions.outputId, outputId));
		expect(
			await internal.capability({
				session: opened.session,
				operation: "outputs.read",
				slot: "opportunities",
				args: null,
			}),
		).toMatchObject({ output: { id: outputId } });
		await expect(
			internal.capability({
				session: opened.session,
				operation: "outputs.write",
				slot: "opportunities",
				args: null,
			}),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
	});

	it("refuses everything identically once the link is revoked or the workspace turns private", async () => {
		const { db, env } = await fixture();
		const link = await seedLink(db);
		const sessionToken = await redeem(db, link.token);
		const opened = (await (
			await handleGuestAppOpen(env, db, { sessionToken })
		).json()) as { session: string };
		await db
			.update(osWorkspaces)
			.set({ visibility: "private" })
			.where(eq(osWorkspaces.id, workspaceId));
		for (const response of [
			await handleGuestAppOpen(env, db, { sessionToken }),
			await handleGuestAppCall(env, db, {
				sessionToken,
				session: opened.session,
				method: "verdicts",
			}),
			await handleGuestAppRead(db, { sessionToken, slot: "opportunities" }),
		]) {
			expect(response.status).toBe(404);
			expect(await response.text()).toBe("Share link not found");
		}
		await db
			.update(osWorkspaces)
			.set({ visibility: "organization" })
			.where(eq(osWorkspaces.id, workspaceId));
		expect((await handleGuestAppOpen(env, db, { sessionToken })).status).toBe(
			200,
		);
		await db
			.update(osShareLinks)
			.set({ revokedAt: "2026-10-25T11:00:00.000Z" })
			.where(eq(osShareLinks.id, link.id));
		expect((await handleGuestAppOpen(env, db, { sessionToken })).status).toBe(
			404,
		);
		expect(
			(await handleGuestAppOpen(env, db, { sessionToken: "nope" })).status,
		).toBe(404);
		expect((await handleGuestAppOpen(env, db, null)).status).toBe(404);
	});

	it.each([
		"link revoked",
		"link expired",
		"role narrowed",
		"session revoked",
		"session expired",
	] as const)("denies all guest paths after %s", async (change) => {
		const { db, env, fetch } = await fixture();
		const link = await seedLink(db);
		const sessionToken = await redeem(db, link.token);
		const opened = (await (
			await handleGuestAppOpen(env, db, { sessionToken })
		).json()) as { session: string };
		const appSession = await verifyWorkspaceAppSession(key, opened.session);
		const past = "2000-01-01T00:00:00.000Z";
		if (change === "session revoked" || change === "session expired") {
			await db
				.update(osShareSessions)
				.set(
					change === "session revoked"
						? { revokedAt: past }
						: { expiresAt: past },
				)
				.where(eq(osShareSessions.id, appSession.principal.id));
		} else {
			await db
				.update(osShareLinks)
				.set(
					change === "link revoked"
						? { revokedAt: past }
						: change === "link expired"
							? { expiresAt: past }
							: { policyMaxRole: "viewer" },
				)
				.where(eq(osShareLinks.id, link.id));
		}
		for (const response of [
			await handleGuestAppOpen(env, db, { sessionToken }),
			await handleGuestAppRead(db, { sessionToken, slot: "opportunities" }),
			await handleGuestAppCall(env, db, {
				sessionToken,
				session: opened.session,
				method: "verdicts",
			}),
		]) {
			expect(response.status).toBe(404);
			expect(await response.text()).toBe("Share link not found");
		}
		const internal = createRouterClient(createOsAppRuntimeRouter(), {
			context: userContext({ env, headers: { "X-Service-Binding": "true" } }),
		});
		await expect(
			internal.capability({
				session: opened.session,
				operation: "outputs.read",
				slot: "opportunities",
				args: null,
			}),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(fetch).not.toHaveBeenCalled();
		expect(await db.select().from(osGadgetExecutions)).toEqual([]);
	});

	it.each([
		{ role: "build" as const },
		{ actorUserId: "user-1" },
		{ previewId: "99999999-9999-4999-8999-999999999999" },
	])(
		"rejects a signed guest capability carrying extra authority: %j",
		async (patch) => {
			const { db, env } = await fixture();
			const link = await seedLink(db);
			const sessionToken = await redeem(db, link.token);
			const opened = (await (
				await handleGuestAppOpen(env, db, { sessionToken })
			).json()) as { session: string };
			const {
				expiresAt: _expiresAt,
				sessionId: _sessionId,
				...original
			} = await verifyWorkspaceAppSession(key, opened.session);
			const altered = await mintWorkspaceAppSession(key, {
				...original,
				...patch,
			});
			const internal = createRouterClient(createOsAppRuntimeRouter(), {
				context: userContext({ env, headers: { "X-Service-Binding": "true" } }),
			});
			await expect(
				internal.capability({
					session: altered.token,
					operation: "outputs.read",
					slot: "opportunities",
					args: null,
				}),
			).rejects.toMatchObject({ code: "FORBIDDEN" });
		},
	);

	it.each(["private", "archived", "moved"] as const)(
		"denies an already-open server capability when its workspace becomes %s",
		async (change) => {
			const { db, env } = await fixture();
			const link = await seedLink(db);
			const sessionToken = await redeem(db, link.token);
			const opened = (await (
				await handleGuestAppOpen(env, db, { sessionToken })
			).json()) as { session: string };
			const internal = createRouterClient(createOsAppRuntimeRouter(), {
				context: userContext({ env, headers: { "X-Service-Binding": "true" } }),
			});
			const read = () =>
				internal.capability({
					session: opened.session,
					operation: "outputs.read",
					slot: "opportunities",
					args: null,
				});
			expect(await read()).toMatchObject({ output: { id: outputId } });
			if (change === "moved") {
				const otherWorkspaceId = crypto.randomUUID();
				await db.insert(osWorkspaces).values({
					id: otherWorkspaceId,
					organizationId: "org-1",
					name: "Other workspace",
					createdByKind: "user",
					createdById: "user-1",
				});
				await db
					.update(osGadgets)
					.set({ workspaceId: otherWorkspaceId })
					.where(eq(osGadgets.id, gadgetId));
			} else {
				await db
					.update(osWorkspaces)
					.set(
						change === "private"
							? { visibility: "private" }
							: { status: "archived" },
					)
					.where(eq(osWorkspaces.id, workspaceId));
			}
			await expect(read()).rejects.toMatchObject({ code: "FORBIDDEN" });
		},
	);

	it.each(["living", "pinned"] as const)(
		"rechecks the %s revision before serving an already-open server capability",
		async (revisionMode) => {
			const { db, env } = await fixture();
			const link = await seedLink(db, {
				revisionMode,
				pinnedRevisionId: revisionMode === "pinned" ? revisionId : null,
			});
			const sessionToken = await redeem(db, link.token);
			const opened = (await (
				await handleGuestAppOpen(env, db, { sessionToken })
			).json()) as { session: string };
			const internal = createRouterClient(createOsAppRuntimeRouter(), {
				context: userContext({ env, headers: { "X-Service-Binding": "true" } }),
			});
			const read = () =>
				internal.capability({
					session: opened.session,
					operation: "outputs.read",
					slot: "opportunities",
					args: null,
				});
			expect(await read()).toMatchObject({ output: { id: outputId } });
			const nextRevisionId = crypto.randomUUID();
			await db.insert(osGadgetRevisions).values({
				id: nextRevisionId,
				organizationId: "org-1",
				gadgetId,
				revision: 2,
				manifest: JSON.stringify({
					entry: "tedix:runtime/v1",
					capabilities: [],
				}),
				createdByKind: "user",
				createdById: "user-1",
			});
			await db.insert(osGadgetCode).values({
				revisionId: nextRevisionId,
				organizationId: "org-1",
				gadgetId,
				files: JSON.stringify(files),
				codeLength: files["server.js"].length,
			});
			await db
				.update(osGadgets)
				.set({ currentRevisionId: nextRevisionId })
				.where(eq(osGadgets.id, gadgetId));
			if (revisionMode === "pinned") {
				// Updating the app must preserve a link pinned to its old revision.
				expect(await read()).toMatchObject({ output: { id: outputId } });
				await db
					.update(osShareLinks)
					.set({ pinnedRevisionId: nextRevisionId })
					.where(eq(osShareLinks.id, link.id));
			}
			await expect(read()).rejects.toMatchObject({ code: "FORBIDDEN" });
		},
	);

	it("rejects a guest app session presented with another guest's share session", async () => {
		const { db, env } = await fixture();
		const first = await seedLink(db);
		const second = await seedLink(db);
		const firstToken = await redeem(db, first.token);
		const secondToken = await redeem(db, second.token);
		const opened = (await (
			await handleGuestAppOpen(env, db, { sessionToken: firstToken })
		).json()) as { session: string };
		expect(
			(
				await handleGuestAppCall(env, db, {
					sessionToken: secondToken,
					session: opened.session,
					method: "verdicts",
				})
			).status,
		).toBe(404);
	});
});
