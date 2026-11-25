import { PGlite } from "@electric-sql/pglite";
import { relations } from "../schema-pg/relations";
import { drizzle } from "drizzle-orm/pglite";
import { adaptPostgresClient } from "../core-store/client";

/** In-memory only: no connection strings, filesystem database or production bindings. */
export async function createPGliteFacade() {
	const engine = new PGlite();
	const db = adaptPostgresClient(
		drizzle({ client: engine, relations }),
		(statements) =>
			engine.transaction(async (transaction) => {
				const results = [];
				for (const statement of statements) {
					const result = await transaction.query(
						statement.sql,
						statement.params,
						{ rowMode: "array" },
					);
					results.push({
						rows: result.rows as unknown[][],
						count: result.affectedRows ?? result.rows.length,
					});
				}
				return results;
			}),
	);
	return { db, engine, close: () => engine.close() };
}
