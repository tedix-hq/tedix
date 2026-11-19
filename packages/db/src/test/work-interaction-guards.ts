import { createMigratedSqlite } from "./migrated-sqlite";

let triggerSql: string[] | undefined;

/** Load the final trigger definitions from the migrated schema once per worker. */
export function deployedWorkInteractionGuards(event: "insert" | "update") {
	if (!triggerSql) {
		const sqlite = createMigratedSqlite();
		try {
			triggerSql = sqlite
				.prepare(
					"SELECT sql FROM sqlite_schema WHERE type = 'trigger' AND tbl_name = 'work_interactions' ORDER BY rowid",
				)
				.all()
				.map((row) => String(row.sql));
		} finally {
			sqlite.close();
		}
	}
	const beforeEvent = new RegExp(`\\bBEFORE\\s+${event}\\s+ON\\b`, "i");
	return triggerSql.filter((sql) => beforeEvent.test(sql));
}
