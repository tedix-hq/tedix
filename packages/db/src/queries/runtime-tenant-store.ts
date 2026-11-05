import { createDbClient, type DbClient } from "../client";

type SqlValue = string | number | null | ArrayBuffer;

/** The local SQL surface inside the owning workspace Durable Object. */
export interface TenantRuntimeStorage {
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
 * Execute the canonical runtime query leaves against workspace-local SQLite.
 * Schema initialization belongs to the TenantStore migrate-on-wake owner.
 */
export function createTenantRuntimeClient(
	storage: TenantRuntimeStorage,
): DbClient {
	const executions = new WeakMap<object, () => D1Result>();
	const prepare = (query: string, bindings: SqlValue[] = []) => {
		const execute = () => {
			const cursor = storage.sql.exec(query, ...bindings);
			const columns = cursor.columnNames;
			if (new Set(columns).size !== columns.length)
				throw new Error("Duplicate output column in tenant runtime query");
			const rows = Array.from(cursor.raw());
			const results = rows.map((row) =>
				Object.fromEntries(
					columns.map((column, index) => [column, row[index]]),
				),
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
					throw new Error("Foreign statement in tenant runtime batch");
				return execute;
			});
			return storage.transactionSync(() => batch.map((execute) => execute()));
		},
	};
	return createDbClient(local as unknown as D1Database);
}

export type RuntimeStorageConfig =
	| { plane: "d1"; db: DbClient }
	| { plane: "tenant"; storage: TenantRuntimeStorage };

/** Select explicitly; binding presence must never move tenant data. */
export function selectRuntimeStore(config: RuntimeStorageConfig): DbClient {
	return config.plane === "tenant"
		? createTenantRuntimeClient(config.storage)
		: config.db;
}
