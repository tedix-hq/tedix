/**
 * The organization wallet Durable Object's own SQLite, driven through
 * `drizzle-orm/durable-sqlite`. Queries live in
 * `queries/durable-sqlite/billing-wallet.ts`; they are synchronous, so a
 * charge's checks and writes cannot interleave with another request.
 */
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/durable-sqlite";
import { migrate } from "drizzle-orm/durable-sqlite/migrator";
import { walletStoreMigrations } from "./migrations";

export type WalletStoreDb = ReturnType<typeof drizzle>;

/** Open the wallet's tables, bringing an older wallet up to the current chain first. */
export function openWalletStore(storage: DurableObjectStorage): WalletStoreDb {
	const db = drizzle(storage);
	adoptLegacyWalletColumns(db);
	migrate(db, { migrations: walletStoreMigrations });
	return db;
}

/**
 * Wallets created on 23 Nov 2026 before 15:02 UTC+1 have `wallet_events`
 * without the model-call columns, and the baseline migration only creates
 * missing tables. Runs once, before the wallet adopts the migration chain.
 */
function adoptLegacyWalletColumns(db: WalletStoreDb) {
	// table_info is empty for a table that does not exist.
	if (db.all(sql`PRAGMA table_info(__drizzle_migrations)`).length > 0) return;
	const columns = new Set(
		db
			.all<{ name: string }>(sql`PRAGMA table_info(wallet_events)`)
			.map((column) => column.name),
	);
	if (columns.size === 0) return;
	if (!columns.has("kind"))
		db.run(
			sql`ALTER TABLE wallet_events ADD COLUMN kind TEXT NOT NULL DEFAULT 'code_run'`,
		);
	if (!columns.has("expires_at"))
		db.run(sql`ALTER TABLE wallet_events ADD COLUMN expires_at INTEGER`);
	if (!columns.has("hold_context"))
		db.run(sql`ALTER TABLE wallet_events ADD COLUMN hold_context TEXT`);
	if (!columns.has("idempotency_key"))
		db.run(sql`ALTER TABLE wallet_events ADD COLUMN idempotency_key TEXT`);
}
