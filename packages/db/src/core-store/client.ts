import { getTableName, is, sql, type SQLWrapper } from "drizzle-orm";
import { PgTable, type PgDialect } from "drizzle-orm/pg-core";
import { QueryPromise } from "drizzle-orm/query-promise";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
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
	// Per request: Hyperdrive owns pooling. Ordinary queries use node-postgres,
	// Cloudflare's recommended Hyperdrive driver, which sends a parameterized
	// query in one round trip; postgres.js 4 waited for a Describe first, two
	// round trips per query. It connects on first use, so a request that never
	// queries never takes a Hyperdrive slot.
	const stats = { queries: 0 };
	const connectionString = env.CORE_HYPERDRIVE.connectionString;
	const client = new LazyPgClient(connectionString, stats);
	const native = drizzle({ client, relations });
	// Atomic batches need several statements in one transaction. node-postgres
	// cannot pipeline them, so a multi-statement batch uses postgres.js, which
	// sends them as one extended-protocol batch with one Sync (one implicit
	// transaction), opened only when a request runs such a batch.
	let batchSql: ReturnType<typeof postgres> | undefined;
	const batchClient = () => {
		batchSql ??= postgres(connectionString, {
			prepare: false,
			fetch_types: false,
			max: 1,
			connect_timeout: 10,
			idle_timeout: 5,
		});
		// A parser, not a custom type: a custom serializer makes postgres.js
		// describe every statement first.
		batchSql.options.parsers[20] = Number;
		return batchSql;
	};
	const run: RunAtomicBatch = async (statements) => {
		if (statements.length === 1) {
			const [statement] = statements;
			const result = (await client.query({
				text: statement!.sql,
				values: statement!.params,
				rowMode: "array",
				types: RAW_TYPES,
			})) as pg.QueryResult<unknown[]>;
			return [
				{
					rows: result.rows as unknown[][],
					count: result.rowCount ?? 0,
					columns: result.fields.map((field: pg.FieldDef) => field.name),
				},
			];
		}
		stats.queries += statements.length;
		const sql = batchClient();
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
		close: async () => {
			await Promise.all([client.end(), batchSql?.end()]);
		},
		stats,
	};
}

// int8 as a JS number, as D1 returned it (pg defaults to a string). Global for
// this isolate's pg parsers, which Drizzle's node-postgres session falls back to.
pg.types.setTypeParser(20, Number);

/** Raw statements keep date and time values as stored text, as Drizzle does. */
const RAW_TYPES = {
	getTypeParser: ((typeId: number, format?: "text" | "binary") =>
		RAW_TEXT_TYPES.has(typeId)
			? (value: string) => value
			: pg.types.getTypeParser(
					typeId,
					format,
				)) as typeof pg.types.getTypeParser,
};
const RAW_TEXT_TYPES = new Set([
	1082, 1083, 1114, 1184, 1186, 1266, 1115, 1182, 1185, 1187, 1231,
]);

/** A pg Client that connects on its first query and counts statements. */
class LazyPgClient extends pg.Client {
	private connecting?: Promise<void>;
	constructor(
		connectionString: string,
		private readonly stats: { queries: number },
	) {
		super({ connectionString });
		// A dropped connection surfaces on the next query; an unheard 'error'
		// event would otherwise be an uncaught exception.
		this.on("error", () => undefined);
	}
	override query(...args: unknown[]): never {
		this.stats.queries++;
		const connecting = (this.connecting ??= super
			.connect()
			.then(() => undefined));
		return connecting.then(() =>
			(super.query as (...a: unknown[]) => Promise<unknown>).apply(this, args),
		) as never;
	}
	override async end(): Promise<void> {
		if (!this.connecting) return;
		await this.connecting.catch(() => undefined);
		await super.end();
	}
}
