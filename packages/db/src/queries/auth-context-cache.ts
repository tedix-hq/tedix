import { coreTable } from "../core-store/client";
import { eq } from "drizzle-orm";
import type { DbQueryClient } from "../query-client";
import { authContextCacheState as d1AuthContextCacheState } from "../schema/auth-context-cache";

export async function readAuthContextCacheVersion(db: DbQueryClient) {
	const authContextCacheState = coreTable(db, d1AuthContextCacheState);
	const [row] = await db
		.select({ version: authContextCacheState.version })
		.from(authContextCacheState)
		.where(eq(authContextCacheState.id, 1));
	return row?.version;
}

/** Logical eviction in every colo, including Cache API entries we cannot delete remotely. */
export async function invalidateAuthContextCache(db: DbQueryClient) {
	const authContextCacheState = coreTable(db, d1AuthContextCacheState);
	await db
		.update(authContextCacheState)
		.set({ version: crypto.randomUUID() })
		.where(eq(authContextCacheState.id, 1));
}
