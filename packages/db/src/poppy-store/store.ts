/**
 * Poppy conversation tables in the tedi runtime Durable Object's SQLite,
 * driven through `drizzle-orm/durable-sqlite`. Queries live in
 * `queries/durable-sqlite/poppy-conversations.ts` and are synchronous.
 */
import { drizzle } from "drizzle-orm/durable-sqlite";
import { migrate } from "drizzle-orm/durable-sqlite/migrator";
import { poppyStoreMigrations } from "./migrations";

export type PoppyStoreDb = ReturnType<typeof drizzle>;

/**
 * Open the Poppy tables, applying any missing migration. The object's other
 * tables share its migration ledger; entries are tracked by name.
 */
export function openPoppyStore(storage: DurableObjectStorage): PoppyStoreDb {
	const db = drizzle(storage);
	migrate(db, { migrations: poppyStoreMigrations });
	return db;
}
