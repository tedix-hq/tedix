import { getTableName, type SQL } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { defineRelations } from "drizzle-orm";
import postgres from "postgres";
import { createDbClient, type DbClient } from "../client";
import * as schema from "../schema-pg/core";
import { postgresBatch, type RunAtomicBatch } from "./batch";
import { registerCoreStore } from "./dialect";

export interface CoreStoreEnv {
	CORE_STORE?: "d1" | "postgres";
	DB: D1Database;
	CORE_HYPERDRIVE?: Pick<Hyperdrive, "connectionString">;
}
const pgTables = new Map<string, Parameters<typeof getTableName>[0]>(
	Object.values(schema).map((table) => [getTableName(table), table]),
);
const pgClients = new WeakSet<object>();
/** Select the physical table before building a query. The row/insert contract is unchanged. */
export function coreTable<T extends Parameters<typeof getTableName>[0]>(
	db: object,
	table: T,
): T {
	if (!pgClients.has(db)) return table;
	const pg = pgTables.get(getTableName(table));
	if (!pg) throw new Error(`Missing Postgres table: ${getTableName(table)}`);
	return pg as unknown as T;
}
/** Bind native Pg builders to the shared query surface, with one atomic batch adapter.
 * Lanes must select coreTable() and replace SQLite SQL before enabling their query paths. */
export function adaptPostgresClient(
	native: object,
	run: RunAtomicBatch,
): DbClient {
	const execute = (
		native as {
			execute(
				query: SQL,
			): Promise<
				Record<string, unknown>[] | { rows: Record<string, unknown>[] }
			>;
		}
	).execute.bind(native);
	const all = async (query: SQL) => {
		const result = await execute(query);
		return Array.isArray(result) ? result : result.rows;
	};
	Object.assign(native, {
		batch: postgresBatch(run),
		all,
		get: async (query: SQL) => (await all(query))[0],
		values: async (query: SQL) => (await all(query)).map(Object.values),
		run: async (query: SQL) => {
			const result = await execute(query);
			const count =
				(result as { count?: number; affectedRows?: number }).count ??
				(result as { affectedRows?: number }).affectedRows;
			return { success: true, results: [], meta: { changes: count ?? 0 } };
		},
	});
	pgClients.add(native);
	registerCoreStore(native, "postgres");
	return native as DbClient;
}
export function createCoreStore(env: CoreStoreEnv): {
	db: DbClient;
	close(): Promise<void>;
} {
	if (!env.CORE_STORE || env.CORE_STORE === "d1")
		return { db: createDbClient(env.DB), close: async () => {} };
	if (env.CORE_STORE !== "postgres") throw new Error("Unknown CORE_STORE");
	if (!env.CORE_HYPERDRIVE)
		throw new Error("CORE_STORE=postgres requires CORE_HYPERDRIVE");
	// Per request. Hyperdrive owns pooling. Use Cloudflare's recommended per-request connection limit.
	const sql = postgres(env.CORE_HYPERDRIVE.connectionString, {
		prepare: true,
		fetch_types: false,
		max: 5,
	});
	const native = drizzle({ client: sql, relations: defineRelations(schema) });
	const run: RunAtomicBatch = async (statements) => {
		// postgres.js 4 sends one extended-protocol batch with one Sync.
		// PostgreSQL commits it as one implicit transaction, or rolls it all back.
		const queries = statements.map((statement) => {
			const query = sql.unsafe(
				statement.sql,
				statement.params as postgres.ParameterOrJSON<never>[],
				{ prepare: true },
			);
			query.values();
			return query;
		});
		const results = await sql.batch(queries);
		return results.map((result) => ({
			rows: result as unknown as unknown[][],
			count: result.count,
		}));
	};
	return { db: adaptPostgresClient(native, run), close: () => sql.end() };
}
