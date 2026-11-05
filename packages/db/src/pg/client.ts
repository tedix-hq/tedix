/**
 * Postgres storage-plane client types.
 *
 * The pg plane keeps the same two-client shape as the D1 plane: query leaves
 * take the narrowest client they need. `PgQueryClient` covers Core API
 * builders (the whole ported Work Items plane); `PgDbClient` is the same
 * object named for call sites that mirrored `DbClient`.
 *
 * Construction is driver-agnostic: any Drizzle async Postgres client works —
 * `drizzle({ client })` from `drizzle-orm/pglite` in tests, or a
 * `drizzle-orm/node-postgres` / `postgres-js` pool in service wiring. The
 * `pg-proxy` driver is NOT supported here: it has no transaction support and
 * admission + lease fencing is a transaction.
 */

import type { PgAsyncDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";

export type PgQueryClient = PgAsyncDatabase<PgQueryResultHKT>;
export type PgDbClient = PgAsyncDatabase<PgQueryResultHKT>;

/**
 * A transaction handle is the same type — ported leaves take `PgQueryClient`
 * so `tx` inside `db.transaction()` composes with every statement builder.
 */
export type PgTransaction = PgQueryClient;
