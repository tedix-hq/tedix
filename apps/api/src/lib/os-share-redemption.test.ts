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
import {
	type NewOsShareLinkRow,
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
	generateOsShareToken,
	handleOsShareRedemption,
	handleOsShareSessionRead,
	hashOsShareToken,
	readOsSharedResource,
} from "./os-share-redemption";

function fixture() {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec("PRAGMA foreign_keys = OFF;");
	sqlite.exec(
		schemaDdl(
			osOutputs,
			osOutputRevisions,
			osWorkspaces,
			osGadgets,
			osGadgetRevisions,
			osShareLinks,
			osShareSessions,
		),
	);
	return createDbQueryClient(createD1Facade(sqlite));
}

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
		expect(response.headers.get("cache-control")).toBe("no-store");
		expect(await response.json()).toMatchObject({
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
