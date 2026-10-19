import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { expect, it } from "vite-plus/test";
import asset from "@tedix/api-contract/assets/attention-app-views.v2.json";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const names = readdirSync(join(root, "drizzle"))
	.filter((n) => /^\d{14}_/.test(n))
	.sort();
function apply(db: DatabaseSync, name: string) {
	db.exec(
		readFileSync(
			join(root, "drizzle", name, "migration.sql"),
			"utf8",
		).replaceAll("--> statement-breakpoint", ""),
	);
}
it("seeds owning apps idempotently and leaves the exact versioned specs in D1", () => {
	const db = new DatabaseSync(":memory:");
	try {
		for (const name of names) {
			if (name.startsWith("20261019200603_")) break;
			apply(db, name);
		}
		db.exec("PRAGMA foreign_keys = OFF");
		const insert = db.prepare(
			"INSERT INTO app_tools(id,app_id,tool_type_id,tool_id,title,config,adapter_scope,result_strategy,visibility,enabled) VALUES(?,?,'rpc',?,?,?,'primary','merge','private',1)",
		);
		for (const app of ["fictional-maple", "fictional-orchard"]) {
			for (const [tool, endpoint] of [
				["list_deck_cards", "attention/listDeckCards"],
				["list_feed_for_you", "attention/listFeedForYou"],
				["decide_deck_card", "attention/decideDeckCard"],
			])
				insert.run(
					`${app}-${tool}`,
					app,
					tool!,
					tool!,
					JSON.stringify({ transport: "rpc", endpoint }),
				);
		}
		const migrations = names.filter(
			(n) =>
				n.startsWith("20261019200603_") ||
				n.includes("_attention-app-value-bindings") ||
				n.includes("_attention-app-view-assets") ||
				n.includes("_attention-layout-catalog-props") ||
				n.includes("_attention-card-tldr"),
		);
		for (let pass = 0; pass < 2; pass++)
			for (const name of migrations) apply(db, name);
		for (const app of ["fictional-maple", "fictional-orchard"]) {
			for (const [endpoint, view] of Object.entries(asset.views)) {
				const tool = endpoint.endsWith("showDeck") ? "show_deck" : "show_feed";
				const row = db
					.prepare(
						"SELECT config,widget_key,widget_route,output_schema,visibility FROM app_tools WHERE app_id=? AND tool_id=?",
					)
					.get(app, tool)!;
				expect(JSON.parse(String(row.config))).toMatchObject({
					endpoint,
					nativeDirect: true,
					modelSummaryTemplate: "{markdown}",
					layoutSpec: view.layoutSpec,
				});
				expect(row.widget_key).toBe("render");
				expect(row.widget_route).toBe(`/r/${view.layoutId}`);
				expect(row.visibility).toBe("private");
				expect(JSON.parse(String(row.output_schema)).properties).toHaveProperty(
					"cards",
				);
			}
			expect(
				db
					.prepare(
						"SELECT count(*) AS total FROM app_tools WHERE app_id=? AND tool_id IN ('show_deck','show_feed')",
					)
					.get(app)!.total,
			).toBe(2);
		}
	} finally {
		db.close();
	}
});
