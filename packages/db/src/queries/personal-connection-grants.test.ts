import { fileURLToPath } from "node:url";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { createDbClient, type DbClient } from "../client";
import { coreTable } from "../core-store/client";
import { users } from "../schema/users";
import { createD1Facade } from "../test/d1-facade";
import { createMigratedSqlite } from "../test/migrated-sqlite";
import { createPGliteFacade } from "../test/pglite-facade";
import {
	getPersonalConnectionConsumerGrants,
	setPersonalConnectionConsumerGrants,
} from "./personal-connection-grants";

for (const store of ["d1", "postgres"] as const) {
	describe(`personal connection grants (${store})`, () => {
		let db: DbClient;
		let close: () => void | Promise<void>;
		beforeAll(async () => {
			if (store === "d1") {
				const sqlite = createMigratedSqlite();
				db = createDbClient(createD1Facade(sqlite));
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
			await db.insert(coreTable(db, users)).values([
				{
					id: "owner",
					email: "owner@example.test",
					metadata: { theme: "dark" },
				},
				{ id: "other", email: "other@example.test" },
			]);
		}, 30_000);
		afterAll(async () => {
			await close?.();
		});

		it("preserves sibling metadata and isolates encoded organization, account and owner keys", async () => {
			const provider = 'https://provider.example/"quoted"';
			const org = "org.with.dot/one";
			const denied = { mode: "selected" as const, tediIds: [], skills: [] };
			expect(
				await getPersonalConnectionConsumerGrants(db, "owner", org, provider),
			).toEqual({ mode: "all" });
			await setPersonalConnectionConsumerGrants(
				db,
				"owner",
				org,
				provider,
				denied,
				"account/one",
			);
			expect(
				await getPersonalConnectionConsumerGrants(
					db,
					"owner",
					org,
					provider,
					"account/one",
				),
			).toEqual(denied);
			for (const [ownerId, organizationId, providerId, accountId] of [
				["owner", org, provider, "account/two"],
				["owner", "other-org", provider, "account/one"],
				["other", org, provider, "account/one"],
			] as const)
				expect(
					await getPersonalConnectionConsumerGrants(
						db,
						ownerId,
						organizationId,
						providerId,
						accountId,
					),
				).toEqual({
					mode: "all",
				});
			await setPersonalConnectionConsumerGrants(
				db,
				"owner",
				"other-org",
				provider,
				{ mode: "all" },
				"account/one",
			);
			expect(
				await getPersonalConnectionConsumerGrants(
					db,
					"owner",
					org,
					provider,
					"account/one",
				),
			).toEqual(denied);
			const table = coreTable(db, users);
			const [owner] = await db
				.select()
				.from(table)
				.where(eq(table.id, "owner"));
			expect(owner?.metadata?.theme).toBe("dark");
			await setPersonalConnectionConsumerGrants(
				db,
				"other",
				org,
				provider,
				denied,
			);
			expect(
				await getPersonalConnectionConsumerGrants(db, "other", org, provider),
			).toEqual(denied);
			await expect(
				getPersonalConnectionConsumerGrants(db, "missing", org, provider),
			).rejects.toThrow("Connection owner not found");
		});
	});
}
