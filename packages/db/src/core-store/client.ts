import { getTableName, is, sql, type SQLWrapper } from "drizzle-orm";
import { PgTable, type PgDialect } from "drizzle-orm/pg-core";
import { QueryPromise } from "drizzle-orm/query-promise";
import { drizzle } from "drizzle-orm/postgres-js";
import { relations } from "../schema-pg/relations";
import postgres from "postgres";
import { createDbClient, type DbClient } from "../client";
import * as schema from "../schema-pg/core";
import { postgresBatch, type BatchResult, type RunAtomicBatch } from "./batch";
import { registerCoreStore } from "./dialect";

export interface CoreStoreEnv {
	/** "d1" (default) or "postgres"; a Worker var, so typed as string and checked here. */
	CORE_STORE?: string;
	DB?: D1Database;
	CORE_HYPERDRIVE?: Pick<Hyperdrive, "connectionString">;
}

const pgTables = new Map<string, Parameters<typeof getTableName>[0]>(
	Object.values(schema)
		.filter((table) => is(table, PgTable))
		.map((table) => [getTableName(table), table]),
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
/**
 * A second handle on the same Postgres client. Log-store reads mark the
 * "main" store they read, so it must not be the scope client itself.
 */
export function postgresClientView(db: DbClient): DbClient {
	const view = new Proxy(db, {});
	pgClients.add(view);
	registerCoreStore(view, "postgres");
	return view;
}
/** Bind native Pg builders to the shared query surface, with one atomic batch adapter.
 * Lanes must select coreTable() and replace SQLite SQL before enabling their query paths. */
export function adaptPostgresClient(
	native: object,
	run: RunAtomicBatch,
): DbClient {
	const dialect = (native as { dialect: PgDialect }).dialect;
	const raw = (
		query: SQLWrapper | string,
		method: "run" | "all" | "get" | "values",
		mode: "objects" | "arrays" = "objects",
	) => {
		const sequel = typeof query === "string" ? sql.raw(query) : query.getSQL();
		const built = dialect.sqlToQuery(sequel);
		const mapResult = (result: BatchResult) => {
			const rows =
				method === "values" || mode === "arrays"
					? result.rows
					: result.rows.map((row) =>
							Object.fromEntries(
								result.columns.map((name, i) => [name, row[i]]),
							),
						);
			if (method === "run")
				return {
					success: true,
					results: rows,
					meta: { changes: result.count },
				};
			return method === "get" ? rows[0] : rows;
		};
		return new PostgresRaw(sequel, built, mapResult, run);
	};
	Object.assign(native, {
		batch: postgresBatch(run),
		all: (query: SQLWrapper | string, mode?: "objects" | "arrays") =>
			raw(query, "all", mode),
		get: (query: SQLWrapper | string, mode?: "objects" | "arrays") =>
			raw(query, "get", mode),
		values: (query: SQLWrapper | string) => raw(query, "values"),
		run: (query: SQLWrapper | string) => raw(query, "run"),
	});
	pgClients.add(native);
	registerCoreStore(native, "postgres");
	return native as DbClient;
}

/** Awaiting executes a singleton batch; construction only compiles native Pg SQL. */
class PostgresRaw<T> extends QueryPromise<T> {
	constructor(
		private readonly sequel: ReturnType<SQLWrapper["getSQL"]>,
		private readonly query: { sql: string; params: unknown[] },
		private readonly mapResult: (result: BatchResult) => T,
		private readonly run: RunAtomicBatch,
	) {
		super();
	}
	getSQL() {
		return this.sequel;
	}
	getQuery() {
		return this.query;
	}
	_prepare() {
		return {
			getQuery: () => this.query,
			mapResult: this.mapResult,
			mode: "arrays",
		};
	}
	async execute(): Promise<T> {
		const [result] = await this.run([this.query]);
		if (!result) throw new Error("Postgres raw result missing");
		return this.mapResult(result);
	}
}
export function createCoreStore(env: CoreStoreEnv): {
	db: DbClient;
	close(): Promise<void>;
	/** Statement count, Postgres only. */
	stats?: { queries: number };
} {
	if (!env.CORE_STORE || env.CORE_STORE === "d1")
		return {
			// Preserve the D1 factory's first-use failure for a missing binding.
			db: createDbClient(env.DB as D1Database),
			close: async () => {},
		};
	if (env.CORE_STORE !== "postgres") throw new Error("Unknown CORE_STORE");
	if (!env.CORE_HYPERDRIVE)
		throw new Error("CORE_STORE=postgres requires CORE_HYPERDRIVE");
	// Per request. Hyperdrive owns pooling. Use Cloudflare's recommended per-request connection limit.
	// Unnamed statements: Hyperdrive reuses pooled server connections across
	// clients, so postgres.js named prepared statements collided ("prepared
	// statement already exists") under production load.
	const stats = { queries: 0 };
	const sql = postgres(env.CORE_HYPERDRIVE.connectionString, {
		prepare: false,
		fetch_types: false,
		// postgres.js pipelines parallel queries on one connection, and each
		// connection costs ~128 KB of a 128 MB isolate.
		max: 2,
		// Fail fast when Hyperdrive has no slot, and let idle connections go
		// so a finished request stops holding one.
		connect_timeout: 10,
		idle_timeout: 5,
		// Counts statements so a scope can report its query load.
		debug: () => {
			stats.queries++;
		},
	});
	// int8 as a JS number, as D1 returned it; postgres.js defaults to a string,
	// which broke counts and bigint reads through D1 table definitions. Set as
	// a parser, not a custom type: any custom serializer makes postgres.js
	// describe every query first, an extra round trip per query.
	sql.options.parsers[20] = Number;
	const native = drizzle({ client: sql, relations });
	const run: RunAtomicBatch = async (statements) => {
		// postgres.js 4 sends one extended-protocol batch with one Sync.
		// PostgreSQL commits it as one implicit transaction, or rolls it all back.
		const queries = statements.map((statement) => {
			const query = sql.unsafe(
				statement.sql,
				statement.params as postgres.ParameterOrJSON<never>[],
				{ prepare: false },
			);
			query.values();
			return query;
		});
		const results = await sql.batch(queries);
		return results.map((result) => ({
			rows: result as unknown as unknown[][],
			count: result.count,
			columns: result.columns.map((column) => column.name),
		}));
	};
	return {
		db: adaptPostgresClient(native, run),
		close: () => sql.end(),
		stats,
	};
}
