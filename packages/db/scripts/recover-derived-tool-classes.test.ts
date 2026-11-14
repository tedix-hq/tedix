import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vite-plus/test";

const migration = readFileSync(
	new URL(
		"../drizzle/20261114213503_recover-derived-tool-classes/migration.sql",
		import.meta.url,
	),
	"utf8",
);
const policyKey = "com.tedix/policy";

describe("derived tool class recovery migration", () => {
	it("restores baselines without declaring them and preserves uncertain or curated rows", () => {
		const db = new DatabaseSync(":memory:");
		try {
			db.exec(`
				CREATE TABLE tedix_drizzle_migrations (name TEXT, applied_at TEXT);
				INSERT INTO tedix_drizzle_migrations VALUES ('20261114160256_require-tool-class/migration.sql', '2026-11-14 16:33:14');
				CREATE TABLE audit_events (resource_id TEXT, timestamp INTEGER, metadata TEXT);
				CREATE TABLE app_tools (id TEXT, tool_id TEXT, write_capability TEXT, config TEXT, meta TEXT, annotations TEXT, schema_source TEXT, schema_synced_at TEXT, schema_source_hash TEXT, updated_at TEXT);
			`);
			const overwritten = {
				riskTier: "high_impact_write",
				blastRadius: "multi_tenant",
				declared: true,
			};
			const add = (
				id: string,
				options: {
					cap?: string | null;
					transport?: string;
					policy?: object;
					synced?: string | null;
					updated?: string;
					hash?: string | null;
					name?: string;
					source?: string;
				} = {},
			) => {
				const transport = options.transport ?? "rpc";
				db.prepare(
					"INSERT INTO app_tools VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
				).run(
					id,
					id,
					options.cap === undefined ? "write" : options.cap,
					JSON.stringify({ transport, mcpToolName: options.name }),
					JSON.stringify({
						other: "preserved",
						[policyKey]: options.policy ?? overwritten,
					}),
					JSON.stringify({
						readOnlyHint: false,
						destructiveHint: options.cap === "destructive",
					}),
					options.source ??
						(transport === "rpc"
							? "orpc"
							: transport === "external"
								? "openapi"
								: "mcp"),
					options.synced === undefined
						? "2026-11-13T00:00:00Z"
						: options.synced,
					options.hash === undefined ? "source-hash" : options.hash,
					options.updated ?? "2026-11-13T00:00:00Z",
				);
			};
			add("resolve_tedi_approvals");
			add("delete_data", { cap: "destructive" });
			add("external_send", { transport: "external" });
			add("mcp_send", { transport: "mcp" });
			add("curated", { policy: { ...overwritten, owner: "operator" } });
			add("argument", {
				policy: { ...overwritten, argumentPolicy: "reviewed" },
			});
			add("notion", { transport: "mcp", name: "notion-create-pages" });
			add("later", { updated: "2026-11-14T17:00:00Z" });
			add("unknown", { cap: null });
			add("no_provenance", { synced: null });
			add("no_hash", { hash: null });
			add("manual", { source: "manual" });
			add("audited_curated");
			db.prepare(
				"INSERT INTO audit_events VALUES (?, unixepoch('2026-11-14 15:00:00'), ?)",
			).run(
				"tools.audited_curated",
				JSON.stringify({
					riskTier: "high_impact_write",
					blastRadius: "tenant",
				}),
			);
			const before = db.prepare("SELECT * FROM app_tools").all();
			db.exec(migration);
			const after = db.prepare("SELECT * FROM app_tools").all();
			for (const [id, tier, radius] of [
				["resolve_tedi_approvals", "bounded_write", "single_resource"],
				["delete_data", "high_impact_write", "tenant"],
				["external_send", "external_side_effect", "external_system"],
				["mcp_send", "external_side_effect", "external_system"],
			]) {
				const row = after.find((r) => r.id === id)!;
				expect(JSON.parse(row.meta as string)).toEqual({
					other: "preserved",
					[policyKey]: { riskTier: tier, blastRadius: radius },
				});
			}
			for (const row of before.slice(4))
				expect(after.find((r) => r.id === row.id)).toEqual(row);
			db.exec(migration);
			expect(db.prepare("SELECT * FROM app_tools").all()).toEqual(after);
		} finally {
			db.close();
		}
	});
});
