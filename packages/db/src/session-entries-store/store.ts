/**
 * The tedi session repo's `session_entries` table, driven through
 * `drizzle-orm/durable-sqlite`. Queries live in
 * `queries/durable-sqlite/session-entries.ts`. The tedi runtime object also
 * holds other Drizzle stores; drizzle-orm tracks migrations by name, so they
 * share one `__drizzle_migrations` table.
 */
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/durable-sqlite";
import { migrate } from "drizzle-orm/durable-sqlite/migrator";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { sessionEntriesStoreMigrations } from "./migrations";

export type SessionEntriesDb = ReturnType<typeof drizzle>;
/**
 * The slice of Durable Object storage Drizzle drives. Structural, so callers
 * compiled without Workers types (packages/tedi-session) can name it.
 */
export type SessionEntriesStorage = {
	sql: unknown;
	transactionSync<T>(closure: () => T): T;
};

/** Drizzle's own ledger, shared by every store in this object; not in the schema. */
const drizzleMigrations = sqliteTable("__drizzle_migrations", {
	id: integer("id").primaryKey(),
	name: text("name"),
});
const BASELINE = Object.keys(sessionEntriesStoreMigrations).sort()[0]!;

/** Drizzle client over the object's storage; creates no tables. */
export function openSessionEntriesStore(
	storage: SessionEntriesStorage,
): SessionEntriesDb {
	return drizzle(storage as unknown as Parameters<typeof drizzle>[0]);
}

/** Apply the chain, bringing an older `session_entries` table up to it first. */
export function ensureSessionEntriesTables(db: SessionEntriesDb): void {
	adoptLegacySessionColumns(db);
	migrate(db, { migrations: sessionEntriesStoreMigrations });
}

/**
 * Objects whose `session_entries` predates the compaction and model columns
 * lack them, and the baseline only creates a missing table. Runs before this
 * store's baseline is recorded; another store's migrations in the same
 * object do not count.
 */
function adoptLegacySessionColumns(db: SessionEntriesDb) {
	const columns = new Set(
		db
			.all<{ name: string }>(sql`PRAGMA table_info(session_entries)`)
			.map((column) => column.name),
	);
	if (columns.size === 0) return;
	if (
		db.all(sql`PRAGMA table_info(__drizzle_migrations)`).length > 0 &&
		db
			.select({ id: drizzleMigrations.id })
			.from(drizzleMigrations)
			.where(eq(drizzleMigrations.name, BASELINE))
			.get() !== undefined
	)
		return;
	if (!columns.has("first_kept_entry_id"))
		db.run(
			sql`ALTER TABLE session_entries ADD COLUMN first_kept_entry_id TEXT`,
		);
	if (!columns.has("tokens_before"))
		db.run(sql`ALTER TABLE session_entries ADD COLUMN tokens_before INTEGER`);
	if (!columns.has("model_provider"))
		db.run(sql`ALTER TABLE session_entries ADD COLUMN model_provider TEXT`);
	if (!columns.has("model_id"))
		db.run(sql`ALTER TABLE session_entries ADD COLUMN model_id TEXT`);
}
