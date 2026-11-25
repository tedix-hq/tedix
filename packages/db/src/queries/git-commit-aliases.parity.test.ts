import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { afterAll, beforeAll, describe, expect, it, vi } from "vite-plus/test";
import { coreTable } from "../core-store/client";
import { createDbQueryClient, type DbQueryClient } from "../query-client";
import { gitCommitAliases } from "../schema/git-commit-aliases";
import { createD1Facade } from "../test/d1-facade";
import { createPGliteFacade } from "../test/pglite-facade";
import { tableDdl } from "../test/schema-ddl";
import {
	canonicalSettlementMetadata,
	createCommitResolver,
} from "./git-commit-aliases";

for (const store of ["d1", "postgres"] as const)
	describe(`commit resolver ${store}`, () => {
		let db: DbQueryClient;
		let close: () => void | Promise<void>;
		let reads: () => number;
		const chain = ["1", "2", "3", "4", "5", "6"].map((id) => id.repeat(40));
		beforeAll(async () => {
			if (store === "d1") {
				const sqlite = new DatabaseSync(":memory:");
				for (const ddl of tableDdl(gitCommitAliases)) sqlite.exec(ddl);
				let count = 0;
				db = createDbQueryClient(
					createD1Facade(sqlite, { onPrepare: () => count++ }),
				);
				reads = () => count;
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
				const query = vi.spyOn(fixture.engine, "query");
				reads = () => query.mock.calls.length;
			}
			const edges = chain
				.slice(0, -1)
				.map((oldSha, index) => ({ oldSha, newSha: chain[index + 1]! }));
			edges.push(
				{ oldSha: "a".repeat(40), newSha: "b".repeat(40) },
				{ oldSha: "b".repeat(40), newSha: "a".repeat(40) },
				{ oldSha: "abcdef0" + "0".repeat(33), newSha: "c".repeat(40) },
				{ oldSha: "abcdef0" + "1".repeat(33), newSha: "d".repeat(40) },
			);
			await db
				.insert(coreTable(db, gitCommitAliases))
				.values(
					edges.map((edge) => ({ ...edge, repository: "example/project" })),
				);
		}, 30000);
		afterAll(async () => {
			await close?.();
			vi.restoreAllMocks();
		});

		it("resolves full sets in one read, preserves order and bounds traversal to four hops", async () => {
			const resolver = createCommitResolver(db);
			const before = reads();
			expect(
				await resolver.resolveMany([
					chain[0]!,
					chain[5]!,
					"e".repeat(40),
					chain[0]!,
				]),
			).toEqual([chain[4], chain[5], "e".repeat(40), chain[4]]);
			expect(reads() - before).toBe(1);
			expect(await createCommitResolver(db).aliasesFor(chain[5]!)).toEqual(
				chain.slice(1).reverse(),
			);
		});

		it("bulk resolves prefixes without per-row reads and retains settlement proof", async () => {
			const resolver = createCommitResolver(db);
			const inputs = [
				chain[0]!.slice(0, 7),
				chain[1]!.slice(0, 9),
				chain[5]!,
				"E".repeat(7),
				"outside",
				chain[0]!.slice(0, 7),
			];
			const before = reads();
			expect(await resolver.resolveMany(inputs)).toEqual([
				chain[4],
				chain[5],
				chain[5],
				"e".repeat(7),
				"outside",
				chain[4],
			]);
			expect(reads() - before).toBe(2);
			const cached = reads();
			await Promise.all(inputs.map(resolver.canonicalCommit));
			expect(reads()).toBe(cached);
			const metadata = {
				settlement: { mode: "commit", commitShas: [chain[1]!] },
				proof: { original: chain[1]! },
			};
			expect(await canonicalSettlementMetadata(resolver, metadata)).toEqual({
				settlement: { mode: "commit", commitShas: [chain[5]] },
				proof: metadata.proof,
			});
			expect(metadata.settlement.commitShas).toEqual([chain[1]]);
		});

		it("rejects cycles and ambiguous full IDs behind prefixes", async () => {
			await expect(
				createCommitResolver(db).resolveMany(["a".repeat(40)]),
			).rejects.toThrow("Cyclic");
			await expect(
				createCommitResolver(db).resolveMany(["a".repeat(7), "b".repeat(7)]),
			).rejects.toThrow("Cyclic");
			await expect(
				createCommitResolver(db).resolveMany([
					"abcdef0",
					chain[1]!.slice(0, 7),
				]),
			).rejects.toThrow("Ambiguous");
		});
	});
