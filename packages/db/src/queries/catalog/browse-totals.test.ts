import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vite-plus/test";
import { createDbClient } from "../../client";
import { appCatalog } from "../../schema/catalog";
import { createD1Facade } from "../../test/d1-facade";
import { schemaDdl } from "../../test/schema-ddl";
import { listCatalogApps } from "./list-apps";

const migration = readFileSync(
	new URL(
		"../../../drizzle/20261012225830_catalog-browse-totals/migration.sql",
		import.meta.url,
	),
	"utf8",
);

function fixture() {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec(schemaDdl(appCatalog));
	// The current schema fixture has these indexes; apply their real migration.
	sqlite.exec(
		"DROP INDEX app_catalog_public_browse_name_idx; DROP INDEX app_catalog_explore_name_idx;",
	);
	const insert = sqlite.prepare(`INSERT INTO app_catalog
		(id, name, connector_type, developer_type, is_discoverable, status, review_status, last_synced_at, explore_shadowed)
		VALUES (?, ?, 'MCP', ?, ?, 'ENABLED', ?, '2026-01-01', ?)`);
	insert.run("visible", "Fictional Mail", "THIRD_PARTY", 1, "RELEASED", 0);
	insert.run("shadowed", "Fictional Mail Store", "OAI", 1, "RELEASED", 1);
	insert.run("pending", "Fictional Notes", "TRUSTED_PARTNER", 1, "PENDING", 0);
	insert.run("private", "Fictional Private", "THIRD_PARTY", 0, "RELEASED", 0);
	insert.run("untrusted", "Fictional Unknown", null, 1, "RELEASED", 0);
	sqlite.exec(migration);
	return { sqlite, insert, db: createDbClient(createD1Facade(sqlite)) };
}

function expectAccurate(sqlite: DatabaseSync) {
	const counts = sqlite
		.prepare(`SELECT count(*) AS total,
		coalesce(sum(explore_shadowed = 0), 0) AS explore_total FROM app_catalog
		WHERE is_discoverable = 1 AND status = 'ENABLED' AND review_status = 'RELEASED'
		AND developer_type IN ('TRUSTED_PARTNER', 'OAI', 'THIRD_PARTY')`)
		.get();
	expect(
		sqlite
			.prepare(
				"SELECT total, explore_total FROM app_catalog_browse_totals WHERE id = 'public'",
			)
			.get(),
	).toEqual(counts);
}

describe("catalog browse totals", () => {
	it("backfills, then maintains totals through visibility changes, inserts and deletes", async () => {
		const { sqlite, insert, db } = fixture();
		expectAccurate(sqlite);
		expect((await listCatalogApps(db)).total).toBe(2);
		expect(
			(await listCatalogApps(db, { hideShadowedVariants: true })).total,
		).toBe(1);
		for (const statement of [
			"UPDATE app_catalog SET review_status = 'RELEASED' WHERE id = 'pending'",
			"UPDATE app_catalog SET explore_shadowed = 0 WHERE id = 'shadowed'",
			"UPDATE app_catalog SET is_discoverable = 1 WHERE id = 'private'",
			"UPDATE app_catalog SET developer_type = 'THIRD_PARTY' WHERE id = 'untrusted'",
			"UPDATE app_catalog SET status = 'DISABLED' WHERE id = 'visible'",
			"UPDATE app_catalog SET developer_type = NULL WHERE id = 'pending'",
			"UPDATE app_catalog SET review_status = NULL WHERE id = 'private'",
			"DELETE FROM app_catalog WHERE id = 'shadowed'",
		]) {
			sqlite.exec(statement);
			expectAccurate(sqlite);
		}
		insert.run("new", "Fictional New", "THIRD_PARTY", 1, "RELEASED", 0);
		expectAccurate(sqlite);
		sqlite.exec("DELETE FROM app_catalog");
		expectAccurate(sqlite);
		expect((await listCatalogApps(db)).total).toBe(0);
	});

	it("reads one counter and an indexed page, without a catalog count or sort", async () => {
		const { sqlite, insert } = fixture();
		for (let i = 0; i < 10000; i++) {
			insert.run(
				`bulk-${i}`,
				`A ${String(i).padStart(5, "0")}`,
				"THIRD_PARTY",
				1,
				"RELEASED",
				i % 2,
			);
		}
		const queries: string[] = [];
		const db = createDbClient(
			createD1Facade({
				exec: (sql) => sqlite.exec(sql),
				prepare: (sql) => {
					queries.push(sql);
					return sqlite.prepare(sql);
				},
			}),
		);
		for (const hideShadowedVariants of [false, true]) {
			queries.length = 0;
			const result = await listCatalogApps(db, {
				hideShadowedVariants,
				limit: 50,
				offset: 50,
			});
			expect(result.apps).toHaveLength(50);
			expect(result.total).toBe(hideShadowedVariants ? 5001 : 10002);
			expect(queries).toHaveLength(2);
			expect(queries[0]).toContain("app_catalog_browse_totals");
			expect(queries.join("\n")).not.toMatch(/count\(/i);
			const plan = sqlite
				.prepare(`EXPLAIN QUERY PLAN ${queries[1]}`)
				.all(50, 50);
			const detail = plan.map((row) => row.detail).join("\n");
			expect(detail).toContain(
				hideShadowedVariants
					? "app_catalog_explore_name_idx"
					: "app_catalog_public_browse_name_idx",
			);
			expect(detail).not.toMatch(/TEMP B-TREE/);
		}
	});

	it("keeps filtered counts exact and fails clearly if the counter is missing", async () => {
		const { sqlite, db } = fixture();
		expect((await listCatalogApps(db, { developerType: "OAI" })).total).toBe(1);
		expect((await listCatalogApps(db, { includeAll: true })).total).toBe(4);
		sqlite.exec("DELETE FROM app_catalog_browse_totals");
		await expect(listCatalogApps(db)).rejects.toThrow(
			"Catalog browse totals migration is missing",
		);
	});
});
