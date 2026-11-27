import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { createDbQueryClient, type DbQueryClient } from "../query-client";
import { userConfigs } from "../schema/user-configs";
import { createD1Facade } from "../test/d1-facade";
import { schemaDdl } from "../test/schema-ddl";
import { createPGliteFacade } from "../test/pglite-facade";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { fileURLToPath } from "node:url";
import {
	savePushConfig,
	listPushConfigs,
	deletePushConfig,
	deletePushConfigs,
	listPushSubscriptionKeys,
	hasVisiblePushConversation,
} from "./web-push";

for (const store of ["d1", "postgres"] as const)
	describe(`push config tenant boundaries (${store})`, () => {
		let db: DbQueryClient;
		let close: () => void | Promise<void>;
		beforeAll(async () => {
			if (store === "d1") {
				const sqlite = new DatabaseSync(":memory:");
				sqlite.exec(schemaDdl(userConfigs));
				db = createDbQueryClient(
					createD1Facade(sqlite, { maxBoundParams: 100 }),
				);
				close = () => sqlite.close();
			} else {
				const fixture = await createPGliteFacade();
				db = fixture.db;
				close = fixture.close;
				for (const migration of readMigrationFiles({
					migrationsFolder: fileURLToPath(
						new URL("../../drizzle-pg", import.meta.url),
					),
				}))
					for (const ddl of migration.sql) await fixture.engine.exec(ddl);
			}
		}, 30000);
		afterAll(async () => {
			await close?.();
		});
		it("isolates subscriptions, preferences and deletes by both user and organization", async () => {
			const a = { organizationId: "org-a", userId: "person-a" };
			const b = { organizationId: "org-b", userId: "person-a" };
			const c = { organizationId: "org-a", userId: "person-c" };
			for (const scope of [a, b, c])
				await savePushConfig(db, scope, "subscription:device", {
					endpoint: scope.organizationId,
				});
			expect((await listPushConfigs(db, a, "SUBSCRIPTION:"))[0]?.value).toEqual(
				{ endpoint: "org-a" },
			);
			expect(
				(await listPushSubscriptionKeys(db, a)).map((row) => row.key),
			).toEqual(["subscription:device"]);
			await deletePushConfigs(
				db,
				a,
				Array.from({ length: 150 }, (_, i) =>
					i === 0 ? "subscription:device" : `subscription:${i}`,
				),
			);
			await deletePushConfigs(db, b, []);
			expect(await listPushConfigs(db, a, "subscription:")).toEqual([]);
			expect(await listPushConfigs(db, b, "subscription:")).toHaveLength(1);
			expect(await listPushConfigs(db, c, "subscription:")).toHaveLength(1);
		});
		it("expires visibility leases and clearing one tab does not clear another", async () => {
			const scope = { organizationId: "org-a", userId: "person-a" };
			await savePushConfig(db, scope, "visible:tab-a", {
				conversationId: "chat-a",
			});
			await savePushConfig(db, scope, "visible:tab-b", {
				conversationId: "chat-a",
			});
			await deletePushConfig(db, scope, "visible:tab-a");
			expect(
				await hasVisiblePushConversation(db, scope, "chat-a", Date.now()),
			).toBe(true);
			expect(
				await hasVisiblePushConversation(db, scope, "chat-b", Date.now()),
			).toBe(false);
			expect(
				await hasVisiblePushConversation(
					db,
					{ ...scope, organizationId: "org-b" },
					"chat-a",
					Date.now(),
				),
			).toBe(false);
			expect(
				await hasVisiblePushConversation(
					db,
					scope,
					"chat-a",
					Date.now() + 61_000,
				),
			).toBe(false);
		});
	});
