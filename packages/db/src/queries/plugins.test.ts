import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vite-plus/test";
import { createDbClient } from "../client";
import { tediPlugins } from "../schema/plugins";
import { createD1Facade } from "../test/d1-facade";
import { schemaDdl } from "../test/schema-ddl";
import { listPlugins } from "./plugins";

function fixture() {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec("PRAGMA foreign_keys = OFF");
	sqlite.exec(schemaDdl(tediPlugins));
	const insert = sqlite.prepare(
		"INSERT INTO tedi_plugins (id, slug, name, type, version) VALUES (?, ?, ?, 'tool', '1.0.0')",
	);
	return {
		db: createDbClient(createD1Facade(sqlite)),
		insert: (id: string, name: string) => insert.run(id, id, name),
	};
}

describe("listPlugins", () => {
	it("matches a name query longer than D1's 50-byte LIKE pattern cap", async () => {
		// The LIKE this replaced turned any 48+ character search into a D1_ERROR.
		const { db, insert } = fixture();
		const name =
			"Regional accounts receivable reconciliation assistant for Northwind";
		insert("long", name);
		insert("short", "Regional reconciliation");

		const page = await listPlugins(db, { query: name.toUpperCase() });
		expect(page.total).toBe(1);
		expect(page.data.map((plugin) => plugin.id)).toEqual(["long"]);
	});
});
