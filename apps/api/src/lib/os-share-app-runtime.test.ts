import { DatabaseSync } from "node:sqlite";
import { createRouterClient } from "@orpc/server";
import {
	mintWorkspaceAppSession,
	verifyWorkspaceAppSession,
} from "@tedix/auth/workspace-app-session";
import { createDbClient } from "@tedix/db/client";
import {
	createOsShareLink,
	getScopedOsShareLink,
	setOsShareSkillReadGrants,
} from "@tedix/db/queries/os-shares";
import {
	approvedGuestSkillRead,
	prepareGuestSkillReadGrants,
} from "../services/os-share-skill-read-grants";
import { organizationMembers } from "@tedix/db/schema/organization-members";
import { organizations } from "@tedix/db/schema/organizations";
import { auditEvents } from "@tedix/db/schema/audit-events";
import { osSharesContractRouter } from "../rpc/routers/os-shares";
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
	osShareSkillReadGrants,
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
	guestAppRefusalForApp,
	handleGuestAppCall,
	handleGuestAppOpen,
	handleGuestAppRead,
} from "./os-share-app-runtime";
import {
	generateOsShareToken,
	handleOsShareRedemption,
	handleOsShareSessionOutput,
	hashOsShareToken,
	workspaceGuestLimits,
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
			auditEvents,
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
			osShareSkillReadGrants,
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
		publicId: id.replaceAll("-", "").slice(0, 22),
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
		const response = await handleGuestAppOpen(env, db, {
			sessionToken,
			guestName: "Maya",
		});
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
			await handleGuestAppOpen(env, db, { sessionToken, guestName: "Maya" })
		).json()) as { session: string };
		const response = await handleGuestAppCall(env, db, {
			sessionToken,
			session: opened.session,
			method: "verdicts",
			args: [],
			guestName: "Forged caller name",
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
			guestName: "Maya",
			guestIdentity: "self_reported",
		});
	});

	it.each([
		undefined,
		null,
		"",
		"   ",
		"x".repeat(81),
		"Maya\u0000",
		"Maya\u202e",
		123,
	])("refuses an invalid guest name: %j", async (guestName) => {
		const { db, env, fetch } = await fixture();
		const link = await seedLink(db);
		const sessionToken = await redeem(db, link.token);
		expect(
			(await handleGuestAppOpen(env, db, { sessionToken, guestName })).status,
		).toBe(404);
		expect(fetch).not.toHaveBeenCalled();
	});

	it("signs a trimmed guest name and refuses calls from an older unnamed session", async () => {
		const { db, env, fetch } = await fixture();
		const link = await seedLink(db);
		const sessionToken = await redeem(db, link.token);
		const opened = (await (
			await handleGuestAppOpen(env, db, {
				sessionToken,
				guestName: "  Zoë 李  ",
			})
		).json()) as { session: string };
		const {
			expiresAt: _expiresAt,
			sessionId: _sessionId,
			guestName,
			...session
		} = await verifyWorkspaceAppSession(key, opened.session);
		expect(guestName).toBe("Zoë 李");
		const unnamed = await mintWorkspaceAppSession(key, session);
		expect(
			(
				await handleGuestAppCall(env, db, {
					sessionToken,
					session: unnamed.token,
					method: "verdicts",
					guestName: "Maya",
				})
			).status,
		).toBe(404);
		expect(fetch).not.toHaveBeenCalled();
	});

	it("refuses a guest an app that may reach a connected account or an unbound slot", async () => {
		const { db, env, fetch } = await fixture();
		const link = await seedLink(db);
		const sessionToken = await redeem(db, link.token);
		const opened = (await (
			await handleGuestAppOpen(env, db, { sessionToken, guestName: "Maya" })
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
			expect(
				(await handleGuestAppOpen(env, db, { sessionToken, guestName: "Maya" }))
					.status,
			).toBe(404);
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
			await handleGuestAppOpen(env, db, { sessionToken, guestName: "Maya" })
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
		expect(
			(await handleGuestAppOpen(env, db, { sessionToken, guestName: "Maya" }))
				.status,
		).toBe(404);
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
			await handleGuestAppOpen(env, db, { sessionToken, guestName: "Maya" })
		).json()) as { session: string };
		await db
			.update(osWorkspaces)
			.set({ visibility: "private" })
			.where(eq(osWorkspaces.id, workspaceId));
		for (const response of [
			await handleGuestAppOpen(env, db, { sessionToken, guestName: "Maya" }),
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
		expect(
			(await handleGuestAppOpen(env, db, { sessionToken, guestName: "Maya" }))
				.status,
		).toBe(200);
		await db
			.update(osShareLinks)
			.set({ revokedAt: "2026-10-25T11:00:00.000Z" })
			.where(eq(osShareLinks.id, link.id));
		expect(
			(await handleGuestAppOpen(env, db, { sessionToken, guestName: "Maya" }))
				.status,
		).toBe(404);
		expect(
			(
				await handleGuestAppOpen(env, db, {
					sessionToken: "nope",
					guestName: "Maya",
				})
			).status,
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
			await handleGuestAppOpen(env, db, { sessionToken, guestName: "Maya" })
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
			await handleGuestAppOpen(env, db, { sessionToken, guestName: "Maya" }),
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
				await handleGuestAppOpen(env, db, { sessionToken, guestName: "Maya" })
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
				await handleGuestAppOpen(env, db, { sessionToken, guestName: "Maya" })
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
				await handleGuestAppOpen(env, db, { sessionToken, guestName: "Maya" })
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
			await handleGuestAppOpen(env, db, {
				sessionToken: firstToken,
				guestName: "Maya",
			})
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

describe("Anyone-with-the-link workspace links", () => {
	const workspaceLink = (overrides: Partial<NewOsShareLinkRow> = {}) => ({
		resourceType: "workspace" as const,
		resourceId: workspaceId,
		access: "anyone_with_link" as const,
		...overrides,
	});
	type WorkspacePayload = {
		resource: {
			type: "workspace";
			gadgets: Array<{
				id: string;
				opensWithoutSignIn: boolean;
				revision: { manifest: Record<string, unknown> } | null;
			}>;
			files: Array<{ id: string; title: string; kind: string }>;
			hiddenFileCount: number;
		};
	};

	async function seedConnectedOutput(db: Fixture["db"]) {
		const connectedId = "99999999-9999-4999-8999-999999999999";
		await db.insert(osOutputs).values({
			id: connectedId,
			organizationId: "org-1",
			workspaceId,
			kind: "document",
			title: "Inbox digest",
			currentRevisionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
			createdByKind: "user",
			createdById: "user-1",
		});
		await db.insert(osOutputRevisions).values({
			id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
			organizationId: "org-1",
			outputId: connectedId,
			revision: 1,
			content: JSON.stringify({ kind: "document", blocks: [] }),
			accessEnvelope: JSON.stringify({
				version: 1,
				sources: [
					{
						workspaceResourceId: "00000000-0000-4000-8000-000000000001",
						workspaceId,
						providerId: "gmail",
						connectionScope: "personal",
						providerResourceId: "inbox",
						requiredScopes: [],
					},
				],
			}),
			createdByKind: "user",
			createdById: "user-1",
		});
		return connectedId;
	}

	it("opens signed out, read-only, with its files and apps but no connected data", async () => {
		const { db } = await fixture();
		const connectedId = await seedConnectedOutput(db);
		const link = await seedLink(db, workspaceLink());
		const response = await handleOsShareRedemption(db, link.token);
		expect(response.status).toBe(200);
		const body = (await response.json()) as WorkspacePayload & {
			sessionToken: string;
		};
		expect(body.resource.files).toEqual([
			expect.objectContaining({
				id: outputId,
				title: "Opportunities",
				kind: "sheet",
			}),
		]);
		expect(body.resource.hiddenFileCount).toBe(1);
		const byId = new Map(body.resource.gadgets.map((g) => [g.id, g]));
		expect(byId.get(gadgetId)?.opensWithoutSignIn).toBe(true);
		expect(byId.get(widgetGadgetId)?.opensWithoutSignIn).toBe(false);
		// Read-only: no app is shown with how it is built.
		expect(byId.get(gadgetId)?.revision?.manifest).toEqual({
			entry: "tedix:runtime/v1",
		});
		// No connected source leaves the server, not even by name.
		expect(JSON.stringify(body)).not.toContain("Inbox digest");
		expect(JSON.stringify(body)).not.toContain("Opportunities sheet");

		const readFile = (id: string) =>
			handleOsShareSessionOutput(db, body.sessionToken, id);
		const sheet = await readFile(outputId);
		expect(sheet.status).toBe(200);
		expect(await sheet.json()).toMatchObject({
			output: { id: outputId, title: "Opportunities" },
			revision: { content: { kind: "sheet" } },
		});
		expect((await readFile(connectedId)).status).toBe(404);
		expect((await readFile("not-a-file")).status).toBe(404);
	});

	it("opens only the workspace's own runtime apps for a guest", async () => {
		const { db, env } = await fixture();
		const link = await seedLink(db, workspaceLink());
		const sessionToken = await redeem(db, link.token);
		const open = (appId?: string) =>
			handleGuestAppOpen(env, db, {
				sessionToken,
				guestName: "Maya",
				...(appId ? { appId } : {}),
			});
		const opened = await open(gadgetId);
		expect(opened.status).toBe(200);
		expect(await opened.json()).toMatchObject({
			role: "use",
			app: { id: gadgetId, workspaceId },
		});
		// The workspace link names no app of its own, and a widget app needs sign-in.
		expect((await open()).status).toBe(404);
		expect((await open(widgetGadgetId)).status).toBe(404);
		// An app from another workspace is never in reach.
		await db.insert(osGadgets).values({
			id: "44444444-4444-4444-8444-444444444444",
			organizationId: "org-1",
			workspaceId: "other-workspace",
			name: "Elsewhere",
			currentRevisionId: revisionId,
			createdByKind: "user",
			createdById: "user-1",
		});
		expect((await open("44444444-4444-4444-8444-444444444444")).status).toBe(
			404,
		);
		const read = await handleGuestAppRead(db, {
			sessionToken,
			appId: gadgetId,
			slot: "opportunities",
		});
		expect(read.status).toBe(200);
	});

	it("a viewer link lists apps but opens none", async () => {
		const { db, env } = await fixture();
		const link = await seedLink(db, workspaceLink({ role: "viewer" }));
		const response = await handleOsShareRedemption(db, link.token);
		expect(response.status).toBe(200);
		const body = (await response.json()) as WorkspacePayload & {
			sessionToken: string;
		};
		expect(
			body.resource.gadgets.every((gadget) => !gadget.opensWithoutSignIn),
		).toBe(true);
		expect(
			(
				await handleGuestAppOpen(env, db, {
					sessionToken: body.sessionToken,
					guestName: "Maya",
					appId: gadgetId,
				})
			).status,
		).toBe(404);
	});

	it("a build link, or a link to a workspace made private, stays closed to guests", async () => {
		const { db } = await fixture();
		const build = await seedLink(db, workspaceLink({ role: "build" }));
		expect(await redeem(db, build.token)).toBeNull();
		const link = await seedLink(db, workspaceLink());
		const sessionToken = await redeem(db, link.token);
		expect(sessionToken).not.toBeNull();
		await db
			.update(osWorkspaces)
			.set({ visibility: "private" })
			.where(eq(osWorkspaces.id, workspaceId));
		expect(await redeem(db, link.token)).toBeNull();
		expect(
			(await handleOsShareSessionOutput(db, sessionToken!, outputId)).status,
		).toBe(404);
	});

	it("organization and invited workspace links still need a signed-in person", async () => {
		const { db } = await fixture();
		for (const access of ["organization", "invited"] as const) {
			const link = await seedLink(db, workspaceLink({ access }));
			expect(await redeem(db, link.token), access).toBeNull();
		}
	});

	it("tells the Share dialog what the link leaves out", async () => {
		const { db } = await fixture();
		expect(
			await workspaceGuestLimits(db, { organizationId: "org-1", workspaceId }),
		).toEqual({ hiddenFiles: 0, appsNeedingSignIn: 1 });
		await seedConnectedOutput(db);
		expect(
			await workspaceGuestLimits(db, { organizationId: "org-1", workspaceId }),
		).toEqual({ hiddenFiles: 1, appsNeedingSignIn: 1 });
	});
});

describe("guestAppRefusalForApp", () => {
	it("says an app that does not run its own code needs sign-in", async () => {
		const { db } = await fixture();
		expect(
			await guestAppRefusalForApp(db, {
				id: widgetGadgetId,
				organizationId: "org-1",
				workspaceId,
				currentRevisionId: widgetRevisionId,
			}),
		).toEqual({ reason: "not_runtime_app" });
		expect(
			await guestAppRefusalForApp(db, {
				id: gadgetId,
				organizationId: "org-1",
				workspaceId,
				currentRevisionId: revisionId,
			}),
		).toBeNull();
		expect(
			await guestAppRefusalForApp(db, {
				id: gadgetId,
				organizationId: "org-1",
				workspaceId,
				currentRevisionId: null,
			}),
		).toBeUndefined();
	});
});

describe("owner-approved guest skill reads", () => {
	async function researchFixture() {
		const f = await fixture();
		await f.db.insert(organizationMembers).values({
			id: "owner-member",
			organizationId: "org-1",
			userId: "user-1",
			descopeUserId: "provider-owner",
			email: "owner@example.test",
			role: "owner",
			status: "active",
		});
		await f.db
			.update(osGadgetRevisions)
			.set({
				manifest: JSON.stringify({
					entry: "tedix:runtime/v1",
					capabilities: [],
					resourceGrants: [{ slot: "research", operations: ["skills.read"] }],
				}),
			})
			.where(eq(osGadgetRevisions.id, revisionId));
		await f.db.insert(osWorkspaceResources).values({
			id: "research-resource",
			organizationId: "org-1",
			workspaceId,
			slot: "research",
			providerId: "tedix",
			connectionScope: "tenant",
			resourceType: "skill",
			providerResourceId: "fictional-skill",
			name: "Research",
			createdByKind: "user",
			createdById: "user-1",
		});
		const link = await seedLink(f.db);
		const row = (await getScopedOsShareLink(f.db, {
			organizationId: "org-1",
			shareLinkId: link.id,
		}))!;
		const context = userContext({
			env: f.env,
			organizationId: "org-1",
			userId: "user-1",
			sub: "provider-owner",
			permissions: ["settings:manage", "tedis:read"],
			userRole: "owner",
		});
		const scope = {
			organizationId: "org-1",
			workspaceId,
			gadgetId,
			revisionId,
			shareLinkId: link.id,
		};
		return { ...f, link, row, context, scope };
	}

	it("refuses without approval, opens only the approved share and delegates the existing skill read", async () => {
		const f = await researchFixture();
		const sessionToken = await redeem(f.db, f.link.token);
		expect(
			(
				await handleGuestAppOpen(f.env, f.db, {
					sessionToken,
					guestName: "Maya",
				})
			).status,
		).toBe(404);
		const grants = await prepareGuestSkillReadGrants(f.context, f.row, [
			"research",
		]);
		await setOsShareSkillReadGrants(f.db, f.scope, grants);
		const opened = await handleGuestAppOpen(f.env, f.db, {
			sessionToken,
			guestName: "Maya",
		});
		expect(opened.status).toBe(200);
		const body = (await opened.json()) as { session: string };
		const signed = await verifyWorkspaceAppSession(key, body.session);
		expect(signed.actorUserId).toBeUndefined();
		expect(signed.principal.kind).toBe("share_session");
		const reader = await import("../services/os-app-skill-read");
		const read = vi
			.spyOn(reader, "readWorkspaceAppSkill")
			.mockResolvedValue({ count: 11 });
		onTestFinished(() => read.mockRestore());
		const internal = createRouterClient(createOsAppRuntimeRouter(), {
			context: userContext({
				env: f.env,
				headers: { "X-Service-Binding": "true" },
			}),
		});
		await expect(
			internal.capability({
				session: body.session,
				operation: "skills.read",
				slot: "research",
				args: { view: "run", runId: revisionId },
			}),
		).resolves.toEqual({ count: 11 });
		expect(read.mock.calls[0]?.[0].userId).toBe("user-1");
		expect(read.mock.calls[0]?.[0].user?.sub).toBe("provider-owner");
		expect(read.mock.calls[0]?.[1].providerResourceId).toBe("fictional-skill");
		for (const input of [
			{ operation: "skills.read" as const, slot: "other" },
			{ operation: "skills.run" as const, slot: "research" },
			{ operation: "connections.call" as const, slot: "research" },
		])
			await expect(
				internal.capability({ session: body.session, ...input, args: {} }),
			).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(read).toHaveBeenCalledTimes(1);
		read.mockRejectedValueOnce(new Error("Source access denied"));
		await expect(
			internal.capability({
				session: body.session,
				operation: "skills.read",
				slot: "research",
				args: {},
			}),
		).rejects.toThrow("Source access denied");
		const other = await seedLink(f.db);
		expect(
			(
				await handleGuestAppOpen(f.env, f.db, {
					sessionToken: await redeem(f.db, other.token),
					guestName: "Maya",
				})
			).status,
		).toBe(404);
		await setOsShareSkillReadGrants(f.db, f.scope, []);
		await expect(
			internal.capability({
				session: body.session,
				operation: "skills.read",
				slot: "research",
				args: {},
			}),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(
			(
				await handleGuestAppCall(f.env, f.db, {
					sessionToken,
					session: body.session,
					method: "verdicts",
				})
			).status,
		).toBe(404);
	});

	it.each([
		"other organization",
		"other app",
		"other revision",
		"resource rebound",
		"approver removed",
		"approver demoted",
	])("invalidates approval after %s", async (change) => {
		const f = await researchFixture();
		await setOsShareSkillReadGrants(
			f.db,
			f.scope,
			await prepareGuestSkillReadGrants(f.context, f.row, ["research"]),
		);
		const scope = { ...f.scope };
		if (change === "other organization") scope.organizationId = "other-org";
		if (change === "other app") scope.gadgetId = widgetGadgetId;
		if (change === "other revision") scope.revisionId = widgetRevisionId;
		if (change === "resource rebound")
			await f.db
				.update(osWorkspaceResources)
				.set({ providerResourceId: "other-skill" })
				.where(eq(osWorkspaceResources.id, "research-resource"));
		if (change === "approver removed")
			await f.db.update(organizationMembers).set({ status: "deactivated" });
		if (change === "approver demoted")
			await f.db.update(organizationMembers).set({ role: "member" });
		expect(await approvedGuestSkillRead(f.db, scope, "research")).toBeNull();
	});

	it("rejects non-owner approval, non-read slots and other resource kinds", async () => {
		const f = await researchFixture();
		await expect(
			prepareGuestSkillReadGrants(f.context, f.row, ["opportunities"]),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		await expect(
			prepareGuestSkillReadGrants(
				f.context,
				{ ...f.row, resourceType: "workspace" },
				["research"],
			),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		await f.db.update(organizationMembers).set({ role: "member" });
		await expect(
			prepareGuestSkillReadGrants(f.context, f.row, ["research"]),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
	});

	it("records and withdraws approval through the owner share setting without changing app code", async () => {
		const f = await researchFixture();
		const owner = createRouterClient(osSharesContractRouter, {
			context: f.context,
		});
		const listed = () =>
			owner.shares.list({ resourceType: "gadget", resourceId: gadgetId });
		expect((await listed()).guestRefusal).toMatchObject({
			slot: "research",
			reason: "connection_grant",
		});
		await owner.shares.update({
			shareId: f.link.id,
			guestSkillReadSlots: ["research"],
		});
		expect((await listed()).guestRefusal).toBeNull();
		expect(
			await approvedGuestSkillRead(f.db, f.scope, "research"),
		).not.toBeNull();
		expect(
			(await f.db.select().from(osGadgets).where(eq(osGadgets.id, gadgetId)))[0]
				?.currentRevisionId,
		).toBe(revisionId);
		expect(await f.db.select().from(osGadgetCode)).toMatchObject([
			{ files: JSON.stringify(files) },
		]);
		await owner.shares.update({ shareId: f.link.id, guestSkillReadSlots: [] });
		expect((await listed()).guestRefusal).toMatchObject({ slot: "research" });
		const audits = await f.db.select().from(auditEvents);
		expect(
			audits.some(
				(a) =>
					a.action === "os.share_link.updated" &&
					JSON.stringify(a).includes("guestSkillReadSlots"),
			),
		).toBe(true);
	});
});
