import {
	requestOsShareEmailCode,
	verifyOsShareEmailCode,
	hashOsShareEmailCode,
} from "./os-share-email-code";
import { organizations } from "@tedix/db/schema/organizations";
import { apiKeys } from "@tedix/db/schema/api-keys";
import { externalAgentPrincipals } from "@tedix/db/schema/external-agent-identity";
import { organizationMembers } from "@tedix/db/schema/organization-members";
import { tedis } from "@tedix/db/schema/tedis";
import { eq } from "drizzle-orm";
import { DatabaseSync } from "node:sqlite";
import {
	countActiveOsShareSessions,
	listOsShareEmailOpens,
	createOsShareLink,
	getOsShareLinkByTokenHash,
	restrictOsShareLink,
	revokeOsShareLink,
} from "@tedix/db/queries/os-shares";
import {
	createOsGadget,
	createOsGadgetRevision,
	getOsGadgetRevision,
} from "@tedix/db/queries/os-workspaces/gadgets";
import {
	createOsOutput,
	createOsOutputRevision,
} from "@tedix/db/queries/os-workspaces/outputs";
import { createDbQueryClient } from "@tedix/db/query-client";
import { osWorkspaceCollaborators } from "@tedix/db/schema/os-collaborators";
import {
	type NewOsShareLinkRow,
	osShareLinkInvitees,
	osShareEmailCodes,
	osShareLinks,
	osShareSessions,
} from "@tedix/db/schema/os-shares";
import {
	osGadgetRevisions,
	osGadgets,
	osOutputRevisions,
	osOutputs,
	osWorkspaceResources,
	osWorkspaces,
} from "@tedix/db/schema/os-workspaces";
import { createD1Facade } from "@tedix/db/test/d1-facade";
import { schemaDdl } from "@tedix/db/test/schema-ddl";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
	generateOsSharePublicId,
	generateOsShareToken,
	handleOsShareOpen,
	handleOsSharePreview,
	handleOsShareRedemption,
	handleOsShareSessionRead,
	hashOsShareToken,
	osShareUrl,
	readOsSharedResource,
} from "./os-share-redemption";

function fixture() {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec("PRAGMA foreign_keys = OFF;");
	sqlite.exec(
		schemaDdl(
			organizations,
			organizationMembers,
			tedis,
			externalAgentPrincipals,
			apiKeys,
			osOutputs,
			osOutputRevisions,
			osWorkspaces,
			osWorkspaceResources,
			osGadgets,
			osGadgetRevisions,
			osShareLinks,
			osShareSessions,
			osShareLinkInvitees,
			osShareEmailCodes,
			osWorkspaceCollaborators,
		),
	);
	sqlite.exec(
		"INSERT INTO organizations (id, name, slug, logo_url, descope_tenant_id) VALUES ('org-1', 'Example', 'example', 'https://images.example.test/org.png', 'tenant-1'), ('org-2', 'Other', 'other', NULL, 'tenant-2');",
	);
	sqlite.exec(
		"INSERT INTO organization_members (id, organization_id, descope_user_id, email, name, role, status, kind) VALUES ('m-1', 'org-1', 'user-1', 'maya@example.test', 'Maya Chen', 'admin', 'active', 'human');",
	);
	return createDbQueryClient(createD1Facade(sqlite));
}

const PUBLIC_ID = "AbCdEfGhIjKlMnOpQrStUv";
const HOST = "tenant-1";

async function openById(
	db: ReturnType<typeof fixture>,
	options: {
		host?: string | null;
		authorize?: Parameters<typeof handleOsShareOpen>[3];
		identify?: Parameters<typeof handleOsShareOpen>[4];
		mayManage?: Parameters<typeof handleOsShareOpen>[5];
		id?: string;
	} = {},
) {
	return handleOsShareOpen(
		db,
		options.id ?? PUBLIC_ID,
		options.host === undefined ? HOST : options.host,
		options.authorize,
		options.identify,
		options.mayManage,
	);
}

const asInvitee = async () => ({
	userId: "guest-user",
	email: "Guest@Example.test",
});

const accountability = {
	organizationId: "org-1",
	createdByKind: "user" as const,
	createdById: "user-1",
	createdAt: "2026-08-14T10:00:00.000Z",
};

const allowRecipient = async () => true;

async function seedOutput(
	db: ReturnType<typeof fixture>,
	accessEnvelope: string | null = JSON.stringify({ version: 1, sources: [] }),
) {
	await createOsOutput(
		db,
		{ organizationId: "org-1" },
		{
			...accountability,
			id: "out-1",
			workspaceId: null,
			kind: "document",
			title: "Launch brief",
			status: "active",
			currentRevisionId: "rev-1",
			updatedAt: accountability.createdAt,
		},
		{
			...accountability,
			id: "rev-1",
			outputId: "out-1",
			revision: 1,
			content: '{"kind":"document","blocks":[]}',
			note: null,
			accessEnvelope,
		},
	);
}

async function seedShare(
	db: ReturnType<typeof fixture>,
	overrides: Partial<NewOsShareLinkRow> = {},
): Promise<string> {
	const token = generateOsShareToken();
	await createOsShareLink(db, {
		...accountability,
		id: crypto.randomUUID(),
		// The first link in a fixture takes the well-known id the open tests use.
		publicId: (await db.select().from(osShareLinks).limit(1)).length
			? generateOsSharePublicId()
			: PUBLIC_ID,
		resourceType: "output",
		resourceId: "out-1",
		tokenHash: await hashOsShareToken(token),
		role: "viewer",
		expiresAt: overrides.expiresAt ?? null,
		revokedAt: overrides.revokedAt ?? null,
		disabledAt: overrides.disabledAt ?? null,
		...overrides,
	});
	return token;
}

async function seedGadget(db: ReturnType<typeof fixture>) {
	await db.insert(osWorkspaces).values({
		...accountability,
		id: "workspace-1",
		name: "Shared workspace",
		description: "Safe collaboration",
		status: "active",
		updatedAt: accountability.createdAt,
	});
	await createOsGadget(db, {
		...accountability,
		id: "gadget-1",
		workspaceId: "workspace-1",
		name: "Launch dashboard",
		description: "Metrics",
		status: "active",
		currentRevisionId: null,
		updatedAt: accountability.createdAt,
	});
	const first = await createOsGadgetRevision(db, {
		id: "gadget-rev-1",
		organizationId: "org-1",
		gadgetId: "gadget-1",
		manifest: JSON.stringify({
			entry: "ui://widgets/mcp-app/tedix/r/launch.html",
			capabilities: ["metrics.read"],
			notes: "private build notes",
		}),
		createdByKind: "user",
		createdById: "user-1",
	});
	if (!first.ok) throw new Error("failed to seed Gadget revision");
	return first.revision;
}

describe("token helpers", () => {
	it("mints unpredictable 43-char base64url tokens and hex hashes", async () => {
		const token = generateOsShareToken();
		expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
		expect(generateOsShareToken()).not.toBe(token);
		const hash = await hashOsShareToken(token);
		expect(hash).toMatch(/^[0-9a-f]{64}$/);
		expect(await hashOsShareToken(token)).toBe(hash);
	});

	it("mints 22-char base62 public ids and builds the organization's own share URL", () => {
		const id = generateOsSharePublicId();
		expect(id).toMatch(/^[A-Za-z0-9]{22}$/);
		expect(generateOsSharePublicId()).not.toBe(id);
		expect(
			osShareUrl({ OS_URL: "https://os.tedix.test/" }, "example", id),
		).toBe(`https://example.os.tedix.test/s/${id}`);
		expect(osShareUrl({}, "example", id)).toBe(
			`https://example.os.tedix.dev/s/${id}`,
		);
	});
});

describe("handleOsShareOpen", () => {
	it("opens an anyone_with_link link by permanent id on its own host and mints a session", async () => {
		const db = fixture();
		await seedOutput(db);
		await seedShare(db);
		const response = await openById(db);
		expect(response.status).toBe(200);
		expect(response.headers.get("cache-control")).toBe("private, no-store");
		expect(response.headers.get("x-robots-tag")).toBe("noindex");
		const body = (await response.json()) as {
			needsSignIn: boolean;
			access: string;
			share: { publicId: string; access: string };
			sessionToken: string;
		};
		expect(body).toMatchObject({
			needsSignIn: false,
			access: "anyone_with_link",
			organization: { name: "Example" },
			share: {
				publicId: PUBLIC_ID,
				access: "anyone_with_link",
				sharedByName: "Maya Chen",
				slug: "launch-brief",
			},
			resource: { type: "output" },
			canManage: false,
		});
		// A refresh that names the version on screen gets no body back; a
		// stale or unknown version gets the current one in full.
		const refreshed = (knownRevisionId?: string) =>
			handleOsShareSessionRead(
				db,
				body.sessionToken,
				undefined,
				undefined,
				undefined,
				knownRevisionId,
			).then(
				(response) =>
					response.json() as Promise<{
						resource: { revision: Record<string, unknown> };
					}>,
			);
		expect((await refreshed("rev-1")).resource.revision).toEqual({
			id: "rev-1",
			revision: 1,
			unchanged: true,
			createdAt: accountability.createdAt,
		});
		expect((await refreshed("rev-0")).resource.revision).toMatchObject({
			id: "rev-1",
			content: { kind: "document", blocks: [] },
		});
		expect((await refreshed()).resource.revision).toHaveProperty("content");
		expect((await handleOsShareSessionRead(db, body.sessionToken)).status).toBe(
			200,
		);
	});

	it("names the caller a manager only when the may-manage check says so", async () => {
		const db = fixture();
		await seedOutput(db);
		await seedShare(db);
		const guest = (await (await openById(db)).json()) as {
			canManage: boolean;
		};
		expect(guest.canManage).toBe(false);
		const manager = (await (
			await openById(db, {
				authorize: async () => true,
				mayManage: async () => true,
			})
		).json()) as { canManage: boolean };
		expect(manager.canManage).toBe(true);
	});

	it("refuses a turned-off link identically to a revoked one, then revives on clear", async () => {
		const db = fixture();
		await seedOutput(db);
		const token = await seedShare(db, {
			disabledAt: "2026-08-14T11:00:00.000Z",
		});
		expect((await openById(db)).status).toBe(404);
		expect((await handleOsShareRedemption(db, token)).status).toBe(404);
		await db
			.update(osShareLinks)
			.set({ disabledAt: null })
			.where(eq(osShareLinks.publicId, PUBLIC_ID));
		expect((await openById(db)).status).toBe(200);
		expect((await handleOsShareRedemption(db, token)).status).toBe(200);
	});

	it("resolves only on the link's own organization host", async () => {
		const db = fixture();
		await seedOutput(db);
		await seedShare(db);
		// Another organization's host, the launcher (no tenant) and a missing host.
		expect((await openById(db, { host: "tenant-2" })).status).toBe(404);
		expect((await openById(db, { host: "org-2" })).status).toBe(404);
		expect((await openById(db, { host: null })).status).toBe(404);
		// OIDC organizations are asserted by organization id instead.
		expect((await openById(db, { host: "org-1" })).status).toBe(200);
		expect((await openById(db, { host: "tenant-1" })).status).toBe(200);
	});

	it("refuses unknown, malformed, revoked and expired ids identically", async () => {
		const db = fixture();
		await seedOutput(db);
		await seedShare(db, { revokedAt: "2026-08-14T11:00:00.000Z" });
		expect((await openById(db)).status).toBe(404);
		expect((await openById(db, { id: "nope" })).status).toBe(404);
		expect((await openById(db, { id: "0000000000000000000000" })).status).toBe(
			404,
		);
		const expired = fixture();
		await seedOutput(expired);
		await seedShare(expired, { expiresAt: "2020-01-01T00:00:00.000Z" });
		expect((await openById(expired)).status).toBe(404);
	});

	it("an organization link asks for sign-in, then admits only a member of that organization", async () => {
		const db = fixture();
		await seedOutput(db);
		await seedShare(db, { access: "organization" });
		const signedOut = await openById(db);
		expect(signedOut.status).toBe(200);
		expect(await signedOut.json()).toEqual({
			needsSignIn: true,
			access: "organization",
			organization: {
				name: "Example",
				logoUrl: "https://images.example.test/org.png",
				locale: null,
				copy: {},
			},
		});
		// Signed in, but the membership check fails: same 404 as an unknown link.
		const outsider = await openById(db, {
			identify: asInvitee,
			authorize: async () => false,
		});
		expect(outsider.status).toBe(404);
		const member = await openById(db, {
			identify: asInvitee,
			authorize: allowRecipient,
		});
		expect(member.status).toBe(200);
		const { sessionToken } = (await member.json()) as { sessionToken: string };
		// Every read re-proves membership; a session alone opens nothing.
		expect((await handleOsShareSessionRead(db, sessionToken)).status).toBe(404);
		expect(
			(await handleOsShareSessionRead(db, sessionToken, allowRecipient)).status,
		).toBe(200);
	});

	it("an invited link offers email verification, then admits people on its list by user id or email", async () => {
		const db = fixture();
		await seedOutput(db);
		await seedShare(db, { access: "invited" });
		const link = (await db.select().from(osShareLinks).limit(1))[0]!;
		expect((await openById(db)).status).toBe(200);
		expect(await (await openById(db)).json()).toMatchObject({
			needsSignIn: false,
			needsEmailCode: true,
			access: "invited",
		});
		const signedOut = await (await openById(db)).json();
		const outsider = await openById(db, {
			identify: asInvitee,
			authorize: allowRecipient,
		});
		expect(outsider.status).toBe(200);
		expect(await outsider.json()).toEqual(signedOut);
		expect(await db.select().from(osShareSessions)).toEqual([]);
		await db.insert(osShareLinkInvitees).values({
			id: "invitee-1",
			organizationId: "org-1",
			shareLinkId: link.id,
			email: "guest@example.test",
			userId: null,
			addedByKind: "user",
			addedById: "user-1",
		});
		// Email match is case-insensitive; no organization membership needed.
		const byEmail = await openById(db, { identify: asInvitee });
		expect(byEmail.status).toBe(200);
		const { sessionToken } = (await byEmail.json()) as { sessionToken: string };
		expect(
			(await handleOsShareSessionRead(db, sessionToken, undefined, asInvitee))
				.status,
		).toBe(200);
		// Removing the person ends their access on the next read.
		await db.delete(osShareLinkInvitees);
		expect(
			(await handleOsShareSessionRead(db, sessionToken, undefined, asInvitee))
				.status,
		).toBe(404);
		await db.insert(osShareLinkInvitees).values({
			id: "invitee-2",
			organizationId: "org-1",
			shareLinkId: link.id,
			email: "other@example.test",
			userId: "guest-user",
			addedByKind: "user",
			addedById: "user-1",
		});
		expect(
			(
				await openById(db, {
					identify: async () => ({ userId: "guest-user", email: null }),
				})
			).status,
		).toBe(200);
	});

	it("an invited workspace link also admits the workspace's collaborators", async () => {
		const db = fixture();
		await seedGadget(db);
		await seedShare(db, {
			access: "invited",
			resourceType: "workspace",
			resourceId: "workspace-1",
			role: "use",
		});
		expect(
			await (await openById(db, { identify: asInvitee })).json(),
		).toMatchObject({
			needsSignIn: false,
			needsEmailCode: true,
		});
		await db.insert(osWorkspaceCollaborators).values({
			id: "collab-1",
			organizationId: "org-1",
			workspaceId: "workspace-1",
			userId: "guest-user",
		});
		const opened = await openById(db, { identify: asInvitee });
		expect(opened.status).toBe(200);
		expect(await opened.json()).toMatchObject({
			share: { access: "invited", effectiveRole: "use" },
			resource: { type: "workspace", gadgets: [{ id: "gadget-1" }] },
		});
	});

	it("revocation ends the permanent address and every session at once", async () => {
		const db = fixture();
		await seedOutput(db);
		const token = await seedShare(db);
		const opened = (await (await openById(db)).json()) as {
			share: { id: string };
			sessionToken: string;
		};
		await revokeOsShareLink(db, {
			organizationId: "org-1",
			shareLinkId: opened.share.id,
		});
		expect((await openById(db)).status).toBe(404);
		expect(
			(await handleOsShareSessionRead(db, opened.sessionToken)).status,
		).toBe(404);
		expect((await handleOsShareRedemption(db, token)).status).toBe(404);
	});

	it("an old #token link still redeems and reports its permanent id", async () => {
		const db = fixture();
		await seedOutput(db);
		const token = await seedShare(db);
		const redeemed = await handleOsShareRedemption(db, token);
		expect(redeemed.status).toBe(200);
		expect(await redeemed.json()).toMatchObject({
			needsSignIn: false,
			access: "anyone_with_link",
			share: { publicId: PUBLIC_ID, access: "anyone_with_link" },
			sessionToken: expect.any(String),
		});
		// A token link to an organization link needs the same sign-in.
		const org = fixture();
		await seedOutput(org);
		const orgToken = await seedShare(org, { access: "organization" });
		expect((await handleOsShareRedemption(org, orgToken)).status).toBe(404);
		expect(
			(await handleOsShareRedemption(org, orgToken, allowRecipient)).status,
		).toBe(200);
	});
});

describe("handleOsSharePreview", () => {
	const GENERIC = { kind: "generic" };
	async function preview(
		db: ReturnType<typeof fixture>,
		options: { id?: string; host?: string | null } = {},
	) {
		const response = await handleOsSharePreview(
			db,
			options.id ?? PUBLIC_ID,
			options.host === undefined ? HOST : options.host,
		);
		expect(response.status).toBe(200);
		expect(response.headers.get("cache-control")).toBe("private, no-store");
		expect(response.headers.get("x-robots-tag")).toBe("noindex");
		return response.json();
	}

	it("names a link anyone may open, and opens no session", async () => {
		const db = fixture();
		await seedOutput(db);
		await seedShare(db);
		expect(await preview(db)).toEqual({
			kind: "content",
			title: "Launch brief",
			description: null,
			resourceType: "output",
			organizationName: "Example",
		});
		expect(await db.select().from(osShareSessions)).toHaveLength(0);
	});

	it("names an app that runs for guests, and keeps other apps generic", async () => {
		const db = fixture();
		await seedGadget(db);
		await seedShare(db, {
			resourceType: "gadget",
			resourceId: "gadget-1",
			role: "use",
		});
		// An app that is not a runtime app needs a member to open it.
		expect(await preview(db)).toEqual(GENERIC);
		const runtime = await createOsGadgetRevision(db, {
			id: "gadget-rev-2",
			organizationId: "org-1",
			gadgetId: "gadget-1",
			manifest: JSON.stringify({ entry: "tedix:runtime/v1" }),
			createdByKind: "user",
			createdById: "user-1",
		});
		expect(runtime.ok).toBe(true);
		expect(await preview(db)).toEqual({
			kind: "content",
			title: "Launch dashboard",
			description: "Metrics",
			resourceType: "gadget",
			organizationName: "Example",
		});
	});

	it("names a workspace anyone may open, and opens it signed out by permanent id", async () => {
		const db = fixture();
		await seedGadget(db);
		await seedShare(db, {
			resourceType: "workspace",
			resourceId: "workspace-1",
			role: "use",
		});
		expect(await preview(db)).toEqual({
			kind: "content",
			title: "Shared workspace",
			description: "Safe collaboration",
			resourceType: "workspace",
			organizationName: "Example",
		});
		const opened = await openById(db);
		expect(opened.status).toBe(200);
		expect(await opened.json()).toMatchObject({
			needsSignIn: false,
			share: { access: "anyone_with_link", slug: "shared-workspace" },
			resource: {
				type: "workspace",
				files: [],
				hiddenFileCount: 0,
				gadgets: [{ id: "gadget-1", opensWithoutSignIn: false }],
			},
		});
		// A workspace made private stops the link and its preview.
		await db.update(osWorkspaces).set({ visibility: "private" });
		expect((await openById(db)).status).toBe(404);
		expect(await preview(db)).toEqual(GENERIC);
	});

	it("keeps organization and invited links generic", async () => {
		for (const access of ["organization", "invited"] as const) {
			const db = fixture();
			await seedOutput(db);
			await seedShare(db, { access });
			expect(await preview(db)).toEqual(GENERIC);
		}
	});

	it("keeps protected files generic: their content needs a checked recipient", async () => {
		const db = fixture();
		await seedOutput(
			db,
			JSON.stringify({
				version: 1,
				sources: [
					{
						workspaceResourceId: "00000000-0000-4000-8000-000000000001",
						workspaceId: "00000000-0000-4000-8000-000000000002",
						providerId: "github",
						resourceType: "repository",
						providerResourceId: "tedix-hq/tedix",
						connectionScope: "tenant",
						requiredScopes: ["repo:read"],
						operations: ["read"],
					},
				],
			}),
		);
		await seedShare(db);
		expect(await preview(db)).toEqual(GENERIC);
	});

	it("answers unknown, revoked and other-host ids with the same generic preview", async () => {
		const db = fixture();
		await seedOutput(db);
		await seedShare(db);
		expect(await preview(db, { host: "tenant-2" })).toEqual(GENERIC);
		expect(await preview(db, { host: null })).toEqual(GENERIC);
		expect(await preview(db, { id: "nope" })).toEqual(GENERIC);
		expect(await preview(db, { id: "0000000000000000000000" })).toEqual(
			GENERIC,
		);
		const revoked = fixture();
		await seedOutput(revoked);
		await seedShare(revoked, { revokedAt: "2026-08-14T11:00:00.000Z" });
		expect(await preview(revoked)).toEqual(GENERIC);
	});
});

describe("handleOsShareRedemption", () => {
	it("fails closed for protected output bytes until the exact envelope is authorized", async () => {
		const db = fixture();
		const envelope = {
			version: 1 as const,
			sources: [
				{
					workspaceResourceId: "00000000-0000-4000-8000-000000000001",
					workspaceId: "00000000-0000-4000-8000-000000000002",
					providerId: "github",
					resourceType: "repository",
					providerResourceId: "tedix-hq/tedix",
					connectionScope: "tenant" as const,
					requiredScopes: ["repo:read"],
					operations: ["read"],
				},
			],
		};
		await seedOutput(db, JSON.stringify(envelope));
		const token = await seedShare(db);
		expect((await handleOsShareRedemption(db, token)).status).toBe(404);
		const authorizeRecipient = vi.fn(async (_link, role, access) => {
			expect(role).toBe("viewer");
			expect(access).toEqual(envelope);
			return true;
		});
		expect(
			(await handleOsShareRedemption(db, token, authorizeRecipient)).status,
		).toBe(200);
		// Redemption rechecks recipient authority after the conditional session
		// insert so a concurrent policy/resource change cannot use stale approval.
		expect(authorizeRecipient).toHaveBeenCalledTimes(2);
	});

	it("fails closed when revision provenance is legacy or invalid", async () => {
		const db = fixture();
		await seedOutput(db, null);
		const token = await seedShare(db);
		expect(
			(await handleOsShareRedemption(db, token, allowRecipient)).status,
		).toBe(404);
	});

	it("fails closed for malformed output provenance without invoking recipient authorization", async () => {
		const db = fixture();
		await seedOutput(db, '{"version":1,"sources":"invalid"}');
		const token = await seedShare(db);
		const authorizeRecipient = vi.fn(allowRecipient);
		expect(
			(await handleOsShareRedemption(db, token, authorizeRecipient)).status,
		).toBe(404);
		expect(authorizeRecipient).not.toHaveBeenCalled();
	});
	it("serves the output's current revision as JSON for a live token", async () => {
		const db = fixture();
		await seedOutput(db);
		const token = await seedShare(db);
		const response = await handleOsShareRedemption(db, token);
		expect(response.status).toBe(200);
		expect(response.headers.get("cache-control")).toBe("private, no-store");
		expect(response.headers.get("x-robots-tag")).toBe("noindex");
		expect(await response.json()).toMatchObject({
			organization: {
				name: "Example",
				logoUrl: "https://images.example.test/org.png",
			},
			share: {
				resourceType: "output",
				role: "viewer",
				effectiveRole: "viewer",
				revisionMode: "living",
			},
			resource: {
				type: "output",
				output: { id: "out-1", title: "Launch brief", kind: "document" },
				revision: {
					revision: 1,
					content: { kind: "document", blocks: [] },
					createdAt: accountability.createdAt,
				},
			},
			sessionToken: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
		});
	});

	it("gives the guest the organization's visitor language and only its share wording", async () => {
		const db = fixture();
		await db
			.update(organizations)
			.set({
				metadata: {
					tediWidget: {
						locale: "de-DE",
						translations: {
							de: { share_can_use: "Darf nutzen", title: "Assistent" },
						},
					},
				} as never,
			})
			.where(eq(organizations.id, "org-1"));
		await seedOutput(db);
		const token = await seedShare(db);
		const body = (await (await handleOsShareRedemption(db, token)).json()) as {
			organization: unknown;
		};
		expect(body.organization).toEqual({
			name: "Example",
			logoUrl: "https://images.example.test/org.png",
			locale: "de-DE",
			copy: { de: { share_can_use: "Darf nutzen" } },
		});
	});

	it("follows the current revision after a revise", async () => {
		const db = fixture();
		await seedOutput(db);
		const token = await seedShare(db);
		await createOsOutputRevision(db, {
			id: "rev-2",
			organizationId: "org-1",
			outputId: "out-1",
			content:
				'{"kind":"document","blocks":[{"type":"paragraph","text":"v2"}]}',
			createdByKind: "user",
			createdById: "user-1",
			accessEnvelope: JSON.stringify({ version: 1, sources: [] }),
		});
		const body = (await (await handleOsShareRedemption(db, token)).json()) as {
			resource: { revision: { revision: number } };
		};
		expect(body.resource.revision.revision).toBe(2);
	});

	it("rechecks a living link when a later revision becomes source-protected", async () => {
		const db = fixture();
		await seedOutput(db);
		const token = await seedShare(db);
		const opened = (await (
			await handleOsShareRedemption(db, token)
		).json()) as { sessionToken: string };
		await createOsOutputRevision(db, {
			id: "rev-protected",
			organizationId: "org-1",
			outputId: "out-1",
			content: '{"kind":"document","blocks":[]}',
			createdByKind: "tedi",
			createdById: "tedi-1",
			accessEnvelope: JSON.stringify({
				version: 1,
				sources: [
					{
						workspaceResourceId: "00000000-0000-4000-8000-000000000001",
						workspaceId: "00000000-0000-4000-8000-000000000002",
						providerId: "github",
						resourceType: "repository",
						providerResourceId: "tedix-hq/tedix",
						connectionScope: "tenant",
						requiredScopes: ["repo:read"],
						operations: ["read"],
					},
				],
			}),
		});
		expect(
			(await handleOsShareSessionRead(db, opened.sessionToken)).status,
		).toBe(404);
	});

	it("rechecks a forwarded protected link and its existing session against the current recipient", async () => {
		const db = fixture();
		await seedOutput(
			db,
			JSON.stringify({
				version: 1,
				sources: [
					{
						workspaceResourceId: "00000000-0000-4000-8000-000000000001",
						workspaceId: "00000000-0000-4000-8000-000000000002",
						providerId: "github",
						resourceType: "repository",
						providerResourceId: "tedix-hq/tedix",
						connectionScope: "tenant",
						requiredScopes: ["repo:read"],
						operations: ["read"],
					},
				],
			}),
		);
		const token = await seedShare(db);
		const opened = (await (
			await handleOsShareRedemption(db, token, async () => true)
		).json()) as { sessionToken: string };

		expect(
			(await handleOsShareRedemption(db, token, async () => false)).status,
		).toBe(404);
		expect(
			(
				await handleOsShareSessionRead(
					db,
					opened.sessionToken,
					async () => false,
				)
			).status,
		).toBe(404);
	});

	it("refuses unknown, revoked, expired, and malformed tokens identically", async () => {
		const db = fixture();
		await seedOutput(db);
		const revoked = await seedShare(db, {
			revokedAt: "2026-08-14T11:00:00.000Z",
		});
		const expired = await seedShare(db, {
			expiresAt: "2020-01-01T00:00:00.000Z",
		});
		const refusals = await Promise.all([
			handleOsShareRedemption(db, generateOsShareToken()),
			handleOsShareRedemption(db, revoked),
			handleOsShareRedemption(db, expired),
			handleOsShareRedemption(db, "../../etc/passwd"),
			handleOsShareRedemption(db, ""),
		]);
		const bodies = await Promise.all(refusals.map((r) => r.text()));
		for (const response of refusals) {
			expect(response.status).toBe(404);
		}
		// No oracle: every refusal is byte-identical.
		expect(new Set(bodies).size).toBe(1);
	});

	it("still honors a future expiry", async () => {
		const db = fixture();
		await seedOutput(db);
		const token = await seedShare(db, {
			expiresAt: "2099-01-01T00:00:00.000Z",
		});
		expect((await handleOsShareRedemption(db, token)).status).toBe(200);
	});

	it("refuses when the shared output no longer resolves", async () => {
		const db = fixture();
		// Share exists but its output was never created (or was deleted).
		const token = await seedShare(db);
		expect((await handleOsShareRedemption(db, token)).status).toBe(404);
	});

	it("gives use sessions only the runnable entry and no build path", async () => {
		const db = fixture();
		const seeded = await seedGadget(db);
		expect((await db.select().from(osGadgets))[0]).toMatchObject({
			currentRevisionId: seeded.id,
			status: "active",
		});
		expect(
			await getOsGadgetRevision(db, {
				organizationId: "org-1",
				revisionId: seeded.id,
			}),
		).toMatchObject({ gadgetId: "gadget-1" });
		const token = await seedShare(db, {
			resourceType: "gadget",
			resourceId: "gadget-1",
			role: "use",
		});
		const storedLink = await getOsShareLinkByTokenHash(
			db,
			await hashOsShareToken(token),
		);
		expect(storedLink).toMatchObject({
			resourceType: "gadget",
			resourceId: "gadget-1",
			role: "use",
		});
		expect(await readOsSharedResource(db, storedLink!)).not.toBeNull();
		expect((await handleOsShareRedemption(db, token)).status).toBe(404);
		const response = await handleOsShareRedemption(db, token, allowRecipient);
		expect(await db.select().from(osShareSessions)).toHaveLength(1);
		expect(response.status).toBe(200);
		const body = (await response.json()) as {
			share: { effectiveRole: string };
			resource: {
				revision: { manifest: Record<string, unknown> };
				openPath: string | null;
			};
		};
		expect(body.share.effectiveRole).toBe("use");
		expect(body.resource.revision.manifest).toEqual({
			entry: "ui://widgets/mcp-app/tedix/r/launch.html",
		});
		expect(body.resource.openPath).toBeNull();
	});

	it("keeps pinned build links immutable while living links follow revisions", async () => {
		const db = fixture();
		const first = await seedGadget(db);
		const pinnedToken = await seedShare(db, {
			resourceType: "gadget",
			resourceId: "gadget-1",
			role: "build",
			revisionMode: "pinned",
			pinnedRevisionId: first.id,
		});
		const livingToken = await seedShare(db, {
			resourceType: "gadget",
			resourceId: "gadget-1",
			role: "build",
		});
		const second = await createOsGadgetRevision(db, {
			id: "gadget-rev-2",
			organizationId: "org-1",
			gadgetId: "gadget-1",
			manifest: JSON.stringify({
				entry: "ui://widgets/mcp-app/tedix/r/launch-v2.html",
				capabilities: ["metrics.read"],
			}),
			createdByKind: "user",
			createdById: "user-1",
		});
		if (!second.ok) throw new Error("failed to revise Gadget");
		const pinned = (await (
			await handleOsShareRedemption(db, pinnedToken, allowRecipient)
		).json()) as { resource: { revision: { revision: number } } };
		const living = (await (
			await handleOsShareRedemption(db, livingToken, allowRecipient)
		).json()) as {
			resource: {
				revision: { revision: number; manifest: { entry: string } };
				openPath: string;
			};
		};
		expect(pinned.resource.revision.revision).toBe(1);
		expect(living.resource.revision.revision).toBe(2);
		expect(living.resource.revision.manifest.entry).toContain("launch-v2");
		expect(living.resource.openPath).toBe("/canvas?workspace=workspace-1");
	});

	it("supports duplicate redemption and kills every live session on revoke", async () => {
		const db = fixture();
		await seedOutput(db);
		const token = await seedShare(db);
		const first = (await (await handleOsShareRedemption(db, token)).json()) as {
			sessionToken: string;
		};
		const second = (await (
			await handleOsShareRedemption(db, token)
		).json()) as {
			sessionToken: string;
		};
		expect(first.sessionToken).not.toBe(second.sessionToken);
		const link = await db.select().from(osShareLinks).limit(1);
		expect(
			await countActiveOsShareSessions(
				db,
				link[0]!.id,
				new Date().toISOString(),
			),
		).toBe(2);
		await revokeOsShareLink(db, {
			organizationId: "org-1",
			shareLinkId: link[0]!.id,
		});
		expect(
			(await handleOsShareSessionRead(db, first.sessionToken)).status,
		).toBe(404);
		expect(
			(await handleOsShareSessionRead(db, second.sessionToken)).status,
		).toBe(404);
	});

	it("revokes an already-open build session when policy tightens", async () => {
		const db = fixture();
		await seedGadget(db);
		const token = await seedShare(db, {
			resourceType: "gadget",
			resourceId: "gadget-1",
			role: "build",
		});
		const authorizedRoles: string[] = [];
		const authorizeRecipient = async (_link: unknown, role: string) => {
			authorizedRoles.push(role);
			return true;
		};
		const opened = (await (
			await handleOsShareRedemption(db, token, authorizeRecipient)
		).json()) as {
			share: { id: string; effectiveRole: string };
			sessionToken: string;
		};
		expect(opened.share.effectiveRole).toBe("build");
		await restrictOsShareLink(db, {
			organizationId: "org-1",
			shareLinkId: opened.share.id,
			maxRole: "use",
			reason: "Sensitive observation",
		});
		expect(
			(
				await handleOsShareSessionRead(
					db,
					opened.sessionToken,
					authorizeRecipient,
				)
			).status,
		).toBe(404);
		expect(authorizedRoles).toEqual(["build", "build"]);
	});
});

describe("invited email codes", () => {
	afterEach(() => vi.useRealTimers());
	async function setup(
		resourceType: "output" | "workspace" | "gadget" = "output",
	) {
		const db = fixture();
		await seedOutput(db);
		await seedGadget(db);
		await seedShare(db, {
			access: "invited",
			resourceType,
			resourceId:
				resourceType === "output"
					? "out-1"
					: resourceType === "workspace"
						? "workspace-1"
						: "gadget-1",
		});
		const link = (await db.select().from(osShareLinks))[0]!;
		await db.insert(osShareLinkInvitees).values({
			id: "email-invite",
			organizationId: "org-1",
			shareLinkId: link.id,
			email: "guest@example.test",
			addedByKind: "user",
			addedById: "user-1",
		});
		const send = vi.fn(async (_message: { text: string }) => ({
			messageId: "test-message",
		}));
		const env = {
			SECRETS_MASTER_KEY: "test-email-hmac-key",
			SHARE_EMAIL_FROM: "noreply@example.test",
			EMAIL: { send },
		} as unknown as CloudflareEnv;
		const input = {
			id: PUBLIC_ID,
			email: "guest@example.test",
			ip: "192.0.2.1",
			hostTenantId: HOST,
		};
		const request = (overrides = {}) =>
			requestOsShareEmailCode(env, db, { ...input, ...overrides });
		const verify = (code: string, overrides = {}) =>
			verifyOsShareEmailCode(env, db, { ...input, code, ...overrides });
		const sentCode = () =>
			send.mock.calls.at(-1)![0].text.match(/Your code is (\d{6})/)![1]!;
		return { db, link, env, send, input, request, verify, sentCode };
	}

	it.each(["output", "workspace", "gadget"] as const)(
		"opens %s links without creating an account and stores only HMAC proof",
		async (kind) => {
			const t = await setup(kind);
			const identify = async () => ({
				userId: "other-user",
				email: "other@example.test",
			});
			const prompt = await openById(t.db, { identify });
			expect(prompt.status).toBe(200);
			expect(await prompt.json()).toEqual(await (await openById(t.db)).json());
			expect(await t.db.select().from(osShareSessions)).toEqual([]);
			expect(
				await (await t.request({ email: "other@example.test" })).json(),
			).toEqual({
				message: "If this email is invited, we sent a code",
			});
			expect(t.send).not.toHaveBeenCalled();
			const beforeMembers = await t.db.select().from(organizationMembers);
			const beforeWorkspaces = await t.db.select().from(osWorkspaces);
			expect(
				await (await t.request({ email: " Guest@Example.test " })).json(),
			).toEqual({ message: "If this email is invited, we sent a code" });
			const code = t.sentCode();
			const [challenge] = await t.db
				.select()
				.from(osShareEmailCodes)
				.where(eq(osShareEmailCodes.email, t.input.email));
			expect(challenge!.codeHash).not.toContain(code);
			expect(challenge!.codeHash).toBe(
				await hashOsShareEmailCode(
					t.env.SECRETS_MASTER_KEY,
					t.link.id,
					t.input.email,
					code,
				),
			);
			expect(
				await hashOsShareEmailCode("other-key", t.link.id, t.input.email, code),
			).not.toBe(challenge!.codeHash);
			expect(
				await hashOsShareEmailCode(
					t.env.SECRETS_MASTER_KEY,
					"other-link",
					t.input.email,
					code,
				),
			).not.toBe(challenge!.codeHash);
			expect(t.send.mock.calls[0]![0].text).toContain("Maya Chen");
			if (kind !== "output")
				expect(t.send.mock.calls[0]![0].text).toContain("Shared workspace");
			const opened = (await (await t.verify(code)).json()) as {
				sessionToken: string;
			};
			expect(opened.sessionToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
			const [session] = await t.db.select().from(osShareSessions);
			expect(session!.verifiedEmail).toBe(t.input.email);
			const opens = await listOsShareEmailOpens(t.db, {
				organizationId: "org-1",
				shareLinkId: t.link.id,
			});
			expect(opens).toEqual([
				{ email: t.input.email, openedAt: session!.createdAt },
			]);
			expect(
				await listOsShareEmailOpens(t.db, {
					organizationId: "org-2",
					shareLinkId: t.link.id,
				}),
			).toEqual([]);
			expect(
				Date.parse(session!.expiresAt) - Date.parse(session!.createdAt),
			).toBeGreaterThanOrEqual(7 * 24 * 60 * 60 * 1000);
			expect(
				(
					await handleOsShareSessionRead(
						t.db,
						opened.sessionToken,
						undefined,
						identify,
					)
				).status,
			).toBe(200);
			expect(await (await t.verify(code)).json()).toHaveProperty("error");
			expect(await t.db.select().from(organizationMembers)).toEqual(
				beforeMembers,
			);
			expect(await t.db.select().from(osWorkspaces)).toEqual(beforeWorkspaces);
			await t.db.delete(osShareLinkInvitees);
			expect(
				(await handleOsShareSessionRead(t.db, opened.sessionToken)).status,
			).toBe(404);
		},
	);

	it.each(["external_agent", "tedi", "api_key"] as const)(
		"attributes %s invitations to the organization",
		async (createdByKind) => {
			const t = await setup("workspace");
			await t.db.insert(externalAgentPrincipals).values({
				id: "agent-1",
				organizationId: "org-1",
				key: "local-agent",
				displayName: "Local coding agents (user@hostname.local)",
				credentialBindingType: "owner_user",
				credentialBindingId: "user-1",
				createdByType: "user",
				createdById: "user-1",
			});
			await t.db.insert(tedis).values({
				id: "agent-1",
				organizationId: "org-1",
				name: "Internal agent",
				slug: "internal-agent",
			});
			await t.db.insert(apiKeys).values({
				id: "agent-1",
				organizationId: "org-1",
				name: "Internal API client",
				keyHash: "test-key-hash",
				keyPreview: "test-key",
			});
			await t.db
				.update(osShareLinks)
				.set({ createdByKind, createdById: "agent-1" });
			await t.request();
			expect(t.send).toHaveBeenCalledTimes(1);
			expect(t.send.mock.calls[0]![0].text).toMatch(
				/^Example shared Shared workspace with you\./,
			);
			expect(t.send.mock.calls[0]![0].text).not.toContain("hostname.local");
		},
	);

	it.each([
		{ name: null, kind: "human" },
		{ name: "   ", kind: "human" },
		{
			name: "Local coding agents (user@hostname.local)",
			kind: "external_agent",
		},
		{ name: "Browser agent", kind: "browser_agent" },
	] as const)(
		"uses the organization for membership $kind with name $name",
		async (member) => {
			const t = await setup("workspace");
			await t.db.update(organizationMembers).set(member);
			await t.request();
			expect(t.send).toHaveBeenCalledTimes(1);
			expect(t.send.mock.calls[0]![0].text).toMatch(
				/^Example shared Shared workspace with you\./,
			);
			expect(t.send.mock.calls[0]![0].text).not.toContain("maya@example.test");
		},
	);

	it("uses the organization when the creator membership is missing", async () => {
		const t = await setup("workspace");
		await t.db.delete(organizationMembers);
		await t.request();
		expect(t.send.mock.calls[0]![0].text).toMatch(
			/^Example shared Shared workspace with you\./,
		);
	});

	it("returns the uniform reply before email transport completes", async () => {
		const t = await setup();
		let release!: () => void;
		const pending = new Promise<void>((resolve) => {
			release = resolve;
		});
		t.send.mockImplementation(async () => {
			await pending;
			return { messageId: "test-message" };
		});
		const background: Promise<unknown>[] = [];
		const reply = await requestOsShareEmailCode(
			t.env,
			t.db,
			t.input,
			(work) => {
				background.push(work);
			},
		);
		expect(await reply.json()).toEqual({
			message: "If this email is invited, we sent a code",
		});
		expect(background).toHaveLength(1);
		release();
		await Promise.all(background);
		expect(t.send).toHaveBeenCalledTimes(1);
	});

	it("uses the configured sender and keeps missing configuration private", async () => {
		const t = await setup();
		const expected = await (await t.request()).text();
		expect(t.send).toHaveBeenCalledWith(
			expect.objectContaining({
				from: { email: "noreply@example.test", name: "Tedix" },
			}),
		);
		const log = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			const reply = await requestOsShareEmailCode(
				{ ...t.env, SHARE_EMAIL_FROM: undefined },
				t.db,
				t.input,
			);
			expect(await reply.text()).toBe(expected);
			expect(t.send).toHaveBeenCalledTimes(1);
			expect(log).toHaveBeenCalledWith(
				"[os-share-email-code] SHARE_EMAIL_FROM is not configured",
			);
		} finally {
			log.mockRestore();
		}
	});

	it("returns identical replies for wrong email, unknown link, wrong host and rate limits", async () => {
		const t = await setup();
		const expected = await (await t.request()).text();
		for (const overrides of [
			{ email: "stranger@example.test" },
			{ id: "Z".repeat(22) },
			{ hostTenantId: "other-tenant" },
		]) {
			expect(await (await t.request(overrides)).text()).toBe(expected);
		}
		expect(t.send).toHaveBeenCalledTimes(1);
		expect(
			await (
				await t.verify(t.sentCode(), { email: "stranger@example.test" })
			).json(),
		).toHaveProperty("error");
		expect(await t.db.select().from(osShareSessions)).toHaveLength(0);
	});

	it("expires at ten minutes, limits guesses to five, and invalidates older codes", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-11-10T18:00:00Z"));
		const t = await setup();
		await t.request();
		const first = t.sentCode();
		vi.setSystemTime(new Date("2026-11-10T18:10:00Z"));
		expect(await (await t.verify(first)).json()).toHaveProperty("error");
		await t.request();
		const second = t.sentCode();
		for (let i = 0; i < 5; i++)
			expect(await (await t.verify("not-a-code")).json()).toHaveProperty(
				"error",
			);
		expect(await (await t.verify(second)).json()).toHaveProperty("error");
		vi.setSystemTime(new Date("2026-11-10T18:11:00Z"));
		await t.request();
		const third = t.sentCode();
		expect(await (await t.verify(first)).json()).toHaveProperty("error");
		expect(await (await t.verify(third)).json()).toHaveProperty("sessionToken");
	});

	it("allows the fifth guess but only one concurrent successful redemption", async () => {
		const t = await setup();
		await t.request();
		for (let i = 0; i < 4; i++) await t.verify("wrong");
		const replies = await Promise.all([
			t.verify(t.sentCode()),
			t.verify(t.sentCode()),
		]);
		const bodies = (await Promise.all(replies.map((r) => r.json()))) as Array<{
			sessionToken?: string;
		}>;
		expect(bodies.filter((r) => r.sessionToken)).toHaveLength(1);
		expect(await t.db.select().from(osShareSessions)).toHaveLength(1);
	});

	it("limits sends to three per email and twenty per IP in a rolling fifteen minutes", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-11-10T18:00:00Z"));
		const t = await setup();
		await Promise.all(Array.from({ length: 8 }, () => t.request()));
		expect(t.send).toHaveBeenCalledTimes(3);
		for (let i = 0; i < 25; i++)
			await t.request({ email: `stranger${i}@example.test` });
		expect(await t.db.select().from(osShareEmailCodes)).toHaveLength(20);
		await t.request({ email: "guest@example.test", ip: "192.0.2.2" });
		expect(t.send).toHaveBeenCalledTimes(3);
		vi.setSystemTime(new Date("2026-11-10T18:15:00Z"));
		await t.request();
		expect(t.send).toHaveBeenCalledTimes(4);
	});

	it("refuses a removed invitee's unredeemed code and an expired session", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-11-10T18:00:00Z"));
		const t = await setup();
		await t.request();
		const opened = (await (await t.verify(t.sentCode())).json()) as {
			sessionToken: string;
		};
		vi.setSystemTime(new Date("2026-11-17T18:00:00Z"));
		expect(
			(await handleOsShareSessionRead(t.db, opened.sessionToken)).status,
		).toBe(404);
		await t.request();
		await t.db.delete(osShareLinkInvitees);
		expect(await (await t.verify(t.sentCode())).json()).toHaveProperty("error");
	});
});
