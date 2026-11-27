import { fileURLToPath } from "node:url";
import { createCoreStore } from "@tedix/db/core-store/client";
import { withCoreStore } from "@tedix/db/core-store/scope";
import { createD1Facade } from "@tedix/db/test/d1-facade";
import { createMigratedSqlite } from "@tedix/db/test/migrated-sqlite";
import { createPGliteFacade } from "@tedix/db/test/pglite-facade";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { Hono } from "hono";
import { expect, it, vi } from "vite-plus/test";
import { getStripe } from "../lib/stripe";
import { handleStripeWebhook } from "./stripe";

vi.mock("@tedix/db/core-store/client", async (original) => ({
	...(await original<typeof import("@tedix/db/core-store/client")>()),
	createCoreStore: vi.fn(),
}));

it.each(["d1", "postgres"] as const)(
	"persists and deduplicates a signed Stripe event on %s",
	async (dialect) => {
		const sqlite = dialect === "d1" ? createMigratedSqlite() : undefined;
		const pg = dialect === "postgres" ? await createPGliteFacade() : undefined;
		try {
			if (pg) {
				for (const migration of readMigrationFiles({
					migrationsFolder: fileURLToPath(
						new URL("../../../../packages/db/drizzle-pg", import.meta.url),
					),
				}))
					for (const ddl of migration.sql) await pg.engine.exec(ddl);
				vi.mocked(createCoreStore).mockReturnValue({
					db: pg.db,
					close: async () => {},
				});
			}
			const env = {
				CORE_STORE: dialect,
				CORE_HYPERDRIVE: pg ? { connectionString: "unused" } : undefined,
				DB: sqlite ? createD1Facade(sqlite) : undefined,
				TEDIX_FLEET_AUTHORITY_MODE: "co-located",
				TEDIX_BILLING_SETTLEMENT_MODE: "managed",
				TEDIX_STRIPE_MODE: "test",
				STRIPE_TEST_SECRET_KEY: "sk_test_synthetic",
				STRIPE_TEST_WEBHOOK_SECRET: "whsec_synthetic",
				STRIPE_TEST_BILLING_PORTAL_CONFIGURATION_ID: "bpc_synthetic",
			} as CloudflareEnv;
			const stripe = await getStripe(env.STRIPE_TEST_SECRET_KEY!);
			const body = JSON.stringify({
				id: "evt_core_store",
				type: "product.updated",
				created: Math.floor(Date.now() / 1000),
				data: { object: { id: "prod_synthetic" } },
			});
			const signature = stripe.webhooks.generateTestHeaderString({
				payload: body,
				secret: env.STRIPE_TEST_WEBHOOK_SECRET!,
			});
			const app = new Hono<{ Bindings: CloudflareEnv }>();
			app.post("/webhook", (c) => handleStripeWebhook(c, "test"));
			const send = () =>
				withCoreStore(env, () =>
					app.request(
						"/webhook",
						{
							method: "POST",
							headers: { "stripe-signature": signature },
							body,
						},
						env,
					),
				);
			const first = await send();
			expect(first.status).toBe(200);
			expect(await first.json()).toEqual({ received: true });
			const replay = await send();
			expect(replay.status).toBe(200);
			expect(await replay.json()).toEqual({
				received: true,
				duplicate: true,
				status: "processed",
			});
		} finally {
			vi.mocked(createCoreStore).mockReset();
			sqlite?.close();
			await pg?.close();
		}
	},
);
