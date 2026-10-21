/**
 * Database size, as D1 itself reports it. Every D1 result carries
 * `meta.size_after`, the database size in bytes after the statement ran, so
 * a trivial statement measures the database without scanning anything.
 */

import { sql } from "drizzle-orm";
import type { DbQueryClient } from "../query-client";

export async function readD1SizeBytes(
	db: DbQueryClient,
): Promise<number | null> {
	try {
		const result = await db.run(sql`SELECT 1`);
		const size = (result.meta as { size_after?: unknown } | undefined)
			?.size_after;
		return typeof size === "number" && Number.isFinite(size) ? size : null;
	} catch (error) {
		console.warn(
			JSON.stringify({
				signal: "d1.size.probe_failed",
				message: error instanceof Error ? error.message : String(error),
			}),
		);
		return null;
	}
}
