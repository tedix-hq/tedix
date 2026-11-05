/**
 * Embedded-Postgres test harness for the pg storage plane.
 *
 * `createPgTestDb` spins up a fresh in-memory PGlite instance, applies the
 * supplied DDL, and returns a Drizzle client typed as `PgQueryClient` — the
 * same type every ported query function takes. PGlite runs real Postgres
 * (postgres.js under the hood), so transactions, `jsonb` operators, and
 * `RETURNING` behave exactly as on a server database.
 */

import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import type { PgQueryClient } from "../pg/client";

export interface PgTestDb {
	/** Drizzle query client over the embedded database. */
	db: PgQueryClient;
	/** Raw PGlite instance, for direct SQL assertions. */
	raw: PGlite;
	/** Release the instance (PGlite keeps an in-memory pool). */
	close: () => Promise<void>;
}

export async function createPgTestDb(ddl: string): Promise<PgTestDb> {
	const raw = await PGlite.create();
	if (ddl.trim().length > 0) await raw.exec(ddl);
	const db = drizzle({ client: raw });
	return { db, raw, close: () => raw.close() };
}
