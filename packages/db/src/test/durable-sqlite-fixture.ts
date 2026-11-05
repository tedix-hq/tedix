/**
 * Durable Object SQLite test double.
 *
 * Wraps a `node:sqlite` database in the `DurableObjectStorage` surface
 * `drizzle-orm/durable-sqlite` actually touches: `storage.sql.exec` returning
 * a `SqlStorageCursor`, and `storage.transactionSync` wrapping the callback
 * in BEGIN/COMMIT/ROLLBACK. Rows are materialized eagerly; for a test double
 * that is exact, not lazy.
 *
 * It deliberately does not emulate input gating or output gates: DO SQLite
 * executes synchronously on the isolate's single thread, and the real
 * transaction primitive is what `transactionSync` supplies. What this double
 * proves is that the tenant-store query leaves issue the same statements and
 * make the same read/write decisions against a DO-shaped client as the D1
 * variants do against `createD1Facade` — the parity the sibling `.test.ts`
 * files assert.
 */

import type { SyncSqliteDatabase } from "./d1-facade";

/** Structural slice of `SqlStorageCursor` the fixture produces. */
class FixtureSqlCursor {
	private index = 0;
	private arrays: SqlStorageValue[][] | undefined;
	readonly columnNames: string[];
	readonly rowsRead: number;
	readonly rowsWritten: number;
	private readonly rows: Record<string, SqlStorageValue>[];

	constructor(
		rows: Record<string, SqlStorageValue>[],
		stats: { rowsRead: number; rowsWritten: number },
	) {
		this.rows = rows;
		this.columnNames = rows[0] ? Object.keys(rows[0]) : [];
		this.rowsRead = stats.rowsRead;
		this.rowsWritten = stats.rowsWritten;
	}

	private asArrayCursor(): FixtureSqlCursor {
		const cursor = new FixtureSqlCursor(this.rows, {
			rowsRead: this.rowsRead,
			rowsWritten: this.rowsWritten,
		});
		cursor.arrays = this.rows.map((row) =>
			Object.keys(row).map((key) => row[key]!),
		);
		return cursor;
	}

	raw(): FixtureSqlCursor {
		return this.asArrayCursor();
	}

	next(): IteratorResult<unknown> {
		const source = this.arrays ?? this.rows;
		const value = source[this.index++];
		return value === undefined
			? { done: true, value: undefined }
			: { done: false, value };
	}

	toArray(): unknown[] {
		return [...(this.arrays ?? this.rows)];
	}

	one(): unknown {
		const rows = this.arrays ?? this.rows;
		if (rows.length !== 1) {
			throw new Error(`Expected exactly one row, found ${rows.length}.`);
		}
		return rows[0];
	}

	*[Symbol.iterator](): Iterator<unknown> {
		yield* (this.arrays ?? this.rows) as Iterable<unknown>;
	}
}

function normalizeParam(value: unknown): SqlStorageValue {
	if (value === undefined || value === null) return null;
	if (value instanceof Uint8Array) {
		return value.buffer.slice(
			value.byteOffset,
			value.byteOffset + value.byteLength,
		) as ArrayBuffer;
	}
	if (value instanceof ArrayBuffer) return value;
	// node:sqlite binds neither booleans nor bigints; DO SQLite takes them as
	// 0/1 and numbers.
	if (typeof value === "boolean") return value ? 1 : 0;
	if (typeof value === "bigint") return Number(value);
	if (typeof value === "string" || typeof value === "number") return value;
	return String(value);
}

/**
 * Wrap a `node:sqlite` database as the `DurableObjectStorage` slice
 * `drizzle-orm/durable-sqlite` drives. Returns it typed so callers can hand it
 * straight to `createTenantStoreDb`.
 */
export function createDurableSqliteFixture(
	db: SyncSqliteDatabase,
): DurableObjectStorage {
	const storage = {
		sql: {
			exec: (query: string, ...params: unknown[]) => {
				const statement = db.prepare(query);
				const bound = params.map(normalizeParam);
				// Distinguish reads from writes by running .all() first and falling
				// back to .run(): node:sqlite's all() on a write returns no rows and
				// discards the change count, so probing is not an option. Instead the
				// first keyword decides; RETURNING still lands in the write branch
				// and must surface rows, so those go through all() on a prepared
				// SELECT-shaped plan by statement kind.
				const verb = query.trimStart().split(/\s+/, 1)[0]!.toUpperCase();
				if (
					verb === "SELECT" ||
					verb === "WITH" ||
					/\bRETURNING\b/i.test(query)
				) {
					const rows = statement.all(...bound) as Record<
						string,
						SqlStorageValue
					>[];
					return new FixtureSqlCursor(rows, {
						rowsRead: rows.length,
						rowsWritten: 0,
					});
				}
				const result = statement.run(...bound);
				return new FixtureSqlCursor([], {
					rowsRead: 0,
					rowsWritten: Number(result.changes),
				});
			},
		},
		transactionSync: <T>(fn: () => T): T => {
			db.exec("BEGIN");
			try {
				const result = fn();
				db.exec("COMMIT");
				return result;
			} catch (error) {
				db.exec("ROLLBACK");
				throw error;
			}
		},
	};
	return storage as unknown as DurableObjectStorage;
}
