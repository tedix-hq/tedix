/**
 * The data being moved, read from a snapshot of the shared database.
 *
 * A snapshot is one SQLite file for the main database plus one per log
 * partition (run events and other ledgers are split across them). The
 * cutover takes the snapshot after writes are frozen, so every command
 * reads the same bytes and nothing is read from the live database.
 *
 * `wrangler d1 export` writes SQL; `openSnapshot` loads a `.sql` file into a
 * fresh SQLite database next to it and reuses that file on the next run.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, statSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { RowDigest, rowKey, splitSqlStatements, type StoredRow } from "./rows";
import type { SourceStore, TableMapping, WorkspaceAssignments } from "./tables";

export interface SnapshotPaths {
	main: string;
	logs?: readonly string[];
}

export interface WorkspaceRef {
	organizationId: string;
	workspaceId: string;
}

export class Snapshot {
	readonly main: DatabaseSync;
	readonly logs: readonly DatabaseSync[];

	private constructor(main: DatabaseSync, logs: readonly DatabaseSync[]) {
		this.main = main;
		this.logs = logs;
	}

	static open(paths: SnapshotPaths): Snapshot {
		return new Snapshot(
			openSnapshotFile(paths.main),
			(paths.logs ?? []).map(openSnapshotFile),
		);
	}

	/** In-memory snapshot for tests and rehearsal fixtures. */
	static fromDatabases(
		main: DatabaseSync,
		logs: DatabaseSync[] = [],
	): Snapshot {
		return new Snapshot(main, logs);
	}

	close(): void {
		for (const db of [this.main, ...this.logs]) if (db.isOpen) db.close();
	}

	/**
	 * Every workspace the directory knows plus the Home workspaces the
	 * assignments ask to create, in a stable order.
	 */
	listWorkspaces(assignments: WorkspaceAssignments = {}): WorkspaceRef[] {
		const refs = this.main
			.prepare(
				"SELECT id AS workspace_id, organization_id FROM os_workspaces ORDER BY organization_id, created_at, id",
			)
			.all()
			.map((row) => ({
				organizationId: String(row.organization_id),
				workspaceId: String(row.workspace_id),
			}));
		for (const [organizationId, choice] of Object.entries(assignments))
			if (choice.createHome)
				refs.push({ organizationId, workspaceId: choice.memoryHome });
		return refs.sort((a, b) =>
			`${a.organizationId}/${a.workspaceId}` <
			`${b.organizationId}/${b.workspaceId}`
				? -1
				: 1,
		);
	}

	/** Organizations that still exist; rows of any other organization stay behind. */
	liveOrganizations(): Set<string> {
		return new Set(
			this.main
				.prepare("SELECT id FROM organizations")
				.all()
				.map((row) => String(row.id)),
		);
	}

	/** Rows of a table outside `moves`: left behind on purpose, counted for the report. */
	countStaying(mapping: TableMapping): number {
		const sql = `SELECT count(*) AS n FROM "${mapping.table}" WHERE NOT (${this.expand(mapping.moves)})`;
		let n = 0;
		for (const db of this.storesFor(mapping.stores))
			if (hasTable(db, mapping.table))
				n += Number(db.prepare(sql).get()?.n ?? 0);
		return n;
	}

	/**
	 * One workspace's rows of one table, main store first and log partitions
	 * after it, deduplicated by primary key. A row can sit in two stores for a
	 * moment, but both copies must agree or the snapshot is unsafe to export.
	 */
	readRows(mapping: TableMapping, ref: WorkspaceRef): StoredRow[] {
		const sql = `SELECT * FROM "${mapping.table}" WHERE ${this.expand(mapping.where, ref)}`;
		const params: Record<string, string> = { org: ref.organizationId };
		if (sql.includes("@ws")) params.ws = ref.workspaceId;
		const seen = new Map<string, StoredRow>();
		const rows: StoredRow[] = [];
		for (const db of this.storesFor(mapping.stores)) {
			if (!hasTable(db, mapping.table)) continue;
			for (const raw of db.prepare(sql).all(params)) {
				const row = raw as StoredRow;
				const key = rowKey(row, mapping.primaryKey);
				const previous = seen.get(key);
				if (previous) {
					const first = new RowDigest(mapping.primaryKey);
					const second = new RowDigest(mapping.primaryKey);
					first.add(previous);
					second.add(row);
					if (first.hex() !== second.hex())
						throw new Error(
							`Conflicting duplicate rows in ${mapping.table} across snapshot stores`,
						);
					continue;
				}
				seen.set(key, row);
				rows.push(row);
			}
		}
		return rows;
	}

	/** Rows of a table that move at all, deduplicated across stores. */
	countAll(mapping: TableMapping): number {
		const sql = `SELECT ${mapping.primaryKey.map((c) => `"${c}"`).join(", ")} FROM "${mapping.table}" WHERE ${this.expand(mapping.moves)}`;
		const seen = new Set<string>();
		for (const db of this.storesFor(mapping.stores)) {
			if (!hasTable(db, mapping.table)) continue;
			for (const row of db.prepare(sql).all())
				seen.add(rowKey(row as StoredRow, mapping.primaryKey));
		}
		return seen.size;
	}

	/**
	 * Replace the id-list placeholders with literal lists read from the main
	 * store, and the scalar placeholders with named parameters.
	 */
	private expand(predicate: string, ref?: WorkspaceRef): string {
		let sql = predicate.replaceAll(":org", "@org").replaceAll(":ws", "@ws");
		if (sql.includes(":conversations")) {
			if (!ref) throw new Error("conversation list needs a workspace");
			sql = sql.replaceAll(
				":conversations",
				literalList(
					this.main
						.prepare(
							"SELECT conversation_id AS c FROM kernel_conversations WHERE organization_id = ? AND workspace_id = ?",
						)
						.all(ref.organizationId, ref.workspaceId)
						.map((row) => String(row.c)),
				),
			);
		}
		if (sql.includes(":anyConversations"))
			sql = sql.replaceAll(
				":anyConversations",
				literalList(
					this.main
						.prepare(
							"SELECT organization_id || '|' || conversation_id AS c FROM kernel_conversations WHERE workspace_id IS NOT NULL",
						)
						.all()
						.map((row) => String(row.c)),
				),
			);
		return sql;
	}

	/** Outputs whose `workspace_id` is null, grouped by organization. */
	unassignedOutputs(): Map<string, string[]> {
		const byOrg = new Map<string, string[]>();
		for (const row of this.main
			.prepare(
				"SELECT id, organization_id FROM os_outputs WHERE workspace_id IS NULL ORDER BY organization_id, id",
			)
			.all()) {
			const list = byOrg.get(String(row.organization_id)) ?? [];
			list.push(String(row.id));
			byOrg.set(String(row.organization_id), list);
		}
		return byOrg;
	}

	/**
	 * Organizations that own rows of a table, so memory homes can be checked.
	 * A table without an organization column (edges, expertise) is owned
	 * through its parent rows and contributes nothing here.
	 */
	organizationsWithRows(table: string): string[] {
		if (
			!hasTable(this.main, table) ||
			!hasColumn(this.main, table, "organization_id")
		)
			return [];
		return this.main
			.prepare(
				`SELECT DISTINCT organization_id AS o FROM "${table}" ORDER BY 1`,
			)
			.all()
			.map((row) => String(row.o));
	}

	private storesFor(stores: readonly SourceStore[]): DatabaseSync[] {
		return stores.includes("logs") ? [this.main, ...this.logs] : [this.main];
	}
}

/** `'a', 'b'`; an empty list matches nothing. */
function literalList(ids: readonly string[]): string {
	return ids.length === 0
		? "NULL"
		: ids.map((id) => `'${id.replaceAll("'", "''")}'`).join(", ");
}

export function hasColumn(
	db: DatabaseSync,
	table: string,
	column: string,
): boolean {
	return (
		db
			.prepare("SELECT 1 AS x FROM pragma_table_info(?) WHERE name = ?")
			.get(table, column) !== undefined
	);
}

export function hasTable(db: DatabaseSync, table: string): boolean {
	return (
		db
			.prepare(
				"SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = ?",
			)
			.get(table) !== undefined
	);
}

/**
 * Open a `.sqlite` file, or load a `.sql` export into `<file>.sqlite` once
 * and reuse it. A production export is gigabytes, so the load streams
 * through the `sqlite3` command when it is installed; the in-process path
 * is for small files and tests.
 */
export function openSnapshotFile(path: string): DatabaseSync {
	if (!existsSync(path)) throw new Error(`Snapshot file not found: ${path}`);
	if (!path.endsWith(".sql")) return new DatabaseSync(path, { readOnly: true });
	const target = `${path}.sqlite`;
	if (
		!existsSync(target) ||
		statSync(target).mtimeMs < statSync(path).mtimeMs
	) {
		rmSync(target, { force: true });
		const cli = spawnSync("sqlite3", ["-version"], { encoding: "utf8" });
		if (cli.status === 0) {
			const load = spawnSync(
				"sqlite3",
				[
					target,
					"PRAGMA journal_mode=OFF; PRAGMA synchronous=OFF;",
					`.read ${path}`,
				],
				{ encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
			);
			if (load.status !== 0)
				throw new Error(`sqlite3 could not load ${path}: ${load.stderr}`);
		} else {
			const db = new DatabaseSync(target);
			db.exec("PRAGMA journal_mode = OFF; PRAGMA synchronous = OFF;");
			const sql = readFileSync(path, "utf8");
			db.exec("BEGIN");
			for (const statement of splitSqlStatements(sql)) db.exec(statement);
			db.exec("COMMIT");
			db.close();
		}
	}
	return new DatabaseSync(target, { readOnly: true });
}
