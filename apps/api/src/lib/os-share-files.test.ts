import { organizations } from "@tedix/db/schema/organizations";
import { organizationMembers } from "@tedix/db/schema/organization-members";
import { eq } from "drizzle-orm";
import { DatabaseSync } from "node:sqlite";
import {
	createOsShareLink,
	revokeOsShareLink,
} from "@tedix/db/queries/os-shares";
import { createOsOutput } from "@tedix/db/queries/os-workspaces/outputs";
import { createDbQueryClient } from "@tedix/db/query-client";
import {
	type NewOsShareLinkRow,
	osShareLinkInvitees,
	osShareLinks,
	osShareSessions,
} from "@tedix/db/schema/os-shares";
import {
	osOutputRevisions,
	osOutputs,
	osWorkspaceResources,
	osWorkspaces,
} from "@tedix/db/schema/os-workspaces";
import { createD1Facade } from "@tedix/db/test/d1-facade";
import { schemaDdl } from "@tedix/db/test/schema-ddl";
import { describe, expect, it } from "vite-plus/test";
import { handleOsShareFile, serveOsShareFile } from "./os-share-files";
import {
	generateOsShareToken,
	handleOsShareRedemption,
	hashOsShareToken,
	openOsShareSession,
} from "./os-share-redemption";
import { workspaceFileKey } from "./workspace-files";

const ORG = "org-fictional";
const WORKSPACE = "11111111-1111-4111-8111-111111111111";
const VIDEO = "22222222-2222-4222-8222-222222222222";
const OTHER_FILE = "33333333-3333-4333-8333-333333333333";
const BYTES = new TextEncoder().encode("0123456789");
const accountability = {
	organizationId: ORG,
	createdByKind: "user" as const,
	createdById: "user-1",
	createdAt: "2026-08-14T10:00:00.000Z",
};

function bucket() {
	const objects = new Map<string, Uint8Array>();
	return {
		objects,
		get: async (
			key: string,
			options?: { range: { offset: number; length: number } },
		) => {
			const bytes = objects.get(key);
			if (!bytes) return null;
			const slice = options
				? bytes.slice(
						options.range.offset,
						options.range.offset + options.range.length,
					)
				: bytes;
			return {
				size: bytes.length,
				body: slice,
				json: async () => JSON.parse(new TextDecoder().decode(bytes)),
			};
		},
		head: async (key: string) => {
			const bytes = objects.get(key);
			return bytes ? { size: bytes.length } : null;
		},
	};
}

async function storeFile(
	r2: ReturnType<typeof bucket>,
	resourceId: string,
	filename: string,
) {
	const key = workspaceFileKey(ORG, WORKSPACE, resourceId);
	r2.objects.set(key, BYTES);
	r2.objects.set(
		`${key}.json`,
		new TextEncoder().encode(
			JSON.stringify({
				organizationId: ORG,
				workspaceId: WORKSPACE,
				resourceId,
				filename,
				mimeType: "video/mp4",
				size: BYTES.length,
				uploadId: "upload-1",
				createdByKind: "user",
				createdById: "user-1",
				createdAt: accountability.createdAt,
				expiresAt: accountability.createdAt,
				mimeValidated: true,
			}),
		),
	);
}

async function fixture() {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec("PRAGMA foreign_keys = OFF;");
	sqlite.exec(
		schemaDdl(
			organizations,
			organizationMembers,
			osOutputs,
			osOutputRevisions,
			osWorkspaces,
			osWorkspaceResources,
			osShareLinks,
			osShareSessions,
			osShareLinkInvitees,
		),
	);
	sqlite.exec(
		`INSERT INTO organizations (id, name, slug, descope_tenant_id) VALUES ('${ORG}', 'Example', 'example', 'tenant-1');`,
	);
	const db = createDbQueryClient(createD1Facade(sqlite));
	await db.insert(osWorkspaces).values({
		...accountability,
		id: WORKSPACE,
		name: "Pilot",
		status: "active",
		updatedAt: accountability.createdAt,
	});
	const r2 = bucket();
	for (const [outputId, resourceId, title] of [
		["out-video", VIDEO, "highlights.mp4"],
		["out-other", OTHER_FILE, "other.mp4"],
	] as const) {
		await db.insert(osWorkspaceResources).values({
			...accountability,
			id: resourceId,
			workspaceId: WORKSPACE,
			providerId: "tedix",
			connectionScope: "tenant",
			resourceType: "file",
			providerResourceId: resourceId,
			name: title,
			status: "active",
			updatedAt: accountability.createdAt,
		});
		await storeFile(r2, resourceId, title);
		await createOsOutput(
			db,
			{ organizationId: ORG },
			{
				...accountability,
				id: outputId,
				workspaceId: WORKSPACE,
				kind: "document",
				title,
				status: "active",
				currentRevisionId: `${outputId}-rev`,
				updatedAt: accountability.createdAt,
			},
			{
				...accountability,
				id: `${outputId}-rev`,
				outputId,
				revision: 1,
				content: JSON.stringify({
					kind: "document",
					file: { workspaceId: WORKSPACE, resourceId },
					blocks: [],
				}),
				note: null,
				accessEnvelope: JSON.stringify({ version: 1, sources: [] }),
			},
		);
	}
	const env = {
		SKILL_ARTIFACTS: r2 as unknown as R2Bucket,
		SECRETS_MASTER_KEY: "fictional-test-secret",
	};
	return { db, env };
}

async function shareOutput(
	f: Awaited<ReturnType<typeof fixture>>,
	overrides: Partial<NewOsShareLinkRow> = {},
) {
	const token = generateOsShareToken();
	const linkId = crypto.randomUUID();
	await createOsShareLink(f.db, {
		...accountability,
		id: linkId,
		resourceType: "output",
		resourceId: "out-video",
		tokenHash: await hashOsShareToken(token),
		role: "viewer",
		access: "anyone_with_link",
		...overrides,
	});
	const opened = (await (
		await handleOsShareRedemption(f.db, token)
	).json()) as { sessionToken: string };
	return { linkId, sessionToken: opened.sessionToken };
}

async function fileUrl(
	f: Awaited<ReturnType<typeof fixture>>,
	sessionToken: string,
	outputId = "out-video",
) {
	const response = await handleOsShareFile(f.env, f.db, sessionToken, outputId);
	return response;
}

function read(
	f: Awaited<ReturnType<typeof fixture>>,
	url: string,
	headers: HeadersInit = {},
) {
	const parsed = new URL(url, "https://example.test");
	const [, , , , sessionId, outputId] = parsed.pathname.split("/");
	return serveOsShareFile(new Request(parsed, { headers }), f.env, f.db, {
		sessionId: sessionId!,
		outputId: decodeURIComponent(outputId!),
	});
}

describe("share-scoped file endpoint", () => {
	it("describes and streams the file of a valid link", async () => {
		const f = await fixture();
		const { sessionToken } = await shareOutput(f);
		const described = await fileUrl(f, sessionToken);
		expect(described.status).toBe(200);
		const file = (await described.json()) as {
			filename: string;
			mimeType: string;
			size: number;
			url: string;
		};
		expect(file).toMatchObject({
			filename: "highlights.mp4",
			mimeType: "video/mp4",
			size: BYTES.length,
		});
		expect(file.url).toMatch(
			/^\/api\/os-shared\/file\/[0-9a-f-]{36}\/out-video\?sig=/,
		);
		expect(file.url).not.toContain(sessionToken);
		const media = await read(f, file.url);
		expect(media.status).toBe(200);
		expect(media.headers.get("Content-Type")).toBe("video/mp4");
		expect(media.headers.get("Accept-Ranges")).toBe("bytes");
		expect(media.headers.get("Cache-Control")).toBe("private, no-store");
		expect(new Uint8Array(await media.arrayBuffer())).toEqual(BYTES);
	});

	it("answers a range request with 206 and the requested bytes", async () => {
		const f = await fixture();
		const { sessionToken } = await shareOutput(f);
		const { url } = (await (await fileUrl(f, sessionToken)).json()) as {
			url: string;
		};
		const media = await read(f, url, { Range: "bytes=2-5" });
		expect(media.status).toBe(206);
		expect(media.headers.get("Content-Range")).toBe(
			`bytes 2-5/${BYTES.length}`,
		);
		expect(media.headers.get("Content-Length")).toBe("4");
		expect(new TextDecoder().decode(await media.arrayBuffer())).toBe("2345");
		expect((await read(f, url, { Range: "bytes=99-" })).status).toBe(416);
	});

	it("returns 404 for the file URL once the link is revoked", async () => {
		const f = await fixture();
		const { linkId, sessionToken } = await shareOutput(f);
		const { url } = (await (await fileUrl(f, sessionToken)).json()) as {
			url: string;
		};
		await revokeOsShareLink(f.db, { organizationId: ORG, shareLinkId: linkId });
		expect((await read(f, url)).status).toBe(404);
		expect((await read(f, url, { Range: "bytes=0-1" })).status).toBe(404);
		expect((await fileUrl(f, sessionToken)).status).toBe(404);
	});

	it("returns 404 for the file URL once the link expires", async () => {
		const f = await fixture();
		const { linkId, sessionToken } = await shareOutput(f);
		const { url } = (await (await fileUrl(f, sessionToken)).json()) as {
			url: string;
		};
		await f.db
			.update(osShareLinks)
			.set({ expiresAt: "2020-01-01T00:00:00.000Z" })
			.where(eq(osShareLinks.id, linkId));
		expect((await read(f, url)).status).toBe(404);
	});

	it("never serves a file of a resource the link does not grant", async () => {
		const f = await fixture();
		const { sessionToken } = await shareOutput(f);
		// Another document in the same workspace, by id.
		expect((await fileUrl(f, sessionToken, "out-other")).status).toBe(404);
		// A URL for the granted file, re-pointed at the other Output.
		const { url } = (await (await fileUrl(f, sessionToken)).json()) as {
			url: string;
		};
		expect((await read(f, url.replace("out-video", "out-other"))).status).toBe(
			404,
		);
		// A forged signature.
		expect((await read(f, url.replace(/sig=.*/, "sig=forged"))).status).toBe(
			404,
		);
	});

	it("refuses a document whose file lives in another workspace", async () => {
		const f = await fixture();
		await f.db
			.update(osOutputRevisions)
			.set({
				content: JSON.stringify({
					kind: "document",
					file: {
						workspaceId: "44444444-4444-4444-8444-444444444444",
						resourceId: VIDEO,
					},
					blocks: [],
				}),
			})
			.where(eq(osOutputRevisions.id, "out-video-rev"));
		const { sessionToken } = await shareOutput(f);
		expect((await fileUrl(f, sessionToken)).status).toBe(404);
	});
});

it("rechecks an invited email on file metadata and signed range reads", async () => {
	const f = await fixture();
	const { linkId } = await shareOutput(f);
	await f.db
		.update(osShareLinks)
		.set({ access: "invited" })
		.where(eq(osShareLinks.id, linkId));
	await f.db.insert(osShareLinkInvitees).values({
		id: crypto.randomUUID(),
		organizationId: ORG,
		shareLinkId: linkId,
		email: "guest@example.test",
		addedByKind: "user",
		addedById: "user-1",
	});
	const link = (
		await f.db.select().from(osShareLinks).where(eq(osShareLinks.id, linkId))
	)[0]!;
	const { sessionToken } = (await (
		await openOsShareSession(
			f.db,
			link,
			new Date().toISOString(),
			undefined,
			undefined,
			undefined,
			"guest@example.test",
		)
	).json()) as { sessionToken: string };
	const metadata = await fileUrl(f, sessionToken);
	expect(metadata.status).toBe(200);
	const { url } = (await metadata.json()) as { url: string };
	expect((await read(f, url, { Range: "bytes=2-5" })).status).toBe(206);
	await f.db.delete(osShareLinkInvitees);
	expect((await fileUrl(f, sessionToken)).status).toBe(404);
	expect((await read(f, url, { Range: "bytes=2-5" })).status).toBe(404);
});
