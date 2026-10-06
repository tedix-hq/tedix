import { env } from "cloudflare:workers";
import { kyselyLogOption, recordRpc } from "emdash/database/instrumentation";
import type {
	CollectionDeletionGuardInput,
	CollectionDeletionGuardResult,
} from "emdash";
import type {
	CompiledQuery,
	DatabaseConnection,
	DatabaseIntrospector,
	Driver,
	QueryResult,
	SchemaMetadata,
	TableMetadata,
} from "kysely";
import {
	type Dialect,
	Kysely,
	SqliteAdapter,
	SqliteQueryCompiler,
	sql,
} from "kysely";

const DEFAULT_BOOKMARK_COOKIE = "__em_do_bookmark";
const MAX_BOOKMARK_LENGTH = 1024;
const READ_STATEMENT_PATTERN = /^\s*(?:select|pragma|explain|with)\b/i;
const SELECT_PATTERN = /^select\b/i;
const DEFAULT_MIGRATION_TABLE = "kysely_migration";
const DEFAULT_MIGRATION_LOCK_TABLE = "kysely_migration_lock";
const SPLIT_PARENS_PATTERN = /[(),]/;
const WHITESPACE_PATTERN = /\s+/;
const QUOTES_PATTERN = /["`]/g;
const DEFAULT_DO_NAME = "default";

interface DoQueryResult {
	rows: Record<string, unknown>[];
	changes?: number;
	bookmark?: string;
}

interface DoQueryStatement {
	sql: string;
	params?: unknown[];
}

interface EmDashDBStub {
	executeCollectionDeletionGuard(
		input: CollectionDeletionGuardInput,
	): Promise<CollectionDeletionGuardResult>;
	query(
		sql: string,
		params?: unknown[],
		opts?: { bookmark?: string },
	): Promise<DoQueryResult>;
	batchQuery(
		statements: DoQueryStatement[],
		opts?: { bookmark?: string },
	): Promise<DoQueryResult[]>;
}

interface DurableObjectsConfig {
	binding: string;
	name?: string;
	session?: "disabled" | "auto";
	bookmarkCookie?: string;
}

interface CookieJar {
	get(name: string): { value: string } | undefined;
	set(name: string, value: string, options: Record<string, unknown>): void;
}

export interface RequestScopedDbOpts {
	config: DurableObjectsConfig;
	isAuthenticated: boolean;
	isWrite: boolean;
	cookies: CookieJar;
	url: URL;
}

export interface RequestScopedDb {
	db: Kysely<any>;
	commit: () => void;
}

interface BookmarkSink {
	latest?: string;
}

// Keep the singleton and cold-start dialects on the same read-after-write
// bookmark, even when Vite duplicates this module across SSR chunks.
const SINGLETON_BOOKMARK_SINKS_KEY = Symbol.for(
	"emdash:do-singleton-bookmark-sinks",
);
const globalSymbols = globalThis as Record<symbol, unknown>;
const singletonBookmarkSinks =
	(globalSymbols[SINGLETON_BOOKMARK_SINKS_KEY] as
		| Map<string, BookmarkSink>
		| undefined) ??
	(() => {
		const sinks = new Map<string, BookmarkSink>();
		globalSymbols[SINGLETON_BOOKMARK_SINKS_KEY] = sinks;
		return sinks;
	})();

function getSingletonBookmarkSink(config: DurableObjectsConfig): BookmarkSink {
	const key = `${config.binding}:${config.name ?? DEFAULT_DO_NAME}`;
	let sink = singletonBookmarkSinks.get(key);
	if (!sink) {
		sink = {};
		singletonBookmarkSinks.set(key, sink);
	}
	return sink;
}

interface DoSqlDialectConfig {
	resolveStub: () => EmDashDBStub;
	readBookmark?: string;
	bookmarkSink?: BookmarkSink;
	onRpc?: () => void;
}

function isReadStatement(sqlText: string): boolean {
	return READ_STATEMENT_PATTERN.test(sqlText);
}

function getBinding(config: DurableObjectsConfig): EmDashDBStub {
	const binding = (env as Record<string, unknown>)[config.binding];
	if (
		binding &&
		typeof (binding as EmDashDBStub).query === "function" &&
		typeof (binding as EmDashDBStub).batchQuery === "function"
	) {
		return binding as EmDashDBStub;
	}
	throw new Error(
		`Worker Loader DO binding "${config.binding}" is not an EmDashDB RPC stub`,
	);
}

function hasControlChars(value: string): boolean {
	for (let i = 0; i < value.length; i++) {
		const code = value.charCodeAt(i);
		if (code < 0x20 || code === 0x7f) return true;
	}
	return false;
}

class D1Introspector implements DatabaseIntrospector {
	constructor(private readonly db: any) {}

	async getSchemas(): Promise<SchemaMetadata[]> {
		return [];
	}

	async getTables(
		options: { withInternalKyselyTables?: boolean } = {},
	): Promise<TableMetadata[]> {
		let query = this.db
			.selectFrom("sqlite_master")
			.where("type", "in", ["table", "view"])
			.where("name", "not like", "sqlite_%")
			.where("name", "not like", "_cf_%")
			.select(["name", "sql", "type"])
			.orderBy("name");

		if (!options.withInternalKyselyTables) {
			query = query
				.where("name", "!=", DEFAULT_MIGRATION_TABLE)
				.where("name", "!=", DEFAULT_MIGRATION_LOCK_TABLE);
		}

		const tables = await query.execute();
		const result: TableMetadata[] = [];

		for (const table of tables) {
			const tableName = table.name as string;
			const tableType = table.type as string;
			const tableSql = table.sql as string | null;
			const columns = await sql<{
				cid: number;
				name: string;
				type: string;
				notnull: number;
				dflt_value: string | null;
				pk: number;
			}>`SELECT * FROM pragma_table_info('${sql.raw(tableName)}')`.execute(
				this.db,
			);

			let autoIncrementCol = tableSql
				?.split(SPLIT_PARENS_PATTERN)
				?.find((it) => it.toLowerCase().includes("autoincrement"))
				?.trimStart()
				?.split(WHITESPACE_PATTERN)?.[0]
				?.replace(QUOTES_PATTERN, "");

			if (!autoIncrementCol) {
				const pkCols = columns.rows.filter((row) => row.pk > 0);
				if (
					pkCols.length === 1 &&
					pkCols[0]!.type.toLowerCase() === "integer"
				) {
					autoIncrementCol = pkCols[0]!.name;
				}
			}

			result.push({
				name: tableName,
				isView: tableType === "view",
				isForeign: false,
				columns: columns.rows.map((column) => ({
					name: column.name,
					dataType: column.type,
					isNullable: !column.notnull,
					isAutoIncrementing: column.name === autoIncrementCol,
					hasDefaultValue: column.dflt_value != null,
					comment: undefined,
				})),
			});
		}

		return result;
	}
}

class DoSqlDialect implements Dialect {
	constructor(private readonly config: DoSqlDialectConfig) {}

	createAdapter(): SqliteAdapter {
		return new DoSqlAdapter();
	}

	createDriver(): Driver {
		return new DoSqlDriver(this.config);
	}

	createQueryCompiler(): SqliteQueryCompiler {
		return new SqliteQueryCompiler();
	}

	createIntrospector(db: Kysely<any>): DatabaseIntrospector {
		return new D1Introspector(db);
	}
}

class DoSqlAdapter extends SqliteAdapter {
	readonly supportsTransactions = false;
}

class DoSqlDriver implements Driver {
	constructor(private readonly config: DoSqlDialectConfig) {}

	async init(): Promise<void> {}

	async acquireConnection(): Promise<DatabaseConnection> {
		return new DoSqlConnection(this.config.resolveStub(), this.config);
	}

	async beginTransaction(): Promise<void> {
		throw new Error("Transactions are not supported");
	}

	async commitTransaction(): Promise<void> {
		throw new Error("Transactions are not supported");
	}

	async rollbackTransaction(): Promise<void> {
		throw new Error("Transactions are not supported");
	}

	async releaseConnection(): Promise<void> {}

	async destroy(): Promise<void> {}
}

class DoSqlConnection implements DatabaseConnection {
	constructor(
		private readonly stub: EmDashDBStub,
		private readonly config: DoSqlDialectConfig,
	) {}

	async executeQuery<O>(compiledQuery: CompiledQuery): Promise<QueryResult<O>> {
		const sqlText = compiledQuery.sql;
		const params = compiledQuery.parameters as unknown[];
		let opts: { bookmark: string } | undefined;
		if (isReadStatement(sqlText)) {
			const bookmark =
				this.config.bookmarkSink?.latest ?? this.config.readBookmark;
			if (bookmark) opts = { bookmark };
		}

		this.config.onRpc?.();
		const result = await this.stub.query(sqlText, params, opts);
		if (result.bookmark && this.config.bookmarkSink) {
			this.config.bookmarkSink.latest = result.bookmark;
		}

		return {
			rows: result.rows as O[],
			numAffectedRows:
				result.changes !== undefined ? BigInt(result.changes) : undefined,
		};
	}

	// Kysely requires an async iterator for drivers that support streaming; this adapter rejects it.
	async *streamQuery<O>(): AsyncIterableIterator<QueryResult<O>> {
		throw new Error("DO SQL dialect does not support streaming");
	}
}

interface PendingQuery {
	sql: string;
	params: unknown[];
	resolve: (result: QueryResult<any>) => void;
	reject: (error: unknown) => void;
}

class CoalescingDoSqlConnection implements DatabaseConnection {
	private static readonly FLUSH_RECLAIM_MS = 1_000;
	private buffer: PendingQuery[] = [];
	private flushScheduled = false;
	private flushDeadline = 0;
	private opChain: Promise<unknown> = Promise.resolve();

	constructor(
		private readonly stub: EmDashDBStub,
		private readonly config: DoSqlDialectConfig,
	) {}

	private effectiveBookmark(): string | undefined {
		return this.config.bookmarkSink?.latest ?? this.config.readBookmark;
	}

	private enqueue<T>(op: () => Promise<T>): Promise<T> {
		const run = this.opChain.then(op, op);
		this.opChain = run.then(
			() => undefined,
			() => undefined,
		);
		return run;
	}

	private async single<R>(
		sqlText: string,
		params: unknown[],
	): Promise<QueryResult<R>> {
		const bookmark = isReadStatement(sqlText)
			? this.effectiveBookmark()
			: undefined;
		this.config.onRpc?.();
		const result = await this.stub.query(
			sqlText,
			params,
			bookmark ? { bookmark } : undefined,
		);
		if (result.bookmark && this.config.bookmarkSink) {
			this.config.bookmarkSink.latest = result.bookmark;
		}
		return {
			rows: result.rows as R[],
			numAffectedRows:
				result.changes !== undefined ? BigInt(result.changes) : undefined,
		};
	}

	async executeQuery<R>(compiledQuery: CompiledQuery): Promise<QueryResult<R>> {
		const params = compiledQuery.parameters as unknown[];
		if (!SELECT_PATTERN.test(compiledQuery.sql.trimStart())) {
			return this.enqueue(() => this.single<R>(compiledQuery.sql, params));
		}

		return new Promise<QueryResult<R>>((resolve, reject) => {
			this.buffer.push({ sql: compiledQuery.sql, params, resolve, reject });
			this.scheduleFlush();
		});
	}

	private scheduleFlush(): void {
		if (this.flushScheduled) {
			this.reclaimStrandedFlush();
			if (this.flushScheduled) return;
		}
		this.flushScheduled = true;
		this.flushDeadline =
			Date.now() + CoalescingDoSqlConnection.FLUSH_RECLAIM_MS;
		setTimeout(() => {
			void this.flush();
		}, 0);
	}

	private reclaimStrandedFlush(): void {
		if (this.flushScheduled && Date.now() > this.flushDeadline) {
			this.flushScheduled = false;
		}
	}

	private async flush(): Promise<void> {
		this.flushScheduled = false;
		const pending = this.buffer.splice(0, this.buffer.length);
		if (pending.length === 0) return;

		await this.enqueue(async () => {
			const first = pending[0];
			if (pending.length === 1 && first) {
				try {
					first.resolve(await this.single(first.sql, first.params));
				} catch (error) {
					first.reject(error);
				}
				return;
			}

			const bookmark = this.effectiveBookmark();
			let results: DoQueryResult[];
			try {
				this.config.onRpc?.();
				results = await this.stub.batchQuery(
					pending.map((item) => ({ sql: item.sql, params: item.params })),
					bookmark ? { bookmark } : undefined,
				);
			} catch {
				for (const item of pending) {
					try {
						item.resolve(await this.single(item.sql, item.params));
					} catch (error) {
						item.reject(error);
					}
				}
				return;
			}

			for (let index = 0; index < pending.length; index++) {
				const entry = pending[index];
				if (!entry) continue;
				const result = results[index];
				if (!result) {
					entry.reject(
						new Error(
							`DO batchQuery returned no result for statement ${index}: ${entry.sql}`,
						),
					);
					continue;
				}
				entry.resolve({
					rows: result.rows as unknown[],
					numAffectedRows: undefined,
				});
			}
		});
	}

	// Kysely requires an async iterator for drivers that support streaming; this adapter rejects it.
	async *streamQuery<R>(): AsyncIterableIterator<QueryResult<R>> {
		throw new Error("DO SQL dialect does not support streaming");
	}
}

class CoalescingDoSqlDriver implements Driver {
	private connection: CoalescingDoSqlConnection | undefined;

	constructor(private readonly config: DoSqlDialectConfig) {}

	async init(): Promise<void> {}

	async acquireConnection(): Promise<DatabaseConnection> {
		this.connection ??= new CoalescingDoSqlConnection(
			this.config.resolveStub(),
			this.config,
		);
		return this.connection;
	}

	async beginTransaction(): Promise<void> {
		throw new Error("Transactions are not supported");
	}

	async commitTransaction(): Promise<void> {
		throw new Error("Transactions are not supported");
	}

	async rollbackTransaction(): Promise<void> {
		throw new Error("Transactions are not supported");
	}

	async releaseConnection(): Promise<void> {}

	async destroy(): Promise<void> {}
}

class CoalescingDoSqlAdapter extends DoSqlAdapter {
	override get supportsMultipleConnections(): boolean {
		return true;
	}
}

class CoalescingDoSqlDialect implements Dialect {
	constructor(private readonly config: DoSqlDialectConfig) {}

	createAdapter(): SqliteAdapter {
		return new CoalescingDoSqlAdapter();
	}

	createDriver(): Driver {
		return new CoalescingDoSqlDriver(this.config);
	}

	createQueryCompiler(): SqliteQueryCompiler {
		return new SqliteQueryCompiler();
	}

	createIntrospector(db: Kysely<any>): DatabaseIntrospector {
		return new D1Introspector(db);
	}
}

export function createDialect(config: DurableObjectsConfig): Dialect {
	return new DoSqlDialect({
		resolveStub: () => getBinding(config),
		bookmarkSink: getSingletonBookmarkSink(config),
		onRpc: recordRpc,
	});
}

export function executeCollectionDeletionGuard(
	config: DurableObjectsConfig,
	input: CollectionDeletionGuardInput,
): Promise<CollectionDeletionGuardResult> {
	return getBinding(config).executeCollectionDeletionGuard(input);
}

export function createCoalescingDialect(config: DurableObjectsConfig): Dialect {
	return new CoalescingDoSqlDialect({
		resolveStub: () => getBinding(config),
		bookmarkSink: getSingletonBookmarkSink(config),
		onRpc: recordRpc,
	});
}

export function createRequestScopedDb(
	opts: RequestScopedDbOpts,
): RequestScopedDb | null {
	if (opts.config?.session !== "auto") return null;
	const cookieName = opts.config.bookmarkCookie ?? DEFAULT_BOOKMARK_COOKIE;
	let readBookmark: string | undefined;
	if (opts.isAuthenticated) {
		const bookmark = opts.cookies.get(cookieName)?.value;
		if (
			bookmark &&
			bookmark.length > 0 &&
			bookmark.length <= MAX_BOOKMARK_LENGTH &&
			!hasControlChars(bookmark)
		) {
			readBookmark = bookmark;
		}
	}

	let stub: EmDashDBStub | undefined;
	const bookmarkSink: BookmarkSink = {};
	const db = new Kysely<any>({
		dialect: new CoalescingDoSqlDialect({
			resolveStub: () => (stub ??= getBinding(opts.config)),
			readBookmark,
			bookmarkSink,
			onRpc: recordRpc,
		}),
		log: kyselyLogOption(),
	});

	return {
		db,
		commit() {
			if (!opts.isAuthenticated) return;
			const newBookmark = bookmarkSink.latest;
			if (!newBookmark || newBookmark.length > MAX_BOOKMARK_LENGTH) return;
			opts.cookies.set(cookieName, newBookmark, {
				path: "/",
				httpOnly: true,
				sameSite: "lax",
				secure: opts.url.protocol === "https:",
				maxAge: 60 * 60 * 24,
			});
		},
	};
}
