import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { createMigratedSqlite } from "../test/migrated-sqlite";
import { tenantStoreMigrations } from "./migrations";

const databases: DatabaseSync[] = [];
afterEach(() => {
	for (const db of databases.splice(0)) db.close();
});

/** Tables mirrored from the core into the workspace store besides memory. */
const workspaceTables = [
	"os_workspaces",
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

/**
 * Serves the core's sweep of quiet delegated runs across organizations, which
 * never reads a workspace store.
 */
const CORE_SWEEP_INDEX = "idx_kernel_runtime_runs_quiet_delegated";

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
			// A generated column is computed by the core from stored columns, so it
			// is never copied; an index over one serves core queries only.
			const indexes = (db: DatabaseSync) =>
				db
					.prepare(
						`SELECT name, sql FROM sqlite_schema AS s WHERE type='index' AND tbl_name=? AND name NOT IN (?, ?)
							AND NOT EXISTS (
								SELECT 1 FROM pragma_index_info(s.name) AS i
								JOIN pragma_table_xinfo(s.tbl_name) AS c ON c.name = i.name
								WHERE c.hidden IN (2, 3)
							)
							ORDER BY name`,
					)
					.all(table, EXPRESSION_INDEX, CORE_SWEEP_INDEX);
			expect(indexes(local), table).toEqual(indexes(platform));
		}
	});
});
