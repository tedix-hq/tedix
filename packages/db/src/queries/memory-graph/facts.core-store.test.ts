import { fileURLToPath } from "node:url";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import type { DbClient } from "../../client";
import { createDbClient } from "../../client";
import { createD1Facade } from "../../test/d1-facade";
import { createMigratedSqlite } from "../../test/migrated-sqlite";
import { createPGliteFacade } from "../../test/pglite-facade";
import {
	createFact,
	createFacts,
	findCurrentFactsByTopicKey,
	findFactBySourceHash,
	getFactById,
	getFactsByIds,
	recordFactAccess,
	recordFactUsage,
	recordFactVerification,
	updateFact,
} from "./facts";

for (const store of ["d1", "postgres"] as const)
	describe(store, () => {
		let db: DbClient;
		let close: () => void | Promise<void>;
		beforeAll(async () => {
			const parents =
				"INSERT INTO organizations(id,name,slug) VALUES ('org','Org','org'),('other','Other','other')";
			if (store === "d1") {
				const sqlite = createMigratedSqlite();
				sqlite.exec(parents);
				db = createDbClient(createD1Facade(sqlite, { maxBoundParams: 100 }));
				close = () => sqlite.close();
			} else {
				const fixture = await createPGliteFacade();
				db = fixture.db;
				close = fixture.close;
				for (const migration of readMigrationFiles({
					migrationsFolder: fileURLToPath(
						new URL("../../../drizzle-pg", import.meta.url),
					),
				}))
					for (const ddl of migration.sql) await fixture.engine.exec(ddl);
				await fixture.engine.exec(parents);
			}
		});
		afterAll(async () => {
			await close?.();
		});
		it("preserves tenant isolation, JSON rows and bounded confidence updates for large ID sets", async () => {
			const scope = { organizationId: "org" };
			await createFact(db, {
				id: "foreign",
				organizationId: "other",
				content: "foreign",
				factType: "technical",
				confidence: 0.7,
			});
			await createFacts(
				db,
				scope,
				Array.from({ length: 12 }, (_, i) => ({
					id: `f${i}`,
					organizationId: "org",
					content: `fact ${i}`,
					factType: "technical",
					confidence: i === 0 ? 0.99 : 0.5,
					topicKey: "topic",
					sourceHash: "hash",
					metadata: { example: ["json", i] },
				})),
			);
			expect(await getFactById(db, scope, "foreign")).toBeUndefined();
			expect(await findCurrentFactsByTopicKey(db, scope, "topic")).toHaveLength(
				12,
			);
			expect((await findFactBySourceHash(db, scope, "hash"))?.confidence).toBe(
				0.5,
			);
			const ids = [
				...Array.from({ length: 120 }, (_, i) => `f${i}`),
				"foreign",
			];
			expect(await getFactsByIds(db, scope, ids)).toHaveLength(12);
			await recordFactUsage(db, scope, [...ids, "f0", "f1"], "used");
			let fact = await getFactById(db, scope, "f1");
			expect(fact?.usageCount).toBe(2);
			expect(fact?.confidence).toBeCloseTo(0.5 * 1.02 ** 2);
			expect(fact?.metadata).toEqual({ example: ["json", 1] });
			expect((await getFactById(db, scope, "f0"))?.confidence).toBe(1);
			await updateFact(db, scope, "f1", { confidence: 0.11 });
			await recordFactUsage(db, scope, ["f1", "foreign"], "wrong");
			expect((await getFactById(db, scope, "f1"))?.confidence).toBe(0.1);
			await recordFactVerification(db, scope, "f1", 20);
			await recordFactAccess(db, scope, "f1");
			fact = await getFactById(db, scope, "f1");
			expect(fact?.confidence).toBe(1);
			expect(fact?.accessCount).toBe(1);
			expect(fact?.lastVerifiedAt).toMatch(/^\d{4}-/);
			expect(
				(await getFactById(db, { organizationId: "other" }, "foreign"))
					?.confidence,
			).toBe(0.7);
			await expect(
				updateFact(db, scope, "f1", { organizationId: "other" }),
			).rejects.toThrow("organization cannot change");
		});
	});
