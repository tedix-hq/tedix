import type {
	AgentMigration,
	AgentSqlResult,
	AgentSqlStatement,
	AgentSqlValue,
	AgentStorage,
} from "./index";

/**
 * The part of a Durable Object's storage this module needs, named locally so
 * the shape is explicit rather than inherited from the host's global types.
 */
export interface SqliteHost {
	readonly sql: {
		exec(
			sql: string,
			...params: AgentSqlValue[]
		): {
			toArray(): Record<string, AgentSqlValue>[];
			readonly rowsWritten: number;
		};
	};
	transactionSync<T>(callback: () => T): T;
}

const MIGRATIONS_TABLE = "agent_runtime_migrations";

/**
 * `AgentStorage` over a Durable Object's SQLite. The object is the single
 * writer by construction; `batch` uses the host's synchronous transaction so a
 * failing statement rolls the whole batch back.
 */
export class SqliteAgentStorage implements AgentStorage {
	constructor(
		readonly objectId: string,
		private readonly host: SqliteHost,
	) {
		host.sql.exec(
			`CREATE TABLE IF NOT EXISTS ${MIGRATIONS_TABLE} (` +
				"migration_name TEXT PRIMARY KEY, " +
				"applied_at INTEGER NOT NULL, " +
				"applied_order INTEGER NOT NULL)",
		);
	}

	async exec(
		sql: string,
		params: readonly AgentSqlValue[] = [],
	): Promise<AgentSqlResult> {
		const cursor = this.host.sql.exec(sql, ...params);
		// Reads need their rows consumed before `rowsWritten` is final.
		cursor.toArray();
		return { rowsWritten: cursor.rowsWritten };
	}

	async query<Row extends Record<string, AgentSqlValue>>(
		sql: string,
		params: readonly AgentSqlValue[] = [],
	): Promise<Row[]> {
		return this.host.sql.exec(sql, ...params).toArray() as Row[];
	}

	async batch(statements: readonly AgentSqlStatement[]): Promise<void> {
		this.host.transactionSync(() => {
			for (const statement of statements) {
				this.host.sql
					.exec(statement.sql, ...(statement.params ?? []))
					.toArray();
			}
		});
	}

	async appliedMigrations(): Promise<string[]> {
		return (
			this.host.sql
				.exec(
					`SELECT migration_name FROM ${MIGRATIONS_TABLE} ORDER BY applied_order ASC`,
				)
				.toArray() as { migration_name: string }[]
		).map((row) => row.migration_name);
	}

	async migrate(migrations: readonly AgentMigration[]): Promise<string[]> {
		const seen = new Set<string>();
		for (const migration of migrations) {
			if (seen.has(migration.name)) {
				throw new Error(`Migration ${migration.name} is listed twice`);
			}
			seen.add(migration.name);
		}
		const applied = await this.appliedMigrations();
		const appliedSet = new Set(applied);
		const pending = migrations.filter((m) => !appliedSet.has(m.name));
		if (pending.length === 0) return [];
		let order = applied.length;
		this.host.transactionSync(() => {
			for (const migration of pending) {
				for (const statement of migration.statements) {
					this.host.sql.exec(statement).toArray();
				}
				order += 1;
				this.host.sql
					.exec(
						`INSERT INTO ${MIGRATIONS_TABLE} (migration_name, applied_at, applied_order) VALUES (?, ?, ?)`,
						migration.name,
						Date.now(),
						order,
					)
					.toArray();
			}
		});
		return pending.map((m) => m.name);
	}
}
