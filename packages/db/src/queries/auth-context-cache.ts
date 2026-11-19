import { eq, sql } from "drizzle-orm";
import type { DbQueryClient } from "../query-client";
import { authContextCacheState } from "../schema/auth-context-cache";

export async function readAuthContextCacheVersion(db: DbQueryClient) {
	const [row] = await db
		.select({ version: authContextCacheState.version })
		.from(authContextCacheState)
		.where(eq(authContextCacheState.id, 1));
	return row?.version;
}

/** Logical eviction in every colo, including Cache API entries we cannot delete remotely. */
export async function invalidateAuthContextCache(db: DbQueryClient) {
	await db
		.update(authContextCacheState)
		.set({ version: sql`lower(hex(randomblob(16)))` })
		.where(eq(authContextCacheState.id, 1));
}
