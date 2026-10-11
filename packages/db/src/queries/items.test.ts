import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vite-plus/test";
import { createDbClient } from "../client";
import { items } from "../schema/items";
import { createD1Facade } from "../test/d1-facade";
import { schemaDdl } from "../test/schema-ddl";
import { searchItems } from "./items";

function fixture() {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec("PRAGMA foreign_keys = OFF");
	sqlite.exec(schemaDdl(items));
	const insert = sqlite.prepare(
		"INSERT INTO items (id, app_id, vertical, title, description) VALUES (?, 'app-1', 'generic', ?, ?)",
	);
	return {
		db: createDbClient(createD1Facade(sqlite)),
		insert: (id: string, title: string, description: string | null = null) =>
			insert.run(id, title, description),
	};
}

describe("searchItems", () => {
	it("matches a query longer than D1's 50-byte LIKE pattern cap", async () => {
		// The LIKE this replaced turned any 48+ character search into a D1_ERROR.
		const { db, insert } = fixture();
		const description =
			"Hand-finished walnut writing desk with three dovetailed drawers";
		insert("by-description", "Desk", description);
		insert("by-title", description.toUpperCase());
		insert("other", "Chair", null);

		const rows = await searchItems(db, "app-1", description.toUpperCase());
		expect(rows.map((row) => row.id).sort()).toEqual([
			"by-description",
			"by-title",
		]);
	});
});
