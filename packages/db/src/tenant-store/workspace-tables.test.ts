import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { createMigratedSqlite } from "../test/migrated-sqlite";
import { tenantStoreMigrations } from "./migrations";

const databases: DatabaseSync[] = [];
afterEach(() => {
	for (const db of databases.splice(0)) db.close();
});

/** Tables the workspace migration copies into the store besides memory. */
const workspaceTables = [
	"os_workspaces",
	"os_outputs",
	"os_output_revisions",
	"os_workspace_resources",
	"kernel_conversations",
	"kernel_runtime_runs",
	"kernel_runtime_events",
	"kernel_tool_results",
	"tedi_artifacts",
];

/**
 * The core's Drizzle schema keys this index on coalesced owner and connection
 * columns, but its migration chain only created the narrower column list. The
 * store follows the schema; that key is wider, so every core row still fits.
 */
const EXPRESSION_INDEX = "os_workspace_resources_provider_object_unique";

describe("workspace table contract", () => {
	it("matches the core columns and indexes so rows copy by name", () => {
		const platform = createMigratedSqlite();
		databases.push(platform);
		const local = new DatabaseSync(":memory:");
		databases.push(local);
		for (const migration of Object.values(tenantStoreMigrations))
			local.exec(migration);
		for (const table of workspaceTables) {
			// Order differs where the core added columns later; import copies by name.
			const columns = (db: DatabaseSync) =>
				db
					.prepare(`PRAGMA table_info('${table}')`)
					.all()
					.map(({ cid: _cid, ...column }) => column)
					.sort((a, b) => String(a.name).localeCompare(String(b.name)));
			expect(columns(local), table).toEqual(columns(platform));
			const indexes = (db: DatabaseSync) =>
				db
					.prepare(
						"SELECT name, sql FROM sqlite_schema WHERE type='index' AND tbl_name=? AND name NOT IN (?) ORDER BY name",
					)
					.all(table, EXPRESSION_INDEX);
			expect(indexes(local), table).toEqual(indexes(platform));
		}
	});
});
