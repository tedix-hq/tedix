/**
 * Production-faithful D1 test double.
 *
 * Backed by `node:sqlite`, but deliberately *stricter* than raw SQLite so that
 * a query which real D1 rejects also fails here. The rules it enforces are the
 * ones that have actually cost us production incidents:
 *
 * 1. **Explicit transaction control is rejected.** D1 refuses `BEGIN`, `COMMIT`,
 *    `ROLLBACK`, `SAVEPOINT`, and `RELEASE` with Cloudflare error 7500 —
 *    "To execute a transaction, please use the state.storage.transaction() ...
 *    APIs instead of the SQL BEGIN TRANSACTION or SAVEPOINT statements."
 *    Drizzle's D1 driver implements `db.transaction()` by emitting a literal
 *    `begin`, so `db.transaction()` throws against a real database while
 *    passing happily under a permissive in-memory double. `db.batch()` is D1's
 *    only transaction primitive. A `db.transaction()` call that reaches this
 *    facade fails exactly like production.
 *
 * 2. **The bound-parameter ceiling is enforced** when `maxBoundParams` is set.
 *    D1 caps bound parameters per statement (~100); exceeding it fails at
 *    runtime only, typically under a bulk insert that was fine in testing with
 *    two rows and broke with fifty.
 *
 * 3. **Duplicate output column names are rejected.** D1 returns one object per
 *    row, so two selected columns sharing a base name collapse into one and
 *    every later column decodes into the wrong field — silently. Nine queries
 *    in this package shipped with that defect; all of them had tests, and none
 *    of those tests could see it.
 *
 * Prefer this over a hand-rolled facade: a per-file double drifts toward
 * whatever makes the local test pass, which is how a `db.transaction()` call
 * reached production undetected.
 */

import { duplicateOutputColumns } from "./output-columns";

/**
 * The slice of `node:sqlite`'s `DatabaseSync` this facade drives.
 *
 * Declared structurally rather than imported so that this module — which sits
 * under `src/` and is type-checked with the Workers type set — does not pull
 * Node's type definitions into the package's build.
 */
export interface SyncSqliteDatabase {
	prepare(sql: string): {
		all(...params: unknown[]): unknown[];
		get(...params: unknown[]): unknown;
		run(...params: unknown[]): {
			changes: number | bigint;
			lastInsertRowid: number | bigint;
		};
	};
	exec(sql: string): void;
}

/** D1 rejects these outright; `db.batch()` is the transaction primitive. */
const EXPLICIT_TRANSACTION_CONTROL =
	/^\s*(begin|commit|rollback|savepoint|release)\b/i;

export interface D1FacadeOptions {
	/**
	 * Fail any statement bound with more than this many parameters, mirroring
	 * D1's per-statement ceiling. Defaults to 100. Pass `null` to disable when a
	 * test deliberately exercises a large statement.
	 */
	maxBoundParams?: number | null;

	/**
	 * Called with the SQL of every statement just before it is prepared.
	 *
	 * A seam for simulating concurrency: a test can write a competing row from
	 * inside this hook to land it precisely in the read-modify-write window of
	 * the query being prepared, which is the only way to exercise a CAS guard's
	 * losing branch. It observes and cannot relax any rule above — the
	 * transaction and bound-param checks still apply to every statement.
	 */
	onPrepare?: (query: string, db: SyncSqliteDatabase) => void;

	/**
	 * Reject any SELECT whose output column names are not unique. Defaults to
	 * true.
	 *
	 * D1 returns one object per row, so two selected columns sharing a base name
	 * collapse into one and every later column decodes into the wrong field.
	 * Checking it here means any query a test exercises is covered automatically,
	 * which is the point: the nine occurrences of this bug found in this package
	 * were all in queries that had tests, none of which could see the problem.
	 *
	 * Set false only for a test that deliberately builds a colliding query.
	 */
	rejectDuplicateOutputColumns?: boolean;
}

/**
 * Wrap a `node:sqlite` database as a `D1Database` that fails the way D1 fails.
 */
export function createD1Facade(
	db: SyncSqliteDatabase,
	options: D1FacadeOptions = {},
): D1Database {
	const maxBoundParams =
		options.maxBoundParams === undefined ? 100 : options.maxBoundParams;
	let batchQueue: Promise<void> = Promise.resolve();

	const wrap = (query: string) => {
		if (EXPLICIT_TRANSACTION_CONTROL.test(query)) {
			throw new Error(
				`D1_ERROR: explicit transaction statements are not allowed: ${query.trim()}. ` +
					"Use db.batch() — D1 wraps a batch in an implicit transaction. [code: 7500]",
			);
		}
		if (options.rejectDuplicateOutputColumns !== false) {
			const duplicates = duplicateOutputColumns(query);
			if (duplicates.length > 0) {
				throw new Error(
					`D1 hazard: query emits duplicate output column name(s): ${duplicates.join(", ")}.\n` +
						"D1 returns one object per row, so these collapse and every later column " +
						"decodes into the wrong field. Use prefixedColumns() from ../utils/select, " +
						"or the relational query builder, which aliases every column to its unique key.\n" +
						`SQL: ${query}`,
				);
			}
		}
		options.onPrepare?.(query, db);
		const statement = db.prepare(query);
		let bound: unknown[] = [];
		const prepared = {
			bind: (...values: unknown[]) => {
				if (maxBoundParams !== null && values.length > maxBoundParams) {
					throw new Error(
						`D1_ERROR: too many SQL variables (${values.length} > ${maxBoundParams}). ` +
							"Chunk the values — see chunkForBoundParams in ../utils/batch.",
					);
				}
				bound = values;
				return prepared;
			},
			all: async () => ({
				results: statement.all(...bound),
				success: true,
				meta: {},
			}),
			run: async () => {
				const result = statement.run(...bound);
				return {
					success: true,
					meta: {
						changes: Number(result.changes),
						last_row_id: Number(result.lastInsertRowid),
						duration: 0,
					},
				};
			},
			first: async (column?: string) => {
				const row = statement.get(...bound) as
					| Record<string, unknown>
					| undefined;
				return column ? (row?.[column] ?? null) : (row ?? null);
			},
			raw: async () =>
				(statement.all(...bound) as Array<Record<string, unknown>>).map(
					Object.values,
				),
		};
		return prepared;
	};

	// D1 executes a batch inside an implicit transaction: all statements land or
	// none do. This drives the underlying SQLite transaction directly rather than
	// through `wrap`, which is exactly the carve-out that makes `batch()` the
	// supported path and `transaction()` the unsupported one. Shared with the
	// session returned by `withSession` so both honour the same semantics.
	const facadeBatch = (statements: Array<{ all: () => Promise<unknown> }>) => {
		const run = batchQueue.then(async () => {
			db.exec("BEGIN");
			try {
				const results = [];
				for (const statement of statements) {
					results.push(await statement.all());
				}
				db.exec("COMMIT");
				return results;
			} catch (error) {
				db.exec("ROLLBACK");
				throw error;
			}
		});
		batchQueue = run.then(
			() => undefined,
			() => undefined,
		);
		return run;
	};

	return {
		prepare: wrap,
		batch: facadeBatch,
		exec: async (query: string) => {
			db.exec(query);
			return { count: 0, duration: 0 };
		},
		dump: async () => new ArrayBuffer(0),
		// Sessions, modelled to the extent a single SQLite file can: every query
		// still hits the one instance, which is exactly how real D1 behaves when
		// read replication is disabled. What this DOES model faithfully is the
		// API shape — the constraint or bookmark argument, and a bookmark that is
		// null until a query has run and monotonic afterwards — so session-scoped
		// code is exercised rather than merely typechecked. It cannot reproduce
		// replication lag; nothing running against one file can.
		withSession: (constraintOrBookmark?: string) => {
			let queries = 0;
			const session = {
				prepare: (query: string) => {
					queries += 1;
					return wrap(query);
				},
				batch: async (statements: Array<{ all: () => Promise<unknown> }>) => {
					queries += 1;
					return facadeBatch(statements);
				},
				getBookmark: () =>
					queries === 0
						? null
						: `${constraintOrBookmark ?? "first-unconstrained"}-${queries}`,
			};
			return session;
		},
	} as unknown as D1Database;
}
