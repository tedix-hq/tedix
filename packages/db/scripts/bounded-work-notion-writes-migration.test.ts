import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vite-plus/test";

const sql = readFileSync(
	new URL(
		"../drizzle/20261020203221_bounded_work_notion_writes/migration.sql",
		import.meta.url,
	),
	"utf8",
);

describe("bounded Work and Notion policy repair", () => {
	it("repairs exact canonical operations, preserves policy and skips lookalikes and reviewed overrides", () => {
		const db = new DatabaseSync(":memory:");
		try {
			db.exec(
				"CREATE TABLE apps(id TEXT, metadata TEXT); CREATE TABLE app_tools(id TEXT, app_id TEXT, tool_id TEXT, config TEXT, annotations TEXT, meta TEXT, write_capability TEXT)",
			);
			db.prepare("INSERT INTO apps VALUES (?,?)").run(
				"notion-app",
				JSON.stringify({ mcpConfig: { connectionProviderId: "notion" } }),
			);
			const insert = db.prepare("INSERT INTO app_tools VALUES (?,?,?,?,?,?,?)");
			const prior = {
				"com.tedix/policy": {
					riskTier: "external_side_effect",
					blastRadius: "external_system",
				},
				other: "retained",
			};
			const rows = [
				[
					"cancel",
					"work-app",
					"cancel_work_items",
					{
						transport: "rpc",
						endpoint: "workItems/cancel",
						approvalPolicy: "always",
					},
					prior,
				],
				[
					"update",
					"notion-app",
					"notion_update_page",
					{ transport: "mcp", mcpToolName: "notion-update-page" },
					prior,
				],
				[
					"create",
					"notion-app",
					"notion_create_pages",
					{ transport: "mcp", mcpToolName: "notion-create-pages" },
					prior,
				],
				[
					"spoof",
					"other-app",
					"notion_update_page",
					{ transport: "mcp", mcpToolName: "notion-update-page" },
					prior,
				],
				[
					"other-rpc",
					"work-app",
					"cancel_work_items",
					{ transport: "rpc", endpoint: "orders/cancel" },
					prior,
				],
				[
					"reviewed",
					"notion-app",
					"notion_update_page",
					{ transport: "mcp", mcpToolName: "notion-update-page" },
					{
						"com.tedix/policy": {
							owner: "operator",
							riskTier: "high_impact_write",
							blastRadius: "tenant",
						},
					},
				],
			] as const;
			for (const [id, app, name, config, meta] of rows)
				insert.run(
					id,
					app,
					name,
					JSON.stringify(config),
					JSON.stringify({ destructiveHint: true }),
					JSON.stringify(meta),
					"destructive",
				);
			db.exec(sql);
			const state = () =>
				db.prepare("SELECT * FROM app_tools ORDER BY id").all();
			const first = state();
			db.exec(sql);
			expect(state()).toEqual(first);
			const read = (id: string) => first.find((row) => row.id === id)!;
			expect(
				JSON.parse(String(read("cancel").annotations)).destructiveHint,
			).toBe(false);
			expect(JSON.parse(String(read("cancel").config)).approvalPolicy).toBe(
				"always",
			);
			for (const id of ["cancel", "update", "create"]) {
				const meta = JSON.parse(String(read(id).meta));
				expect(meta["com.tedix/policy"].riskTier).toBe("bounded_write");
				expect(meta.other).toBe("retained");
			}
			expect(
				JSON.parse(String(read("update").meta))["com.tedix/policy"]
					.argumentPolicy,
			).toBe("notion_page_update");
			for (const id of ["spoof", "other-rpc", "reviewed"])
				expect(read(id).meta).toBe(
					JSON.stringify(rows.find((row) => row[0] === id)![4]),
				);
		} finally {
			db.close();
		}
	});
});
