import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vite-plus/test";
import {
	toolClassDeclarationGap,
	declaredAutoApproval,
	declaredToolClass,
} from "@tedix/api-contract/utils/tool-declared-class";

const sql = readFileSync(
	new URL(
		"../drizzle/20261114160256_require-tool-class/migration.sql",
		import.meta.url,
	),
	"utf8",
);

describe("tool class migration", () => {
	it("preserves rows and metadata, fills every non-read class conservatively and is idempotent", () => {
		const db = new DatabaseSync(":memory:");
		try {
			db.exec(
				"CREATE TABLE app_tools (id TEXT PRIMARY KEY, tool_type_id TEXT, annotations TEXT, write_capability TEXT, meta TEXT, config TEXT)",
			);
			const insert = db.prepare(
				"INSERT INTO app_tools VALUES (?, 'rpc', ?, ?, ?, ?)",
			);
			const bounded = {
				"com.tedix/policy": {
					riskTier: "bounded_write",
					blastRadius: "single_resource",
					declared: true,
				},
				unrelated: "kept",
			};
			const rows = [
				[
					"mystery",
					null,
					null,
					{ unrelated: "kept", "com.tedix/policy": { owner: "reviewer" } },
				],
				["tidy_notes", null, "destructive", bounded],
				["missing_tier", null, "write", null],
				["null_policy", null, "write", { "com.tedix/policy": null }],
				[
					"bad_reach",
					null,
					"write",
					{
						"com.tedix/policy": {
							riskTier: "bounded_write",
							blastRadius: "external_system",
						},
					},
				],
				["reviewed", null, "write", bounded],
				["read", { readOnlyHint: true }, null, null],
			] as const;
			for (const [id, annotations, capability, meta] of rows)
				insert.run(
					id,
					annotations ? JSON.stringify(annotations) : null,
					capability,
					meta ? JSON.stringify(meta) : null,
					'{"endpoint":"kept"}',
				);
			db.exec(sql);
			const after = db.prepare("SELECT * FROM app_tools ORDER BY id").all();
			expect(after).toHaveLength(rows.length);
			for (const row of after) {
				const tool = {
					writeCapability: row.write_capability as
						| "read"
						| "write"
						| "destructive",
					meta: row.meta ? JSON.parse(String(row.meta)) : null,
				};
				expect(toolClassDeclarationGap(tool)).toBeNull();
				expect(row.config).toBe('{"endpoint":"kept"}');
				if (row.id !== "read" && row.id !== "reviewed")
					expect(declaredAutoApproval(declaredToolClass(tool)!).eligible).toBe(
						false,
					);
				if (row.id === "reviewed") expect(tool.meta).toEqual(bounded);
				if (row.id === "mystery")
					expect(tool.meta).toMatchObject({
						unrelated: "kept",
						"com.tedix/policy": { owner: "reviewer" },
					});
			}
			db.exec(sql);
			expect(db.prepare("SELECT * FROM app_tools ORDER BY id").all()).toEqual(
				after,
			);
		} finally {
			db.close();
		}
	});
});
