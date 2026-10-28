import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { createDbClient } from "../client";
import { apiKeys } from "../schema/api-keys";
import { createD1Facade } from "../test/d1-facade";
import { tableDdl } from "../test/schema-ddl";
import {
	createApiKey,
	getApiKeyByHash,
	getApiKeyByPreviousHash,
	listApiKeysPage,
	revokeApiKey,
	rotateApiKey,
} from "./api-keys";

const ORG = "00000000-0000-4000-8000-000000000001";
let sqlite: DatabaseSync;
let db: ReturnType<typeof createDbClient>;
beforeEach(() => {
	sqlite = new DatabaseSync(":memory:");
	sqlite.exec("PRAGMA foreign_keys = OFF");
	sqlite.exec(tableDdl(apiKeys).join(";"));
	db = createDbClient(createD1Facade(sqlite));
});
afterEach(() => sqlite.close());

describe("API key purpose", () => {
	it("retains general defaults and the existing rotation grace", async () => {
		const { apiKey } = await createApiKey(db, {
			organizationId: ORG,
			name: "Legacy integration",
		});
		expect(apiKey.purpose).toBe("general");
		expect(apiKey.scopes).toEqual(["apps:read"]);
		expect((await getApiKeyByHash(db, apiKey.keyHash))?.purpose).toBe(
			"general",
		);
		const rotated = await rotateApiKey(db, apiKey.id);
		expect(rotated.apiKey.previousKeyHash).toBe(apiKey.keyHash);
		expect((await getApiKeyByPreviousHash(db, apiKey.keyHash))?.id).toBe(
			apiKey.id,
		);
	});
	it.each([false, true])(
		"bootstrap rotation never preserves an old hash (grace=%s)",
		async (grace) => {
			const { apiKey } = await createApiKey(db, {
				organizationId: ORG,
				name: "Cloud bootstrap",
				purpose: "external_agent_bootstrap",
				scopes: ["*"],
				expiresAt: "2099-01-01T00:00:00.000Z",
			});
			expect(apiKey.scopes).toEqual([]);
			expect((await getApiKeyByHash(db, apiKey.keyHash))?.purpose).toBe(
				"external_agent_bootstrap",
			);
			const rotated = await rotateApiKey(db, apiKey.id, { grace });
			expect(rotated.apiKey.previousKeyHash).toBeNull();
			expect(rotated.apiKey.previousKeyExpiresAt).toBeNull();
			expect(await getApiKeyByHash(db, apiKey.keyHash)).toBeUndefined();
			expect(await getApiKeyByPreviousHash(db, apiKey.keyHash)).toBeUndefined();
		},
	);
	it.each([undefined, "2000-01-01T00:00:00.000Z", "invalid"])(
		"refuses bootstrap expiry %s before storing a key",
		async (expiresAt) => {
			await expect(
				createApiKey(db, {
					organizationId: ORG,
					name: "Invalid bootstrap",
					purpose: "external_agent_bootstrap",
					expiresAt,
				}),
			).rejects.toThrow("future enrollment expiry");
			expect(
				sqlite.prepare("SELECT count(*) AS total FROM api_keys").get(),
			).toMatchObject({ total: 0 });
		},
	);
});

describe("listApiKeysPage", () => {
	const seedKeys = (count: number) =>
		Promise.all(
			Array.from({ length: count }, (_, index) =>
				createApiKey(db, {
					organizationId: ORG,
					name: `Key ${index + 1}`,
				}),
			),
		);

	it("reports the exact filtered total, not the page size", async () => {
		await seedKeys(60);
		const first = await listApiKeysPage(db, ORG, { limit: 25, offset: 0 });
		expect(first.total).toBe(60);
		expect(first.data).toHaveLength(25);
		const second = await listApiKeysPage(db, ORG, { limit: 25, offset: 25 });
		expect(second.total).toBe(60);
		expect(second.data).toHaveLength(25);
		const last = await listApiKeysPage(db, ORG, { limit: 25, offset: 50 });
		expect(last.data).toHaveLength(10);
		const ids = new Set(
			[...first.data, ...second.data, ...last.data].map((key) => key.id),
		);
		expect(ids.size).toBe(60);
	});

	it("excludes rows whose id is not in the stored UUID shape from page and total", async () => {
		await seedKeys(2);
		const legacyIds = [
			"legacy-key-1",
			"zzzzzzzz-zzzz-zzzz-zzzz-zzzzzzzzzzzz",
			"ffffffff-ffff-ffff-ffff-ffffffffffff",
			"not-a-uuid-at-all",
		];
		for (const [index, id] of legacyIds.entries())
			await db.insert(apiKeys).values({
				id,
				organizationId: ORG,
				name: `Legacy ${index}`,
				keyHash: `legacy-hash-${index}`,
				keyPreview: "...legacy",
			});
		const page = await listApiKeysPage(db, ORG, { limit: 25, offset: 0 });
		expect(page.total).toBe(2);
		expect(page.data).toHaveLength(2);
		for (const id of legacyIds)
			expect(page.data.some((key) => key.id === id)).toBe(false);
	});

	it("counts only rows matching the status and environment filters", async () => {
		const [{ apiKey: revoked }] = await Promise.all([
			createApiKey(db, {
				organizationId: ORG,
				name: "Revoked",
				environment: "live",
			}),
			createApiKey(db, { organizationId: ORG, name: "Active" }),
		]);
		await revokeApiKey(db, revoked.id);
		const revokedPage = await listApiKeysPage(db, ORG, {
			status: "revoked",
		});
		expect(revokedPage.total).toBe(1);
		expect(revokedPage.data.map((key) => key.id)).toEqual([revoked.id]);
		const livePage = await listApiKeysPage(db, ORG, {
			environment: "live",
		});
		expect(livePage.total).toBe(1);
	});
});
