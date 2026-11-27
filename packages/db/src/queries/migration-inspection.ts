import { sql } from "drizzle-orm";
import { coreStore } from "../core-store/dialect";
import type { DbQueryClient } from "../query-client";

export async function readD1MigrationPublicationRevision(db: DbQueryClient) {
	// The ledger is D1's (tedix_drizzle_migrations); Postgres has none, so the
	// publication fence sees no revision there (follow-up f83460e3).
	if (coreStore(db) === "postgres") return null;
	const rows = await db
		.select({
			id: sql<number>`id`.as("id"),
			name: sql<string>`name`.as("name"),
		})
		.from(sql`tedix_drizzle_migrations`)
		.orderBy(sql`id DESC`)
		.limit(1);
	return rows[0] ?? null;
}

export function readD1MigrationInspection(db: DbQueryClient) {
	// Wrangler owns this table, outside the Drizzle migration models.
	const ledger = db
		.select({ name: sql<string>`name`.as("name") })
		.from(sql`tedix_drizzle_migrations`)
		.orderBy(sql`id`);
	// Keep the native result envelopes so the caller can check success as well as rows.
	return db.batch([db.run(ledger), db.run(sql`PRAGMA foreign_key_check`)]);
}
