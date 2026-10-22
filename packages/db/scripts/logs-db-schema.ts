/**
 * Render the logs database DDL from the Drizzle tables in
 * `src/schema/logs-db.ts`: log tables without foreign keys (their parents
 * stay in main), plus logs-local partition metadata.
 *
 *   bun scripts/logs-db-schema.ts              # print the DDL
 *   bun scripts/logs-db-schema.ts --write PATH # write it to PATH
 *   bun scripts/logs-db-schema.ts --table log_partition --write PATH
 *
 * The checked-in migrations under `logs-db/migrations/` are append-only, like
 * the main chain. When a main-table column or index changes, add the next
 * numbered migration by hand with the ALTER/CREATE INDEX statements;
 * `scripts/logs-db-schema.test.ts` fails until the applied migrations match
 * this rendering.
 */

import { writeFileSync } from "node:fs";
import { getTableName } from "drizzle-orm";
import { LOGS_DB_TABLES } from "../src/schema/logs-db";
import { tableDdl } from "../src/test/schema-ddl";

export function renderLogsDbSchema(tableName?: string): string {
	const tables = tableName
		? LOGS_DB_TABLES.filter((table) => getTableName(table) === tableName)
		: LOGS_DB_TABLES;
	if (!tables.length) throw new Error(`Unknown logs table: ${tableName}`);
	const statements = tables.flatMap((table) =>
		tableDdl(table, { foreignKeys: false }),
	);
	return `-- Logs database schema, rendered by scripts/logs-db-schema.ts.\n-- Log tables without foreign keys, plus logs-local metadata.\n${statements.join("\n")}\n`;
}

if (import.meta.main) {
	const args = process.argv.slice(2);
	const write = args.indexOf("--write");
	const table = args.indexOf("--table");
	if (table >= 0 && !args[table + 1]) throw new Error("--table needs a name");
	const sql = renderLogsDbSchema(table >= 0 ? args[table + 1] : undefined);
	if (write >= 0) {
		const target = args[write + 1];
		if (!target) throw new Error("--write needs a path");
		writeFileSync(target, sql);
		console.log(`wrote ${target}`);
	} else {
		process.stdout.write(sql);
	}
}
