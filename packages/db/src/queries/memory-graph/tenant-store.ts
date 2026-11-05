import { createDbClient, type DbClient } from "../../client";

type SqlValue = string | number | null | ArrayBuffer;

/** The local SQL surface inside the owning workspace Durable Object. */
export interface TenantMemoryStorage {
	sql: {
		exec(
			query: string,
			...bindings: SqlValue[]
		): {
			columnNames: string[];
			raw(): IterableIterator<SqlValue[]>;
			rowsRead: number;
			rowsWritten: number;
		};
	};
	transactionSync<T>(callback: () => T): T;
}

/**
 * Execute the canonical memory query leaves locally, including Relations v2,
 * FTS5, citations and audit. This bridge has no remote D1 binding or fallback.
 * Schema initialization belongs to the TenantStore migrate-on-wake owner.
 */
export function createTenantMemoryClient(
	storage: TenantMemoryStorage,
): DbClient {
	const executions = new WeakMap<object, () => D1Result>();
	const prepare = (query: string, bindings: SqlValue[] = []) => {
		const execute = () => {
			const cursor = storage.sql.exec(query, ...bindings);
			const columns = cursor.columnNames;
			if (new Set(columns).size !== columns.length)
				throw new Error("Duplicate output column in tenant memory query");
			const rows = Array.from(cursor.raw());
			const results = rows.map((row) =>
				Object.fromEntries(columns.map((column, i) => [column, row[i]])),
			);
			const changes = storage.sql.exec("SELECT changes(), last_insert_rowid()");
			const [changed = 0, rowId = 0] = Array.from(changes.raw())[0] ?? [];
			return {
				results,
				success: true as const,
				meta: {
					changes: Number(changed),
					last_row_id: Number(rowId),
					rows_read: cursor.rowsRead,
					rows_written: cursor.rowsWritten,
				},
			};
		};
		const statement = {
			bind: (...values: SqlValue[]) => prepare(query, values),
			all: async () => execute(),
			run: async () => execute(),
			first: async (column?: string) => {
				const row = execute().results[0];
				return column ? (row?.[column] ?? null) : (row ?? null);
			},
			raw: async (options?: { columnNames?: boolean }) => {
				const cursor = storage.sql.exec(query, ...bindings);
				const rows = Array.from(cursor.raw());
				return options?.columnNames ? [cursor.columnNames, ...rows] : rows;
			},
		};
		executions.set(statement, execute as () => D1Result);
		return statement;
	};
	const local = {
		prepare,
		batch: async (statements: object[]) => {
			const batch = statements.map((statement) => {
				const execute = executions.get(statement);
				if (!execute)
					throw new Error("Foreign statement in tenant memory batch");
				return execute;
			});
			// No awaits inside the transaction: every statement commits or rolls back.
			return storage.transactionSync(() => batch.map((execute) => execute()));
		},
	};
	// Drizzle's D1 driver only uses prepare/batch. All execution stays on local
	// durable SQLite; the unused D1 administration/session methods are absent.
	return createDbClient(local as unknown as D1Database);
}

export type MemoryStorageConfig =
	| { plane: "platform-d1"; db: DbClient }
	| { plane: "do-local-sqlite"; storage: TenantMemoryStorage };

/** Call inside the authorized workspace store; never select by binding presence. */
export function selectMemoryStore(config: MemoryStorageConfig) {
	const db =
		config.plane === "do-local-sqlite"
			? createTenantMemoryClient(config.storage)
			: config.db;
	return { db, auditDb: db.$client };
}
