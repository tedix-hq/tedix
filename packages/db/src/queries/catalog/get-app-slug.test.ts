import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vite-plus/test";
import { createDbClient } from "../../client";
import { createD1Facade } from "../../test/d1-facade";
import { generateUniqueCatalogAppSlug } from "./get-app";

/**
 * Catalog slugs are vendor names that every base app, connection provider,
 * tenant install and Code Mode namespace inherits. A disabled entry nothing was
 * built from must not push the vendor's live entry to a numbered slug.
 */
function catalogDb(
	rows: Array<{ id: string; slug: string; status: string }>,
	builtFrom: string[] = [],
) {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec(`
		CREATE TABLE app_catalog (
			id TEXT PRIMARY KEY NOT NULL,
			slug TEXT UNIQUE,
			status TEXT DEFAULT 'ENABLED',
			updated_at TEXT
		);
		CREATE TABLE apps (
			id TEXT PRIMARY KEY NOT NULL,
			catalog_app_id TEXT
		);
	`);
	for (const row of rows) {
		sqlite
			.prepare("INSERT INTO app_catalog (id, slug, status) VALUES (?, ?, ?)")
			.run(row.id, row.slug, row.status);
	}
	for (const catalogAppId of builtFrom) {
		sqlite
			.prepare("INSERT INTO apps (id, catalog_app_id) VALUES (?, ?)")
			.run(`app-${catalogAppId}`, catalogAppId);
	}
	return { db: createDbClient(createD1Facade(sqlite)), sqlite };
}

const slugOf = (sqlite: DatabaseSync, id: string) =>
	(
		sqlite.prepare("SELECT slug FROM app_catalog WHERE id = ?").get(id) as {
			slug: string;
		}
	).slug;

describe("generateUniqueCatalogAppSlug", () => {
	it("takes the plain slug from a disabled entry nothing was built from", async () => {
		const { db, sqlite } = catalogDb([
			{ id: "69b89e99-legacy", slug: "mailer", status: "DISABLED" },
		]);
		expect(await generateUniqueCatalogAppSlug(db, "Mailer")).toBe("mailer");
		expect(slugOf(sqlite, "69b89e99-legacy")).toBe("mailer-retired-69b89e99");
	});

	it("numbers the slug when the holder is live or something was built from it", async () => {
		for (const [rows, builtFrom] of [
			[[{ id: "live-entry", slug: "mailer", status: "ENABLED" }], []],
			[
				[{ id: "used-entry", slug: "mailer", status: "DISABLED" }],
				["used-entry"],
			],
		] as const) {
			const { db, sqlite } = catalogDb([...rows], [...builtFrom]);
			expect(await generateUniqueCatalogAppSlug(db, "Mailer")).toBe("mailer-2");
			expect(slugOf(sqlite, rows[0].id)).toBe("mailer");
		}
	});
});
