/**
 * Tenant-store plane: a per-workspace Durable Object's own SQLite instance,
 * driven through `drizzle-orm/durable-sqlite`.
 *
 * The clean-cut plan (epic 00290527, decision a515d1f2) moves a bounded set of
 * row-owning query domains — os outputs, output revisions, and tedi/skill-run
 * artifact metadata — out of the shared platform D1 and into the workspace's
 * own store. Bodies stay in R2; only metadata and R2 pointers move.
 *
 * Semantics differences from the D1 variants are confined to this file's
 * client: `db.batch()` does not exist on the DO driver; multi-statement
 * atomicity is `db.transaction()`, which runs the callback inside
 * `storage.transactionSync`. The callback must stay synchronous — call
 * `.run()`, `.all()`, `.get()` and read `Result<'sync', T>` values directly;
 * awaiting inside the callback suspends past `transactionSync`'s commit.
 */

import { drizzle } from "drizzle-orm/durable-sqlite";

/** Drizzle client bound to one Durable Object's SQLite storage. */
export function createTenantStoreDb(storage: DurableObjectStorage) {
	return drizzle(storage);
}

export type TenantStoreDb = ReturnType<typeof createTenantStoreDb>;

/**
 * The planes a query domain may be homed on. Named for the same values
 * `scripts/db-access-exceptions.json` uses so config, lint manifests, and
 * review language stay one vocabulary.
 */
export type TenantStorePlane = "platform-d1" | "do-local-sqlite";
