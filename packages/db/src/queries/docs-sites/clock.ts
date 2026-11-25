import { sql } from "drizzle-orm";
import { coreStore } from "../../core-store/dialect";

/** Registry timestamps retain the existing UTC text format on both stores. */
export function docsNow(db: object) {
	return coreStore(db) === "postgres"
		? sql`to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')`
		: sql`datetime('now')`;
}
