/**
 * Render the logs database DDL from the Drizzle tables in
 * `src/schema/logs-db.ts`: the same tables as the main database, without
 * foreign keys (their parent tables stay in the main database).
 *
 *   bun scripts/logs-db-schema.ts              # print the DDL
 *   bun scripts/logs-db-schema.ts --write PATH # write it to PATH
 *
 * The checked-in migrations under `logs-db/migrations/` are append-only, like
 * the main chain. When a main-table column or index changes, add the next
 * numbered migration by hand with the ALTER/CREATE INDEX statements;
 * `scripts/logs-db-schema.test.ts` fails until the applied migrations match
 * this rendering.
 */

import { writeFileSync } from "node:fs";
import { LOGS_DB_TABLES } from "../src/schema/logs-db";
import { tableDdl } from "../src/test/schema-ddl";

export function renderLogsDbSchema(): string {
	const statements = LOGS_DB_TABLES.flatMap((table) =>
		tableDdl(table, { foreignKeys: false }),
	);
	return `-- Logs database schema, rendered by scripts/logs-db-schema.ts.\n-- Same tables as the main database, without foreign keys.\n${statements.join("\n")}\n`;
}

if (import.meta.main) {
	const args = process.argv.slice(2);
	const write = args.indexOf("--write");
	const sql = renderLogsDbSchema();
	if (write >= 0) {
		const target = args[write + 1];
		if (!target) throw new Error("--write needs a path");
		writeFileSync(target, sql);
		console.log(`wrote ${target}`);
	} else {
		process.stdout.write(sql);
	}
}
