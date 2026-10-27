import { organizations } from "@tedix/db/schema/organizations";
import { eq } from "drizzle-orm";
import { DatabaseSync } from "node:sqlite";
import {
	countActiveOsShareSessions,
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
	osShareLinks,
	osShareSessions,
} from "@tedix/db/schema/os-shares";
import {
	osGadgetRevisions,
	osGadgets,
	osOutputRevisions,
	osOutputs,
	osWorkspaces,
} from "@tedix/db/schema/os-workspaces";
import { createD1Facade } from "@tedix/db/test/d1-facade";
import { schemaDdl } from "@tedix/db/test/schema-ddl";
import { describe, expect, it, vi } from "vite-plus/test";
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
			osOutputs,
			osOutputRevisions,
			osWorkspaces,
			osGadgets,
			osGadgetRevisions,
			osShareLinks,
			osShareSessions,
			osShareLinkInvitees,
			osWorkspaceCollaborators,
		),
	);
	sqlite.exec(
		"INSERT INTO organizations (id, name, slug, logo_url, descope_tenant_id) VALUES ('org-1', 'Example', 'example', 'https://images.example.test/org.png', 'tenant-1'), ('org-2', 'Other', 'other', NULL, 'tenant-2');",
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
		id?: string;
	} = {},
) {
	return handleOsShareOpen(
		db,
		options.id ?? PUBLIC_ID,
		options.host === undefined ? HOST : options.host,
		options.authorize,
		options.identify,
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
			share: { publicId: PUBLIC_ID, access: "anyone_with_link" },
			resource: { type: "output" },
		});
		expect((await handleOsShareSessionRead(db, body.sessionToken)).status).toBe(
			200,
		);
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

	it("an invited link admits people on its list by user id or email, and nobody else", async () => {
		const db = fixture();
		await seedOutput(db);
		await seedShare(db, { access: "invited" });
		const link = (await db.select().from(osShareLinks).limit(1))[0]!;
		expect((await openById(db)).status).toBe(200);
		expect(await (await openById(db)).json()).toMatchObject({
			needsSignIn: true,
			access: "invited",
		});
		// Signed in but not invited; membership in the organization changes nothing.
		expect(
			(await openById(db, { identify: asInvitee, authorize: allowRecipient }))
				.status,
		).toBe(404);
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
		expect((await openById(db, { identify: asInvitee })).status).toBe(404);
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
