import { DatabaseSync } from "node:sqlite";
import { createCoreStore } from "@tedix/db/core-store/client";
import { withCoreStore } from "@tedix/db/core-store/scope";
import { readAuthContextCacheVersion } from "@tedix/db/queries/auth-context-cache";
import { createD1Facade } from "@tedix/db/test/d1-facade";
import { createPGliteFacade } from "@tedix/db/test/pglite-facade";
import { expect, it, vi } from "vite-plus/test";
import { createContext } from "../rpc/context";
import { invalidateIdentityCache } from "./identity-cache-invalidation";

vi.mock("@tedix/db/core-store/client", async (original) => ({
	...(await original<typeof import("@tedix/db/core-store/client")>()),
	createCoreStore: vi.fn(),
}));

it.each(["d1", "postgres"] as const)(
	"uses the selected %s store for RPC reads and logout invalidation",
	async (dialect) => {
		const ddl =
			"CREATE TABLE auth_context_cache_state (id integer PRIMARY KEY, version text NOT NULL); INSERT INTO auth_context_cache_state VALUES (1, 'before')";
		const sqlite = dialect === "d1" ? new DatabaseSync(":memory:") : undefined;
		const pg = dialect === "postgres" ? await createPGliteFacade() : undefined;
		const d1 = sqlite ? createD1Facade(sqlite) : undefined;
		if (sqlite) sqlite.exec(ddl);
		if (pg) await pg.engine.exec(ddl);
		const close = vi.fn(async () => {});
		if (pg) vi.mocked(createCoreStore).mockReturnValue({ db: pg.db, close });
		const env = {
			CORE_STORE: dialect,
			DB: d1,
			ENVIRONMENT: "production",
		} as CloudflareEnv;
		try {
			await withCoreStore(env, async () => {
				const context = createContext(
					new Request("https://api.example.test/rpc/read", {
						headers: { "x-d1-bookmark": "caller-bookmark" },
					}),
					env,
				);
				expect(await readAuthContextCacheVersion(context.db)).toBe("before");
				const response = await invalidateIdentityCache(
					new Request("https://api.example.test/logout", { method: "POST" }),
					env,
				);
				expect(response.status).toBe(204);
				expect(await readAuthContextCacheVersion(context.db)).not.toBe(
					"before",
				);
				if (pg) {
					expect(context.db).toBe(pg.db);
					expect(context.dbBookmark?.()).toBeNull();
					expect(context.dbMetrics).toBeUndefined();
				}
			});
			if (pg) expect(close).toHaveBeenCalledOnce();
		} finally {
			sqlite?.close();
			await pg?.close();
		}
	},
);
