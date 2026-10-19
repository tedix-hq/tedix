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
