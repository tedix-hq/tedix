import { sql } from "drizzle-orm";
import type { DbQueryClient } from "../query-client";

export function readD1MigrationInspection(db: DbQueryClient) {
	// Wrangler owns this table, outside the Drizzle migration models.
	const ledger = db
		.select({ name: sql<string>`name`.as("name") })
		.from(sql`tedix_drizzle_migrations`)
		.orderBy(sql`id`);
	// Keep the native result envelopes so the caller can check success as well as rows.
	return db.batch([db.run(ledger), db.run(sql`PRAGMA foreign_key_check`)]);
}
