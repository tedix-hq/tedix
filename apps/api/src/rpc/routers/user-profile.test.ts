import { DatabaseSync } from "node:sqlite";
import { createRouterClient } from "@orpc/server";
import { createDbClient } from "@tedix/db/client";
import { organizationMembers } from "@tedix/db/schema/organization-members";
import { users } from "@tedix/db/schema/users";
import { createD1Facade } from "@tedix/db/test/d1-facade";
import { schemaDdl } from "@tedix/db/test/schema-ddl";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { BaseContext } from "../orpc";
import { userProfileContractRouter } from "./user-profile";

const USER_ID = "00000000-0000-4000-8000-000000000001";
const OLD_IMAGE_ID = "11111111-1111-4111-8111-111111111111";
const NEW_IMAGE_ID = "22222222-2222-4222-8222-222222222222";

function fixture() {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec("PRAGMA foreign_keys = OFF;");
	sqlite.exec(schemaDdl(users, organizationMembers));
	sqlite.exec(`
		CREATE TRIGGER sync_user_profile_to_memberships
		AFTER UPDATE OF name, avatar_url ON users
		FOR EACH ROW BEGIN
			UPDATE organization_members
			SET name = NEW.name, avatar_url = NEW.avatar_url, updated_at = NEW.updated_at
			WHERE user_id = NEW.id;
		END;
	`);
	sqlite
		.prepare(
			"INSERT INTO users (id,email,name,avatar_url,profile_revision,updated_at) VALUES (?,?,?,?,?,?)",
		)
		.run(
			USER_ID,
			"owner@example.com",
			"Old Name",
			`https://imagedelivery.net/hash/${OLD_IMAGE_ID}/public`,
			1,
			"2026-09-25T00:00:00.000Z",
		);
	sqlite
		.prepare(
			`INSERT INTO organization_members
			 (id,organization_id,user_id,descope_user_id,email,name,avatar_url,role,status)
			 VALUES (?,?,?,?,?,?,?,?,?)`,
		)
		.run(
			"member-1",
			"org-1",
			USER_ID,
			"descope-1",
			"owner@example.com",
			"Old Name",
			`https://imagedelivery.net/hash/${OLD_IMAGE_ID}/public`,
			"owner",
			"active",
		);
	const facade = createD1Facade(sqlite);
	const env = {
		ENVIRONMENT: "test",
		DB: facade,
		CF_ACCOUNT_ID: "account",
		CF_ACCOUNT_HASH: "hash",
		CF_IMAGES_TOKEN: "token",
	} as unknown as CloudflareEnv;
	return { sqlite, env, db: createDbClient(facade) };
}

type Fixture = ReturnType<typeof fixture>;

function userContext(f: Fixture): BaseContext {
	return {
		authType: "user",
		db: f.db,
		env: f.env,
		headers: new Headers(),
		url: new URL("https://api.tedix.test/rpc/userProfile"),
		userId: USER_ID,
		user: {
			aud: "test",
			exp: 2,
			iat: 1,
			iss: "https://auth.tedix.test",
			permissions: ["apps:read"],
			roles: [],
			sub: "descope-1",
		},
	} as BaseContext;
}

function machineContext(f: Fixture): BaseContext {
	return {
		authType: "apikey",
		apiKey: {
			id: "key-1",
			name: "machine",
			organizationId: "org-1",
			scopes: ["apps:read", "platform:admin"],
		},
		db: f.db,
		env: f.env,
		headers: new Headers(),
		url: new URL("https://api.tedix.test/rpc/userProfile"),
	} as BaseContext;
}

describe("self-service user profile", () => {
	beforeEach(() => vi.restoreAllMocks());

	it("rejects machine principals even with platform scope", async () => {
		const f = fixture();
		const client = createRouterClient(userProfileContractRouter, {
			context: machineContext(f),
		});
		await expect(client.getMine({})).rejects.toMatchObject({
			code: "FORBIDDEN",
		});
		await expect(client.requestAvatarUpload({})).rejects.toMatchObject({
			code: "FORBIDDEN",
		});
	});

	it("normalizes malformed legacy avatar values at the profile boundary", async () => {
		const f = fixture();
		f.sqlite
			.prepare("UPDATE users SET avatar_url = ? WHERE id = ?")
			.run("legacy-avatar", USER_ID);
		const client = createRouterClient(userProfileContractRouter, {
			context: userContext(f),
		});

		await expect(client.getMine({})).resolves.toMatchObject({
			id: USER_ID,
			avatarUrl: null,
		});
	});

	it("CAS-updates the canonical profile and all canonical-id member projections", async () => {
		const f = fixture();
		const client = createRouterClient(userProfileContractRouter, {
			context: userContext(f),
		});
		const updated = await client.updateMine({
			name: "New Name",
			expectedRevision: 1,
		});
		expect(updated).toMatchObject({ name: "New Name", revision: 2 });
		expect(
			f.sqlite
				.prepare("SELECT name FROM organization_members WHERE user_id = ?")
				.get(USER_ID),
		).toEqual({ name: "New Name" });
		await expect(
			client.updateMine({ name: "Stale", expectedRevision: 1 }),
		).rejects.toMatchObject({
			code: "CONFLICT",
			data: { expectedRevision: 1, currentRevision: 2 },
		});
	});

	it("binds uploads to user, nonce and revision and deletes a CAS-losing orphan", async () => {
		const f = fixture();
		const fetchMock = vi.fn(
			async (input: RequestInfo | URL, init?: RequestInit) => {
				const url = String(input);
				if (url.endsWith("/images/v2/direct_upload")) {
					const body = init?.body;
					expect(body).toBeInstanceOf(FormData);
					const metadata = JSON.parse(
						String((body as FormData).get("metadata")),
					) as Record<string, string>;
					expect(metadata).toMatchObject({
						entityType: "user",
						canonicalUserId: USER_ID,
						profileRevision: "1",
					});
					return Response.json({
						success: true,
						result: { id: NEW_IMAGE_ID, uploadURL: "https://upload.test/once" },
						errors: [],
					});
				}
				if (init?.method === "GET") {
					return Response.json({
						success: true,
						result: {
							id: NEW_IMAGE_ID,
							uploaded: "2026-09-25T00:00:00.000Z",
							meta: avatarMetadata,
						},
						errors: [],
					});
				}
				return Response.json({ success: true, result: {}, errors: [] });
			},
		);
		vi.stubGlobal("fetch", fetchMock);
		const client = createRouterClient(userProfileContractRouter, {
			context: userContext(f),
		});
		const requested = await client.requestAvatarUpload({});
		const avatarMetadata = {
			entityType: "user",
			canonicalUserId: USER_ID,
			uploadNonce: requested.uploadNonce,
			profileRevision: "1",
		};

		await client.updateMine({ name: "Concurrent Edit", expectedRevision: 1 });
		await expect(
			client.confirmAvatarUpload({
				imageId: NEW_IMAGE_ID,
				uploadNonce: requested.uploadNonce,
			}),
		).rejects.toMatchObject({ code: "CONFLICT" });
		expect(fetchMock).toHaveBeenCalledWith(
			expect.stringContaining(`/images/v1/${NEW_IMAGE_ID}`),
			expect.objectContaining({ method: "DELETE" }),
		);
	});

	it("refuses uploaded images whose Cloudflare metadata names another user", async () => {
		const f = fixture();
		vi.stubGlobal(
			"fetch",
			vi.fn(async () =>
				Response.json({
					success: true,
					result: {
						id: NEW_IMAGE_ID,
						uploaded: "2026-09-25T00:00:00.000Z",
						meta: {
							entityType: "user",
							canonicalUserId: "00000000-0000-4000-8000-000000000099",
							uploadNonce: "33333333-3333-4333-8333-333333333333",
							profileRevision: "1",
						},
					},
					errors: [],
				}),
			),
		);
		const client = createRouterClient(userProfileContractRouter, {
			context: userContext(f),
		});
		await expect(
			client.confirmAvatarUpload({
				imageId: NEW_IMAGE_ID,
				uploadNonce: "33333333-3333-4333-8333-333333333333",
			}),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
	});
});
