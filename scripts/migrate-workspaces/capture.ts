/** Read-only, serial D1 capture. Cursor state is committed with each local page. */
import {
	mkdirSync,
	readFileSync,
	writeFileSync,
	renameSync,
	existsSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { remoteD1QueryRest, type RemoteD1RestResult } from "../lib/remote-d1";
import type { CaptureManifest, CaptureMark } from "./capture-manifest";
import { Snapshot } from "./source";
import {
	snapshotManifest,
	validateSnapshot,
	logCoverageProblems,
} from "./snapshot-proof";
import { WORKSPACE_TABLES, type WorkspaceAssignments } from "./tables";
import type { StoredRow } from "./rows";

export interface CaptureConfig {
	accountId: string;
	mainDatabaseId: string;
	logDatabaseIds: string[];
	assignments: WorkspaceAssignments;
}
interface Walk {
	database: string;
	file: string;
	table: string;
	predicate: string;
	params: (string | number | null)[];
	columns: string[];
	mark: CaptureMark;
	after: number;
	done: boolean;
}
interface Cursor {
	config: CaptureConfig;
	startedAt: string;
	walks: Walk[];
	requests: number;
	backoffs: number;
	delayMs: number;
}
const q = (name: string) => `"${name.replaceAll('"', '""')}"`;
const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

export async function capture(
	config: CaptureConfig,
	directory: string,
	options: {
		apiToken: string;
		pageSize?: number;
		delayMs?: number;
		query?: (
			database: string,
			sql: string,
			params: (string | number | null)[],
		) => Promise<RemoteD1RestResult>;
		sleep?: (ms: number) => Promise<void>;
		log?: (line: string) => void;
		/** A local telemetry monitor may raise this value while capture runs. */
		delayFile?: string;
	},
): Promise<CaptureManifest> {
	const pageSize = options.pageSize ?? 100;
	const delayMs = options.delayMs ?? 2000;
	if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 1000)
		throw new Error("page size must be 1..1000");
	if (!Number.isFinite(delayMs) || delayMs < 2000)
		throw new Error("capture delay must be at least 2000ms");
	if (
		!config.logDatabaseIds.length ||
		new Set([config.mainDatabaseId, ...config.logDatabaseIds]).size !==
			config.logDatabaseIds.length + 1
	)
		throw new Error("name main and every distinct log database");
	const dir = resolve(directory);
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	const cursorFile = join(dir, "cursor.json");
	const control = new DatabaseSync(join(dir, "cursor.sqlite"));
	control.exec(
		"CREATE TABLE IF NOT EXISTS capture_cursor (id INTEGER PRIMARY KEY, body TEXT NOT NULL)",
	);
	const saved = control
		.prepare("SELECT body FROM capture_cursor WHERE id=1")
		.get();
	const state: Cursor = saved
		? JSON.parse(String(saved.body))
		: {
				config,
				startedAt: new Date().toISOString(),
				walks: [],
				requests: 0,
				backoffs: 0,
				delayMs,
			};
	if (JSON.stringify(state.config) !== JSON.stringify(config)) {
		control.close();
		throw new Error("resume configuration differs from cursor");
	}
	if (existsSync(join(dir, "manifest.json"))) {
		try {
			const completed = Snapshot.open({ main: join(dir, "manifest.json") });
			try {
				const problems = validateSnapshot(completed);
				if (problems.length)
					throw new Error(
						`completed capture is invalid: ${problems.join("; ")}`,
					);
				return completed.capture!;
			} finally {
				completed.close();
			}
		} finally {
			control.close();
		}
	}
	state.delayMs = Math.max(state.delayMs, delayMs);
	const save = () => {
		control
			.prepare("INSERT OR REPLACE INTO capture_cursor VALUES (1, ?)")
			.run(JSON.stringify(state));
		writeFileSync(`${cursorFile}.tmp`, JSON.stringify(state, null, 2), {
			mode: 0o600,
		});
		renameSync(`${cursorFile}.tmp`, cursorFile);
	};
	const wait = options.sleep ?? sleep;
	const log = options.log ?? console.log;
	const query =
		options.query ??
		((database, sql, params) =>
			remoteD1QueryRest({
				accountId: config.accountId,
				databaseId: database,
				apiToken: options.apiToken,
				sql,
				params,
				caller: "scripts/migrate-workspaces/capture.ts",
			}));
	async function read(
		database: string,
		sql: string,
		params: (string | number | null)[] = [],
	): Promise<StoredRow[]> {
		if (!/^SELECT\b/i.test(sql) || sql.includes(";"))
			throw new Error("capture permits one SELECT only");
		for (let attempt = 0; ; attempt++) {
			if (options.delayFile && existsSync(options.delayFile)) {
				const raised = Number(readFileSync(options.delayFile, "utf8").trim());
				if (Number.isFinite(raised))
					state.delayMs = Math.max(state.delayMs, raised);
			}
			await wait(state.delayMs);
			state.requests++;
			const response = await query(database, sql, params);
			const statements = response.result as
				| { success?: boolean; results?: StoredRow[]; error?: unknown }[]
				| undefined;
			const detail = `${response.detail ?? ""} ${JSON.stringify(statements?.filter((s) => s.success !== true) ?? [])}`;
			if (
				response.ok &&
				statements?.length === 1 &&
				statements[0]?.success === true &&
				Array.isArray(statements[0].results)
			)
				return statements[0].results;
			if (
				(/overload|7429|temporarily unavailable/i.test(detail) ||
					response.status === 429 ||
					response.status === 503) &&
				attempt < 8
			) {
				state.backoffs++;
				state.delayMs = Math.max(
					state.delayMs,
					2000 * 2 ** Math.min(state.backoffs, 6),
				);
				save();
				const backoff = Math.max(30000, state.delayMs);
				log(
					`backoff ${backoff}ms status=${response.status} total=${state.backoffs}`,
				);
				await wait(backoff);
				continue;
			}
			save();
			throw new Error(`capture read failed (${response.status}): ${detail}`);
		}
	}
	async function addWalk(
		database: string,
		file: string,
		table: string,
		predicate: string,
		params: Walk["params"] = [],
	): Promise<void> {
		if (
			state.walks.some(
				(w) =>
					w.database === database &&
					w.table === table &&
					w.predicate === predicate &&
					JSON.stringify(w.params) === JSON.stringify(params),
			)
		)
			return;
		const template = state.walks.find(
			(w) => w.database === database && w.table === table,
		);
		if (template) {
			state.walks.push({
				...template,
				predicate,
				params,
				after: 0,
				done: false,
			});
			save();
			return;
		}
		const columns = await read(
			database,
			`SELECT name FROM pragma_table_info(?) ORDER BY cid`,
			[table],
		);
		if (!columns.length) throw new Error(`missing source table ${table}`);
		const names = columns.map((r) => String(r.name));
		if (names.includes("__capture_rowid"))
			throw new Error("reserved capture column");
		const updated = names.includes("updated_at");
		const bounds = await read(
			database,
			`SELECT coalesce(max(rowid), 0) AS high, strftime('%Y-%m-%dT%H:%M:%fZ', 'now') AS at FROM ${q(table)}`,
		);
		const high = Number(bounds[0]?.high);
		if (!Number.isSafeInteger(high)) throw new Error("unsafe source rowid");
		const db = new DatabaseSync(join(dir, file));
		db.exec(
			`CREATE TABLE IF NOT EXISTS ${q(table)} (${names.map(q).join(", ")})`,
		);
		db.close();
		state.walks.push({
			database,
			file,
			table,
			predicate,
			params,
			columns: names,
			mark: { rowid: high, updatedAt: updated ? String(bounds[0]!.at) : null },
			after: 0,
			done: false,
		});
		save();
	}
	async function walk(w: Walk): Promise<void> {
		if (w.done) return;
		const db = new DatabaseSync(join(dir, w.file));
		try {
			// Attach cursor so rows and their checkpoint commit in one local transaction.
			db.prepare("ATTACH DATABASE ? AS progress").run(
				join(dir, "cursor.sqlite"),
			);
			while (!w.done) {
				const rows = await read(
					w.database,
					`SELECT rowid AS __capture_rowid, ${w.columns.map(q).join(", ")} FROM ${q(w.table)} WHERE rowid > ? AND rowid <= ? AND (${w.predicate}) ORDER BY rowid LIMIT ?`,
					[w.after, w.mark.rowid, ...w.params, pageSize],
				);
				const previous = w.after;
				db.exec("BEGIN IMMEDIATE");
				try {
					const insert = db.prepare(
						`INSERT INTO ${q(w.table)} (${w.columns.map(q).join(", ")}) VALUES (${w.columns.map(() => "?").join(", ")})`,
					);
					for (const row of rows) {
						const id = Number(row.__capture_rowid);
						if (!Number.isSafeInteger(id) || id <= w.after || id > w.mark.rowid)
							throw new Error("invalid keyset page");
						insert.run(...w.columns.map((c) => row[c] ?? null));
						w.after = id;
					}
					w.done = rows.length < pageSize;
					db.prepare(
						"INSERT OR REPLACE INTO progress.capture_cursor VALUES (1, ?)",
					).run(JSON.stringify(state));
					db.exec("COMMIT");
				} catch (error) {
					db.exec("ROLLBACK");
					w.after = previous;
					w.done = false;
					throw error;
				}
				save();
				log(
					`${w.file} ${w.table} cursor=${w.after}/${w.mark.rowid} done=${w.done}`,
				);
			}
		} finally {
			db.close();
		}
	}
	try {
		// Workspaces precede conversations; conversation-bound main rows exclude Home threads.
		for (const mapping of WORKSPACE_TABLES) {
			const predicate =
				mapping.table === "kernel_conversations"
					? "workspace_id IS NOT NULL"
					: mapping.where.includes(":conversations")
						? "EXISTS (SELECT 1 FROM kernel_conversations AS c WHERE c.organization_id = " +
							q(mapping.table) +
							".organization_id AND c.conversation_id = " +
							q(mapping.table) +
							".conversation_id AND c.workspace_id IS NOT NULL)"
						: "1 = 1";
			await addWalk(
				config.mainDatabaseId,
				"main.sqlite",
				mapping.table,
				predicate,
			);
			await walk(
				state.walks.find(
					(w) =>
						w.database === config.mainDatabaseId && w.table === mapping.table,
				)!,
			);
		}
		const main = new DatabaseSync(join(dir, "main.sqlite"));
		const conversations = main
			.prepare(
				"SELECT DISTINCT organization_id, conversation_id FROM kernel_conversations ORDER BY organization_id, conversation_id",
			)
			.all();
		// Only directory identities are needed by the exporter, not organization records.
		main.exec("CREATE TABLE IF NOT EXISTS organizations (id TEXT PRIMARY KEY)");
		main.exec(
			"INSERT OR IGNORE INTO organizations SELECT DISTINCT organization_id FROM os_workspaces",
		);
		main.close();
		for (const [index, database] of config.logDatabaseIds.entries()) {
			const file = `logs-${index}.sqlite`;
			const partitions = await read(
				database,
				"SELECT id, state, from_ts, to_ts FROM log_partition ORDER BY id",
			);
			const db = new DatabaseSync(join(dir, file));
			db.exec(
				"CREATE TABLE IF NOT EXISTS log_partition (id TEXT, state TEXT, from_ts TEXT, to_ts TEXT)",
			);
			db.exec("DELETE FROM log_partition");
			for (const row of partitions)
				db.prepare("INSERT INTO log_partition VALUES (?, ?, ?, ?)").run(
					row.id!,
					row.state!,
					row.from_ts!,
					row.to_ts!,
				);
			db.close();
			// Even an empty conversation set needs an empty event table and a high-water mark.
			if (!conversations.length) {
				await addWalk(database, file, "kernel_runtime_events", "0 = 1");
				await walk(state.walks.at(-1)!);
			}
			const byOrg = new Map<string, string[]>();
			for (const conversation of conversations) {
				const org = String(conversation.organization_id);
				const ids = byOrg.get(org) ?? [];
				ids.push(String(conversation.conversation_id));
				byOrg.set(org, ids);
			}
			for (const [org, ids] of byOrg) {
				for (let offset = 0; offset < ids.length; offset += 50) {
					const chunk = ids.slice(offset, offset + 50);
					const params = [org, ...chunk];
					const predicate = `organization_id = ? AND conversation_id IN (${chunk.map(() => "?").join(", ")})`;
					await addWalk(
						database,
						file,
						"kernel_runtime_events",
						predicate,
						params,
					);
					await walk(
						state.walks.find(
							(w) =>
								w.database === database &&
								JSON.stringify(w.params) === JSON.stringify(params),
						)!,
					);
				}
			}
		}
		save();
		const endedAt = new Date().toISOString();
		const snapshot = Snapshot.fromDatabases(
			new DatabaseSync(join(dir, "main.sqlite"), { readOnly: true }),
			config.logDatabaseIds.map(
				(_, i) =>
					new DatabaseSync(join(dir, `logs-${i}.sqlite`), { readOnly: true }),
			),
			new Date(endedAt),
		);
		let proof;
		try {
			const problems = [
				...validateSnapshot(snapshot, new Date(endedAt)),
				...logCoverageProblems(snapshot),
			];
			if (problems.length)
				throw new Error(`capture coverage failed: ${problems.join("; ")}`);
			proof = { ...snapshotManifest(snapshot), takenAt: endedAt };
		} finally {
			snapshot.close();
		}
		const highWater: CaptureManifest["highWater"] = {};
		for (const w of state.walks) {
			const marks = (highWater[w.file] ??= {});
			marks[w.table] ??= w.mark;
		}
		const manifest: CaptureManifest = {
			kind: "paced-workspace-capture",
			version: 1,
			startedAt: state.startedAt,
			endedAt,
			main: "main.sqlite",
			logs: config.logDatabaseIds.map((_, i) => `logs-${i}.sqlite`),
			logDatabaseIds: config.logDatabaseIds,
			completedLogDatabaseIds: config.logDatabaseIds,
			highWater,
			proof,
			requests: state.requests,
			backoffs: state.backoffs,
			delayMs: state.delayMs,
			assignments: config.assignments,
		};
		writeFileSync(
			join(dir, "manifest.json"),
			JSON.stringify(manifest, null, 2),
			{ mode: 0o600 },
		);
		return manifest;
	} finally {
		control.close();
	}
}
