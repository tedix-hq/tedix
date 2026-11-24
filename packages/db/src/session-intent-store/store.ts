/**
 * A session intent Durable Object's own SQLite, driven through
 * `drizzle-orm/durable-sqlite`. Queries live in
 * `queries/durable-sqlite/session-intent.ts`.
 */
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/durable-sqlite";
import { migrate } from "drizzle-orm/durable-sqlite/migrator";
import { sessionIntentStoreMigrations } from "./migrations";

export type SessionIntentStoreDb = ReturnType<typeof drizzle>;

/** Open the intent's table, bringing an older intent up to the current chain first. */
export function openSessionIntentStore(
	storage: DurableObjectStorage,
): SessionIntentStoreDb {
	const db = drizzle(storage);
	adoptLegacyIntentColumns(db);
	migrate(db, { migrations: sessionIntentStoreMigrations });
	return db;
}

/**
 * Intents created before the grant and reauthentication columns existed have
 * a `session_intent` table without them, and the baseline migration only
 * creates a missing table. Runs once, before the intent adopts the chain.
 */
function adoptLegacyIntentColumns(db: SessionIntentStoreDb) {
	// table_info is empty for a table that does not exist.
	if (db.all(sql`PRAGMA table_info(__drizzle_migrations)`).length > 0) return;
	const columns = new Set(
		db
			.all<{ name: string }>(sql`PRAGMA table_info(session_intent)`)
			.map((column) => column.name),
	);
	if (columns.size === 0) return;
	if (!columns.has("grant_kind"))
		db.run(sql`ALTER TABLE session_intent ADD COLUMN grant_kind TEXT`);
	if (!columns.has("granted_tenant_id"))
		db.run(sql`ALTER TABLE session_intent ADD COLUMN granted_tenant_id TEXT`);
	if (!columns.has("reauth_started_at"))
		db.run(
			sql`ALTER TABLE session_intent ADD COLUMN reauth_started_at INTEGER`,
		);
}
