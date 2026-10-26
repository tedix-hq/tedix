import { getColumns, getTableName } from "drizzle-orm";
import type { SQLiteTable } from "drizzle-orm/sqlite-core";
import { createDbClient } from "@tedix/db/client";
import { createD1Facade, type D1FacadeOptions } from "@tedix/db/test/d1-facade";
import { createMigratedSqlite } from "@tedix/db/test/migrated-sqlite";

// Replay the ledger during suite setup; individual tests only deserialize a copy.
createMigratedSqlite({ foreignKeys: false }).close();

/** Real migrated SQL, with mutable seed/readback arrays for the older router suites.
 * Foreign keys are off because these fixtures intentionally seed individual ledgers
 * without the unrelated organization, identity and provider graphs.
 */
export function createApiSqliteFixture(options: D1FacadeOptions = {}) {
	const sqlite = createMigratedSqlite({ foreignKeys: false });
	const collections: Array<{
		table: SQLiteTable;
		rows: Record<string, unknown>[];
		snapshot: string;
	}> = [];
	const seed = (table: SQLiteTable, rows: Record<string, unknown>[]) => {
		const columns = getColumns(table);
		for (const row of rows) {
			const entries = Object.entries(columns).filter(
				([key]) => row[key] !== undefined,
			);
			const names = entries.map(([, column]) => `"${column.name}"`).join(", ");
			const values = entries.map(([key, column]) =>
				row[key] === null ? null : column.mapToDriverValue(row[key]),
			);
			sqlite
				.prepare(
					`insert into "${getTableName(table)}" (${names}) values (${entries.map(() => "?").join(", ")})`,
				)
				.run(...values);
		}
	};
	const sync = () => {
		for (const collection of collections) {
			const snapshot = JSON.stringify(collection.rows);
			if (snapshot === collection.snapshot) continue;
			sqlite.exec(`delete from "${getTableName(collection.table)}"`);
			seed(collection.table, collection.rows);
			collection.snapshot = snapshot;
		}
	};
	const refresh = () => {
		for (const collection of collections) {
			const columns = Object.entries(getColumns(collection.table));
			const rows = sqlite
				.prepare(
					`select * from "${getTableName(collection.table)}" order by rowid`,
				)
				.all()
				.map((raw) => {
					const record = raw as Record<string, unknown>;
					const decoded = Object.fromEntries(
						columns.map(([key, column]) => [
							key,
							record[column.name] === null
								? null
								: column.dataType === "object json"
									? JSON.parse(String(record[column.name]))
									: column.dataType === "boolean"
										? Boolean(record[column.name])
										: column.mapFromDriverValue(record[column.name]),
						]),
					);
					const key = "id" in decoded ? "id" : "idempotencyKey";
					const existing = collection.rows.find(
						(row) => row[key] === decoded[key],
					);
					return existing ? Object.assign(existing, decoded) : decoded;
				});
			collection.rows.splice(0, collection.rows.length, ...rows);
			collection.snapshot = JSON.stringify(collection.rows);
		}
	};
	const facade = createD1Facade(sqlite, {
		...options,
		onPrepare(query, database) {
			sync();
			options.onPrepare?.(query, database);
		},
	});
	const prepare = facade.prepare.bind(facade);
	facade.prepare = (query) => {
		const statement = prepare(query);
		for (const method of ["all", "raw", "run"] as const) {
			const execute = statement[method].bind(statement);
			Object.assign(statement, {
				[method]: async (...args: unknown[]) => {
					const result = await Reflect.apply(execute, statement, args);
					refresh();
					return result;
				},
			});
		}
		return statement;
	};
	return {
		sqlite,
		db: createDbClient(facade),
		seed,
		rows<T extends Record<string, unknown>>(
			table: SQLiteTable,
			initial: T[] = [],
		): T[] {
			const rows = [...initial];
			seed(table, rows);
			collections.push({ table, rows, snapshot: JSON.stringify(rows) });
			refresh();
			return rows;
		},
	};
}
