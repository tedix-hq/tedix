/**
 * Where rows land: one workspace object per workspace.
 *
 * Two implementations share one interface. `LocalWorkspaceStore` is a SQLite
 * file carrying the workspace object's own migration chain, used by tests and
 * by `rehearse` on a copy. `RemoteWorkspaceStore` talks to the deployed
 * worker that hosts the objects over three small HTTP routes (see README,
 * "Remote protocol"); the object applies each batch through its own
 * `importRows`, so idempotency and scope checks are the object's.
 */
import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import {
	fromWire,
	rowKey,
	splitSqlStatements,
	toWire,
	type StoredRow,
	type WireRow,
} from "./rows";
import { hasTable, type WorkspaceRef } from "./source";
import { REQUIRED_JURISDICTION, WORKSPACE_TABLES, mappingFor } from "./tables";

/** Rows per import call; matches the object's own ceiling. */
export const IMPORT_CHUNK_ROWS = 1000;

export interface StoreDescription extends WorkspaceRef {
	createdAt: string;
	migrations: string[];
	outputAuthority?: "object" | "shared" | "unresolved";
	importGeneration?: number;
	/** Where the object lives; the reconciler requires `eu`. */
	jurisdiction: string | null;
}

export interface ImportBatch {
	batchId: string;
	table: string;
	rows: StoredRow[];
}

export interface ImportReceipt {
	batchId: string;
	table: string;
	rowCount: number;
	status: "imported" | "duplicate";
}

export interface DeltaBatch {
	batchId: string;
	table: string;
	importGeneration: number;
	freezeRef: string;
	changes: Array<{ before: StoredRow | null; after: StoredRow | null }>;
}
export interface DeltaReceipt extends ImportReceipt {
	importGeneration: number;
}

export interface WorkspaceStore {
	describe(): Promise<StoreDescription>;
	applyDelta?(batch: DeltaBatch): Promise<DeltaReceipt>;
	importRows(batch: ImportBatch): Promise<ImportReceipt>;
	/** Every row of a table, page by page; `after` is the cursor the previous page returned. */
	readRows(
		table: string,
		after: string | null,
		limit: number,
	): Promise<{
		rows: StoredRow[];
		next: string | null;
	}>;
	activate?(input: {
		importGeneration: number;
		reconciliationRef: string;
	}): Promise<unknown>;
	close(): Promise<void>;
}

/** Opens the store for one workspace; the caller closes it. */
export interface WorkspaceStoreFactory {
	open(ref: WorkspaceRef): Promise<WorkspaceStore>;
	readonly kind: "local" | "remote";
}

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const TENANT_STORE_MIGRATIONS = join(
	REPO_ROOT,
	"packages/db/tenant-store-drizzle",
);

/** The workspace object's migration chain, in apply order. */
export function readTenantStoreMigrations(
	dir: string = TENANT_STORE_MIGRATIONS,
): Array<{ name: string; sql: string }> {
	return readdirSync(dir)
		.filter((name) => /^\d{14}_/.test(name))
		.sort()
		.map((name) => ({
			name,
			sql: readFileSync(join(dir, name, "migration.sql"), "utf8"),
		}));
}

type Migration = { name: string; sql: string };

/** Applies each migration not yet recorded, one transaction per migration. */
function applyMigrations(db: DatabaseSync, migrations: Migration[]): void {
	db.exec(
		"CREATE TABLE IF NOT EXISTS __drizzle_migrations (id INTEGER PRIMARY KEY, hash TEXT NOT NULL, created_at INTEGER)",
	);
	const applied = new Set(
		db
			.prepare("SELECT hash FROM __drizzle_migrations")
			.all()
			.map((row) => String(row.hash)),
	);
	for (const { name, sql } of migrations) {
		if (applied.has(name)) continue;
		db.exec("BEGIN");
		for (const statement of splitSqlStatements(sql)) db.exec(statement);
		db.prepare(
			"INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)",
		).run(name, Date.now());
		db.exec("COMMIT");
	}
}

// Replaying the chain into a file pays one synced commit per migration for
// every new object (about 300 ms each, far more under disk contention). A new
// object instead starts from the same chain replayed once in memory.
const migratedImages = new Map<string, Uint8Array>();

function migratedImage(migrations: Migration[]): Uint8Array {
	const key = JSON.stringify(migrations);
	let image = migratedImages.get(key);
	if (!image) {
		const db = new DatabaseSync(":memory:");
		try {
			db.exec("PRAGMA foreign_keys = OFF");
			applyMigrations(db, migrations);
			image = db.serialize();
		} finally {
			db.close();
		}
		migratedImages.set(key, image);
	}
	return image;
}

/**
 * A SQLite file shaped like one workspace object. Applies the object's
 * migration chain; a mapped table the chain does not create yet is created
 * from `fallbackDdl` (the snapshot's own definition) so rehearsals run before
 * every port has landed. The reconciler reports which tables used the fallback.
 */
export class LocalWorkspaceStore implements WorkspaceStore {
	readonly db: DatabaseSync;
	readonly fallbackTables: string[] = [];
	readonly #ref: WorkspaceRef;
	readonly #jurisdiction: string | null;

	constructor(
		path: string,
		ref: WorkspaceRef,
		options: {
			jurisdiction?: string | null;
			fallbackDdl?: (table: string) => string | null;
			migrations?: Migration[];
		} = {},
	) {
		const migrations = options.migrations ?? readTenantStoreMigrations();
		if (path !== ":memory:") {
			mkdirSync(dirname(path), { recursive: true });
			// "wx" never overwrites an object another opener created first.
			if (!existsSync(path))
				writeFileSync(path, migratedImage(migrations), { flag: "wx" });
		}
		this.db = new DatabaseSync(path);
		// Rows arrive in chunks and tables shaped from the snapshot still name
		// core tables the object does not hold; the object itself has no
		// cross-table constraints to the core either.
		this.db.exec("PRAGMA foreign_keys = OFF");
		this.#ref = ref;
		this.#jurisdiction =
			options.jurisdiction === undefined
				? REQUIRED_JURISDICTION
				: options.jurisdiction;
		// An existing object still gets any migration it lacks.
		applyMigrations(this.db, migrations);
		for (const mapping of WORKSPACE_TABLES) {
			if (hasTable(this.db, mapping.table)) continue;
			const ddl = options.fallbackDdl?.(mapping.table);
			if (!ddl) continue;
			this.db.exec(ddl);
			this.fallbackTables.push(mapping.table);
		}
		if (
			this.db
				.prepare("SELECT 1 AS x FROM tenant_store_identity WHERE slot = 1")
				.get() === undefined
		) {
			this.db
				.prepare(
					"INSERT INTO tenant_store_identity (slot, organization_id, workspace_id, created_at) VALUES (1, ?, ?, ?)",
				)
				.run(ref.organizationId, ref.workspaceId, new Date().toISOString());
		}
	}

	async describe(): Promise<StoreDescription> {
		const identity = this.db
			.prepare(
				"SELECT organization_id, workspace_id, created_at FROM tenant_store_identity WHERE slot = 1",
			)
			.get()!;
		return {
			organizationId: String(identity.organization_id),
			workspaceId: String(identity.workspace_id),
			createdAt: String(identity.created_at),
			migrations: this.db
				.prepare("SELECT hash FROM __drizzle_migrations ORDER BY id")
				.all()
				.map((row) => String(row.hash)),
			jurisdiction: this.#jurisdiction,
		};
	}

	/** Same rules as the object's `importRows`: all or nothing, receipt per batch, scope enforced. */
	async importRows(batch: ImportBatch): Promise<ImportReceipt> {
		if (!batch.batchId.trim()) throw new Error("import requires batchId");
		mappingFor(batch.table);
		if (batch.rows.length > IMPORT_CHUNK_ROWS)
			throw new Error(`import batch exceeds ${IMPORT_CHUNK_ROWS} rows`);
		const receipt = this.db
			.prepare(
				"SELECT table_name, row_count FROM tenant_store_import_batches WHERE batch_id = ?",
			)
			.get(batch.batchId);
		if (receipt) {
			if (receipt.table_name !== batch.table)
				throw new Error(
					`batch ${batch.batchId} was already used for ${receipt.table_name}`,
				);
			return {
				batchId: batch.batchId,
				table: batch.table,
				rowCount: Number(receipt.row_count),
				status: "duplicate",
			};
		}
		const columnsOf = new Set(
			this.db
				.prepare(`SELECT name FROM pragma_table_info(?)`)
				.all(batch.table)
				.map((row) => String(row.name)),
		);
		this.db.exec("BEGIN");
		try {
			for (const row of batch.rows) {
				const columns = Object.keys(row);
				for (const column of columns)
					if (!columnsOf.has(column))
						throw new Error(`${batch.table} has no column ${column}`);
				for (const [column, expected] of [
					["organization_id", this.#ref.organizationId],
					["org_id", this.#ref.organizationId],
					["workspace_id", this.#ref.workspaceId],
				] as const)
					if (
						columnsOf.has(column) &&
						column in row &&
						row[column] !== expected
					)
						throw new Error(
							`${batch.table}.${column} is outside this workspace`,
						);
				this.db
					.prepare(
						`INSERT INTO "${batch.table}" (${columns.map((c) => `"${c}"`).join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`,
					)
					.run(...columns.map((c) => row[c] ?? null));
			}
			this.db
				.prepare(
					"INSERT INTO tenant_store_import_batches (batch_id, table_name, row_count, imported_at) VALUES (?, ?, ?, ?)",
				)
				.run(
					batch.batchId,
					batch.table,
					batch.rows.length,
					new Date().toISOString(),
				);
			this.db.exec("COMMIT");
		} catch (error) {
			this.db.exec("ROLLBACK");
			throw error;
		}
		return {
			batchId: batch.batchId,
			table: batch.table,
			rowCount: batch.rows.length,
			status: "imported",
		};
	}

	/** Pages walk the table in rowid order; `after` is the last rowid seen. */
	async readRows(table: string, after: string | null, limit: number) {
		mappingFor(table);
		if (!hasTable(this.db, table)) return { rows: [], next: null };
		const rows = this.db
			.prepare(
				`SELECT rowid AS __rowid, * FROM "${table}" WHERE rowid > ? ORDER BY rowid LIMIT ?`,
			)
			.all(after === null ? 0 : Number(after), limit) as Array<
			StoredRow & { __rowid: number }
		>;
		const last = rows.at(-1);
		return {
			rows: rows.map(({ __rowid, ...row }) => row),
			next: rows.length === limit && last ? String(last.__rowid) : null,
		};
	}

	async close(): Promise<void> {
		if (this.db.isOpen) this.db.close();
	}
}

/** Stores under `<dir>/<org>/<workspace>.sqlite`. */
export function localStoreFactory(
	dir: string,
	options: {
		jurisdiction?: string | null;
		fallbackDdl?: (table: string) => string | null;
	} = {},
): WorkspaceStoreFactory {
	return {
		kind: "local",
		async open(ref) {
			return new LocalWorkspaceStore(
				join(dir, ref.organizationId, `${ref.workspaceId}.sqlite`),
				ref,
				options,
			);
		},
	};
}

/**
 * How the remote store signs each call.
 * - `bearer`: the workspace objects' own migration token, sent straight to
 *   the worker that hosts them (local objects, tests).
 * - `tedix`: a Tedix platform-administrator login, sent to the MCP gateway's
 *   `/admin/migration/...` door, which attaches the objects' token itself.
 */
export type RemoteAuth =
	| { mode: "bearer"; token: string }
	| { mode: "tedix"; headers: () => Promise<Record<string, string>> };

function remotePathPrefix(auth: RemoteAuth): string {
	return auth.mode === "tedix" ? "/admin" : "";
}

/**
 * The deployed objects, through the worker that hosts them. The worker
 * implements three routes under `/migration/workspaces/:org/:ws`:
 * `GET` (describe), `POST /import` and `POST /rows`. With `tedix` auth the
 * same three routes sit under `/admin/migration/...` on the MCP gateway.
 */
export class RemoteWorkspaceStore implements WorkspaceStore {
	private readonly auth: RemoteAuth;

	constructor(
		private readonly base: string,
		auth: RemoteAuth | string,
		private readonly ref: WorkspaceRef,
		private readonly fetchImplementation: typeof fetch = fetch,
	) {
		this.auth =
			typeof auth === "string" ? { mode: "bearer", token: auth } : auth;
	}

	private url(suffix = ""): string {
		return `${this.base.replace(/\/$/, "")}${remotePathPrefix(this.auth)}/migration/workspaces/${encodeURIComponent(this.ref.organizationId)}/${encodeURIComponent(this.ref.workspaceId)}${suffix}`;
	}

	private async authHeaders(): Promise<Record<string, string>> {
		return this.auth.mode === "bearer"
			? { authorization: `Bearer ${this.auth.token}` }
			: await this.auth.headers();
	}

	private async call<T>(suffix: string, body?: unknown): Promise<T> {
		const response = await this.fetchImplementation(this.url(suffix), {
			method: body === undefined ? "GET" : "POST",
			headers: {
				...(await this.authHeaders()),
				...(body === undefined ? {} : { "content-type": "application/json" }),
			},
			body: body === undefined ? undefined : JSON.stringify(body),
		});
		if (!response.ok)
			throw new Error(
				`${suffix || "describe"} failed for ${this.ref.workspaceId}: ${response.status} ${await response.text()}`,
			);
		return (await response.json()) as T;
	}

	describe(): Promise<StoreDescription> {
		return this.call<StoreDescription>("");
	}

	activate(input: {
		importGeneration: number;
		reconciliationRef: string;
	}): Promise<unknown> {
		return this.call("/activate", input);
	}

	applyDelta(batch: DeltaBatch): Promise<DeltaReceipt> {
		return this.call("/delta", {
			...batch,
			changes: batch.changes.map((change) => ({
				before: change.before && toWire(change.before),
				after: change.after && toWire(change.after),
			})),
		});
	}

	async importRows(batch: ImportBatch): Promise<ImportReceipt> {
		return this.call<ImportReceipt>("/import", {
			batchId: batch.batchId,
			table: batch.table,
			rows: batch.rows.map(toWire),
		});
	}

	async readRows(table: string, after: string | null, limit: number) {
		const page = await this.call<{ rows: WireRow[]; next: string | null }>(
			"/rows",
			{ table, after, limit },
		);
		return { rows: page.rows.map(fromWire), next: page.next };
	}

	async close(): Promise<void> {}
}

export function remoteStoreFactory(
	base: string,
	auth: RemoteAuth | string,
	fetchImplementation: typeof fetch = fetch,
): WorkspaceStoreFactory {
	return {
		kind: "remote",
		async open(ref) {
			return new RemoteWorkspaceStore(base, auth, ref, fetchImplementation);
		},
	};
}

/** Every row of a table, in key order, for the reconciler. */
export async function readAllRows(
	store: WorkspaceStore,
	table: string,
): Promise<StoredRow[]> {
	const { primaryKey } = mappingFor(table);
	const rows: StoredRow[] = [];
	let after: string | null = null;
	do {
		const page = await store.readRows(table, after, IMPORT_CHUNK_ROWS);
		rows.push(...page.rows);
		after = page.next;
	} while (after !== null);
	return rows.sort((a, b) =>
		rowKey(a, primaryKey) < rowKey(b, primaryKey) ? -1 : 1,
	);
}
