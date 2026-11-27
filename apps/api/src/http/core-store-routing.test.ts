import { fileURLToPath } from "node:url";
import { generatePersonalAgentSigningKey } from "@tedix/auth/personal-agent-client";
import { POPPY_AGENT_SIGNING_KEY_SECRET } from "@tedix/api-contract/schemas/poppy-agent";
import { createCoreStore } from "@tedix/db/core-store/client";
import { withCoreStore } from "@tedix/db/core-store/scope";
import { readAuthContextCacheVersion } from "@tedix/db/queries/auth-context-cache";
import { createD1Facade } from "@tedix/db/test/d1-facade";
import { createMigratedSqlite } from "@tedix/db/test/migrated-sqlite";
import { createPGliteFacade } from "@tedix/db/test/pglite-facade";
import {
	encryptTediSecret,
	generateMasterKey,
} from "@tedix/db/utils/secrets-encryption";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { Hono } from "hono";
import { expect, it, vi } from "vite-plus/test";
import { createContext } from "../rpc/context";
import { apiKeyContext, userContext } from "../rpc/test-context";
import { registerOsSharedRoutes } from "./os-shared-routes";
import { registerPoppyAgentRoutes } from "./poppy-agent-routes";

vi.mock("@tedix/db/core-store/client", async (original) => ({
	...(await original<typeof import("@tedix/db/core-store/client")>()),
	createCoreStore: vi.fn(),
}));

it.each(["d1", "postgres"] as const)(
	"serves public branding, identity documents and RPC contexts from %s",
	async (dialect) => {
		const sqlite = dialect === "d1" ? createMigratedSqlite() : undefined;
		const pg = dialect === "postgres" ? await createPGliteFacade() : undefined;
		const execute = async (ddl: string) => {
			if (pg) await pg.engine.exec(ddl);
			else sqlite!.exec(ddl);
		};
		vi.stubGlobal("caches", { default: undefined });
		try {
			if (pg) {
				for (const migration of readMigrationFiles({
					migrationsFolder: fileURLToPath(
						new URL("../../../../packages/db/drizzle-pg", import.meta.url),
					),
				}))
					for (const ddl of migration.sql) await execute(ddl);
				vi.mocked(createCoreStore).mockReturnValue({
					db: pg.db,
					close: async () => {},
				});
			}
			await execute(`
INSERT INTO organizations (id, name, slug) VALUES ('org-example', 'Example', 'example');
UPDATE organizations SET metadata = '{"tediWidget":{"title":"Example assistant","version":1}}' WHERE id = 'org-example';
INSERT INTO tedis (id, organization_id, name, slug) VALUES ('tedi-example', 'org-example', 'Example', 'example-agent');
INSERT INTO auth_context_cache_state (id, version) VALUES (1, 'selected-store') ON CONFLICT (id) DO UPDATE SET version = 'selected-store';
`);
			const master = await generateMasterKey();
			const encrypted = await encryptTediSecret(
				master,
				"tedi-example",
				JSON.stringify(await generatePersonalAgentSigningKey()),
			);
			await execute(`INSERT INTO tedi_secrets (id, tedi_id, name, encrypted_value, created_at, updated_at)
VALUES ('secret-example', 'tedi-example', '${POPPY_AGENT_SIGNING_KEY_SECRET}', '${encrypted}', '2026-11-01', '2026-11-01')`);
			const env = {
				CORE_STORE: dialect,
				DB: sqlite ? createD1Facade(sqlite) : undefined,
				ENVIRONMENT: "production",
				API_URL: "https://api.example.test",
				SECRETS_MASTER_KEY: master,
				API_RATE_LIMITER: { limit: async () => ({ success: true }) },
			} as CloudflareEnv;
			const app = new Hono<{ Bindings: CloudflareEnv }>();
			registerPoppyAgentRoutes(app);
			registerOsSharedRoutes(app);
			await withCoreStore(env, async () => {
				const context = createContext(
					new Request("https://api.example.test/rpc/read"),
					env,
				);
				for (const db of [
					context.db,
					userContext({ env }).db,
					apiKeyContext({ env }).db,
				])
					expect(await readAuthContextCacheVersion(db)).toBe("selected-store");
				if (pg) {
					expect(context.db).toBe(pg.db);
					expect(context.dbMetrics).toBeUndefined();
					expect(context.dbBookmark?.()).toBeNull();
				}
				const client = await app.request(
					"/poppy-agent/example-agent/client.json",
					{},
					env,
				);
				expect(client.status).toBe(200);
				expect(await client.json()).toMatchObject({
					client_id:
						"https://api.example.test/poppy-agent/example-agent/client.json",
				});
				const jwks = await app.request(
					"/poppy-agent/example-agent/jwks.json",
					{},
					env,
				);
				expect(jwks.status).toBe(200);
				expect(await jwks.json()).toMatchObject({
					keys: [expect.objectContaining({ kty: "EC" })],
				});
				expect(
					(await app.request("/poppy-agent/missing/client.json", {}, env))
						.status,
				).toBe(404);
				const branding = await app.request("/widget/branding/example", {}, env);
				expect(branding.status).toBe(200);
				expect(await branding.json()).toMatchObject({
					branding: { title: "Example assistant" },
					version: 1,
				});
			});
		} finally {
			vi.unstubAllGlobals();
			sqlite?.close();
			await pg?.close();
		}
	},
);
