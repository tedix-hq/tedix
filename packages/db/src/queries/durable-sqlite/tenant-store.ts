/**
 * Tenant-store plane: a per-workspace Durable Object's own SQLite instance,
 * driven through `drizzle-orm/durable-sqlite`.
 *
 * The clean-cut plan (epic 00290527, decision a515d1f2) moves a bounded set of
 * row-owning query domains — os outputs, output revisions, and tedi/skill-run
 * artifact metadata — out of the shared platform D1 and into the workspace's
 * own store. Bodies stay in R2; only metadata and R2 pointers move.
 *
 * Plane selection is explicit config, never inferred from bindings: the
 * storage-plane config names a plane, `resolveTenantStore` maps it to the
 * matching client, and callers branch on the returned discriminant to pick
 * the matching query leaf (`"platform-d1"` → `../os-workspaces/outputs.ts`
 * etc., `"do-local-sqlite"` → the leaves in this directory).
 *
 * Semantics differences from the D1 variants are confined to this file's
 * client: `db.batch()` does not exist on the DO driver; multi-statement
 * atomicity is `db.transaction()`, which runs the callback inside
 * `storage.transactionSync`. The callback must stay synchronous — call
 * `.run()`, `.all()`, `.get()` and read `Result<'sync', T>` values directly;
 * awaiting inside the callback suspends past `transactionSync`'s commit.
 */

import { drizzle } from "drizzle-orm/durable-sqlite";
import type { DbQueryClient } from "../../query-client";

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

/** The client the selected plane routes a domain's statements to. */
export type TenantStoreBinding =
	| { plane: "platform-d1"; db: DbQueryClient }
	| { plane: "do-local-sqlite"; db: TenantStoreDb };

export interface TenantStoreClients {
	/** Shared platform D1 client; always available. */
	platform: DbQueryClient;
	/** The workspace's DO-local client; required when the plane selects it. */
	tenant?: TenantStoreDb;
}

/**
 * Map storage-plane config to a usable binding. Selecting `do-local-sqlite`
 * without a tenant client fails closed rather than silently falling back to
 * the shared database: a wrong-plane write is worse than a refused one.
 */
export function resolveTenantStore(
	config: { plane: TenantStorePlane },
	clients: TenantStoreClients,
): TenantStoreBinding {
	if (config.plane === "platform-d1") {
		return { plane: "platform-d1", db: clients.platform };
	}
	if (!clients.tenant) {
		throw new Error(
			"TENANT_STORE_UNBOUND: storage-plane config selects do-local-sqlite but no tenant-store client was provided.",
		);
	}
	return { plane: "do-local-sqlite", db: clients.tenant };
}
