import { createHash } from "node:crypto";
import { readFile, rename, writeFile } from "node:fs/promises";
import { gunzipSync } from "node:zlib";
import { setTimeout as sleep } from "node:timers/promises";

type Row = Record<string, unknown>;
type Scalar = string | number | null;
export interface CopyTable {
	table: string;
	keys: string[];
	columns: Record<string, "value" | "json" | "boolean" | "epoch" | "timestamp">;
	/** Target identity column that preserves the source rowid. */
	sourceRowid?: string;
}
export interface CopySource {
	/** Identifies the installation, immutable capture/window and source table. */
	id: string;
	/** Source rowid upper bound when the reader knows the whole window. */
	highWater?: number;
	page(
		cursor: Row | null,
		limit: number,
	): Promise<{
		rows: Row[];
		next: Row | null;
	}>;
}
export type PgQuery = (
	sql: string,
	params: unknown[],
) => Promise<{ rows: Row[] }>;
export interface CopyReceipt {
	keys: Row[];
	sha256: string;
}
export interface CopyState {
	format: "tedix-core-copy/v1";
	plan: string;
	tableHash: string;
	cursor: Row | null;
	pages: CopyReceipt[];
	done: boolean;
}
const quote = (name: string) => {
	if (!/^[a-z_][a-z0-9_]*$/.test(name))
		throw new Error(`Invalid identifier: ${name}`);
	return `"${name}"`;
};
function canonical(value: unknown): string {
	if (typeof value === "number" && !Number.isFinite(value))
		throw new Error("Non-finite copy value");
	if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
	if (value && typeof value === "object")
		return `{${Object.entries(value)
			.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
			.map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
			.join(",")}}`;
	const text = JSON.stringify(value);
	if (text === undefined) throw new Error("Non-JSON copy value");
	return text;
}
const hash = (value: unknown) =>
	createHash("sha256").update(canonical(value)).digest("hex");
const pageHash = (rows: Row[]) => hash(rows.map(canonical).sort());

function copiedRowid(column: string, value: unknown) {
	const numeric = typeof value === "string" ? Number(value) : value;
	if (
		typeof numeric !== "number" ||
		!Number.isSafeInteger(numeric) ||
		numeric <= 0
	)
		throw new Error(`Invalid copied rowid for ${column}`);
	return numeric;
}

function normalize(table: CopyTable, row: Row, fromPg = false): Row {
	return Object.fromEntries(
		Object.entries(table.columns).map(([column, kind]) => {
			if (column === table.sourceRowid) {
				const value = fromPg ? row[column] : (row.__copy_rowid ?? row.__rowid);
				return [column, copiedRowid(column, value)];
			}
			let value = row[column];
			if (value === undefined) throw new Error(`Missing column ${column}`);
			if (value !== null) {
				if (kind === "json" && !fromPg && typeof value === "string")
					value = JSON.parse(value);
				if (kind === "boolean") {
					if (value !== 0 && value !== 1 && value !== false && value !== true)
						throw new Error(`Invalid boolean ${column}`);
					value = Boolean(value);
				}
				if (kind === "epoch" || kind === "timestamp") {
					const milliseconds =
						kind === "epoch" && !fromPg
							? Number(value) * 1000
							: Date.parse(String(value));
					value = new Date(milliseconds).toISOString();
				}
			}
			return [column, value];
		}),
	);
}
function checkTable(table: CopyTable) {
	quote(table.table);
	Object.keys(table.columns).forEach(quote);
	if (
		!table.keys.length ||
		new Set(table.keys).size !== table.keys.length ||
		table.keys.some((key) => !(key in table.columns))
	)
		throw new Error("Copy needs unique keys included in columns");
	if (table.sourceRowid !== undefined) {
		quote(table.sourceRowid);
		if (!(table.sourceRowid in table.columns))
			throw new Error("Source rowid column must be copied");
		if (table.keys.includes(table.sourceRowid))
			throw new Error("Source rowid column cannot be a copy key");
	}
}
function returnedRows(table: CopyTable, rows: Row[]) {
	return rows.map((row) => normalize(table, row.copied_row as Row, true));
}

async function advanceSourceRowid(
	table: CopyTable,
	query: PgQuery,
	minimum: number,
) {
	const column = table.sourceRowid;
	if (!column) return;
	if (!Number.isSafeInteger(minimum) || minimum <= 0)
		throw new Error("Invalid source rowid high water");
	const sequence = await query(
		`SELECT pg_get_serial_sequence($1, $2) AS sequence`,
		[table.table, column],
	);
	const name = sequence.rows[0]?.sequence;
	if (typeof name !== "string" || !name)
		throw new Error(`Missing identity sequence for ${table.table}.${column}`);
	await query(
		`WITH target AS (
			SELECT namespace.nspname AS schemaname, class.relname AS sequencename
			FROM pg_class AS class
			JOIN pg_namespace AS namespace ON namespace.oid = class.relnamespace
			WHERE class.oid = to_regclass($1)
		), current AS (
			SELECT sequences.last_value
			FROM pg_sequences AS sequences
			JOIN target ON sequences.schemaname = target.schemaname
				AND sequences.sequencename = target.sequencename
		)
		SELECT setval(
			$1::regclass,
			GREATEST($2::bigint, COALESCE((SELECT last_value FROM current), $2::bigint)),
			true
		)`,
		[name, minimum],
	);
}

/** One JSON parameter and one atomic upsert per page; replay after a crash is safe. */
async function writePage(table: CopyTable, query: PgQuery, rows: Row[]) {
	const columns = Object.keys(table.columns).map(quote).join(", ");
	const updates = Object.keys(table.columns).filter(
		(c) => !table.keys.includes(c) && c !== table.sourceRowid,
	);
	// A key-only table still needs RETURNING rows on replay.
	const set = (updates.length ? updates : table.keys)
		.map((c) => `${quote(c)} = EXCLUDED.${quote(c)}`)
		.join(", ");
	const override = table.sourceRowid ? " OVERRIDING SYSTEM VALUE" : "";
	const result = await query(
		`INSERT INTO ${quote(table.table)} AS target (${columns})${override} SELECT ${columns} FROM jsonb_populate_recordset(NULL::${quote(table.table)}, $1::jsonb) ON CONFLICT (${table.keys.map(quote).join(", ")}) DO UPDATE SET ${set} RETURNING to_jsonb(target) AS copied_row`,
		[JSON.stringify(rows)],
	);
	if (pageHash(returnedRows(table, result.rows)) !== pageHash(rows))
		throw new Error("Copied page checksum mismatch");
}

/** Check only Postgres against receipts made from copied pages, never D1. */
export async function verifyCopy(
	table: CopyTable,
	query: PgQuery,
	state: CopyState,
) {
	checkTable(table);
	if (state.tableHash !== hash(table))
		throw new Error("Verification table differs from checkpoint");
	for (const page of state.pages) {
		const result = await query(
			`SELECT to_jsonb(target) AS copied_row FROM ${quote(table.table)} AS target JOIN jsonb_populate_recordset(NULL::${quote(table.table)}, $1::jsonb) AS expected ON ${table.keys.map((c) => `target.${quote(c)} = expected.${quote(c)}`).join(" AND ")}`,
			[JSON.stringify(page.keys)],
		);
		if (pageHash(returnedRows(table, result.rows)) !== page.sha256)
			throw new Error("Target verification checksum mismatch");
	}
}

/**
 * Rebuild the Postgres docs_sites.active_release_id marker for copied sites.
 * Run only after docs_sites, docs_builds and docs_releases are copied and
 * verified; the update touches only the marker column.
 */
export async function restoreDocsReleaseMarkers(
	query: PgQuery,
	siteIds: readonly string[],
) {
	await query(
		`UPDATE "docs_sites" AS site
		SET "active_release_id" = (
			SELECT release.id
			FROM "docs_releases" AS release
			WHERE release.site_id = site.id
			ORDER BY release.created_at DESC, release.release_order DESC
			LIMIT 1
		)
		WHERE site.id IN (SELECT jsonb_array_elements_text($1::jsonb))`,
		[JSON.stringify(siteIds)],
	);
}

export async function copyPages(options: {
	table: CopyTable;
	source: CopySource;
	query: PgQuery;
	state?: CopyState;
	save(state: CopyState): Promise<void>;
	pageSize?: number;
	pauseMs?: number;
	wait?: (ms: number) => Promise<unknown>;
}) {
	const { table, source, query, save } = options;
	checkTable(table);
	const size = options.pageSize ?? 250;
	const pause = options.pauseMs ?? 1000;
	if (
		!Number.isInteger(size) ||
		size < 1 ||
		size > 500 ||
		!Number.isFinite(pause) ||
		pause < 0
	)
		throw new Error("pageSize must be 1..500 and pauseMs nonnegative");
	const plan = hash({ table, source: source.id, size });
	let state: CopyState = options.state ?? {
		format: "tedix-core-copy/v1",
		plan,
		tableHash: hash(table),
		cursor: null,
		pages: [],
		done: false,
	};
	if (state.format !== "tedix-core-copy/v1" || state.plan !== plan)
		throw new Error("Checkpoint belongs to a different copy plan");
	if (options.state) await verifyCopy(table, query, state);
	let advancedSourceRowid = 0;
	if (
		table.sourceRowid &&
		source.highWater !== undefined &&
		source.highWater > 0
	) {
		await advanceSourceRowid(table, query, source.highWater);
		advancedSourceRowid = source.highWater;
	}
	while (!state.done) {
		await (options.wait ?? sleep)(pause);
		const page = await source.page(state.cursor, size);
		if (page.rows.length > size) throw new Error("Source exceeded page bound");
		if (!page.rows.length) {
			if (page.next !== null) throw new Error("Empty source page has a cursor");
			state = { ...state, done: true };
		} else {
			if (!page.next || canonical(page.next) === canonical(state.cursor))
				throw new Error("Copy cursor did not advance");
			const rows = page.rows.map((row) => normalize(table, row));
			const keys = rows.map((row) =>
				Object.fromEntries(
					table.keys.map((key) => {
						if (row[key] === null) throw new Error("Copy key must not be null");
						return [key, row[key]];
					}),
				),
			);
			if (new Set(keys.map(canonical)).size !== rows.length)
				throw new Error("Duplicate page key");
			await writePage(table, query, rows);
			if (table.sourceRowid) {
				const pageMax = Math.max(
					...rows.map((row) => Number(row[table.sourceRowid!])),
				);
				if (pageMax > advancedSourceRowid) {
					await advanceSourceRowid(table, query, pageMax);
					advancedSourceRowid = pageMax;
				}
			}
			state = {
				...state,
				cursor: page.next,
				pages: [...state.pages, { keys, sha256: pageHash(rows) }],
			};
		}
		// Save only after the target accepted and checked the whole page.
		await save(state);
	}
	return state;
}

export async function saveCheckpoint(path: string, state: CopyState) {
	await writeFile(`${path}.tmp`, JSON.stringify(state) + "\n", { mode: 0o600 });
	await rename(`${path}.tmp`, path);
}
export async function loadCheckpoint(path: string): Promise<CopyState> {
	return JSON.parse(await readFile(path, "utf8")) as CopyState;
}

/** Read callback is injected; this module contains no remote D1 credentials/transport. */
export function keysetSource(options: {
	id: string;
	table: string;
	read(sql: string, params: Scalar[]): Promise<Row[]>;
	highWater: number;
	afterRowid?: number;
	hot?: { column: string; from: Scalar };
	delta?: { column: string; after: string | number; through: string | number };
}): CopySource {
	const { read, highWater, hot, delta } = options;
	const initialRowid = options.afterRowid ?? 0;
	const table = quote(options.table);
	if (!Number.isSafeInteger(highWater) || highWater < 0)
		throw new Error("Invalid rowid high water");
	if (
		!Number.isSafeInteger(initialRowid) ||
		initialRowid < 0 ||
		initialRowid > highWater
	)
		throw new Error("Invalid starting rowid");
	if (hot) quote(hot.column);
	if (delta) {
		quote(delta.column);
		if (
			typeof delta.after !== typeof delta.through ||
			delta.after > delta.through
		)
			throw new Error("Invalid delta interval");
	}
	return {
		id: canonical({
			id: options.id,
			table: options.table,
			highWater,
			initialRowid,
			hot: hot ?? null,
			delta: delta ?? null,
		}),
		highWater,
		async page(cursor, limit) {
			const after = Number(cursor?.rowid ?? initialRowid);
			let where = "rowid > ? AND rowid <= ?";
			let params: Scalar[] = [after, highWater];
			let order = "rowid";
			if (delta) {
				const column = quote(delta.column);
				const time = (cursor?.updated ?? delta.after) as Scalar;
				where = `(${column}, rowid) > (?, ?) AND ${column} <= ? AND rowid <= ?`;
				params = [time, after, delta.through, highWater];
				order = `${column}, rowid`;
			}
			if (hot) {
				where += ` AND ${quote(hot.column)} >= ?`;
				params.push(hot.from);
			}
			const rows = await read(
				`SELECT rowid AS __copy_rowid, * FROM ${table} WHERE ${where} ORDER BY ${order} LIMIT ?`,
				[...params, limit],
			);
			let previousRowid = after;
			let previousTime = (cursor?.updated ?? delta?.after) as string | number;
			for (const row of rows) {
				const rowid = Number(row.__copy_rowid);
				const time = delta
					? (row[delta.column] as string | number)
					: previousTime;
				if (
					!Number.isSafeInteger(rowid) ||
					rowid <= 0 ||
					rowid > highWater ||
					(delta
						? typeof time !== typeof delta.after ||
							time < previousTime ||
							(time === previousTime && rowid <= previousRowid)
						: rowid <= previousRowid)
				)
					throw new Error("Source keyset did not advance");
				previousRowid = rowid;
				previousTime = time;
			}
			const last = rows.at(-1);
			return {
				rows,
				next: last
					? {
							rowid: last.__copy_rowid,
							...(delta ? { updated: last[delta.column] } : {}),
						}
					: null,
			};
		},
	};
}

export function archiveSource(options: {
	id: string;
	endpoint: string;
	table: string;
	organization: string;
	/** List a single key strictly after the supplied key (R2 StartAfter). */
	nextKey(prefix: string, after: string): Promise<string | null>;
	get(key: string): Promise<Uint8Array>;
}): CopySource {
	const url = new URL(options.endpoint);
	if (
		url.protocol !== "https:" ||
		!/^[a-f0-9]{32}\.eu\.r2\.cloudflarestorage\.com$/.test(url.hostname)
	)
		throw new Error("History requires the EU R2 jurisdiction endpoint");
	quote(options.table);
	if (!options.organization || options.organization === "_platform")
		throw new Error("History needs an organization prefix");
	const prefix = `d1-archive/v1/${options.table}/${encodeURIComponent(options.organization)}/`;
	return {
		id: canonical({ id: options.id, endpoint: options.endpoint, prefix }),
		async page(cursor, limit) {
			let key = String(cursor?.key ?? "");
			let offset = Number(cursor?.offset ?? 0);
			// The previous object is complete; listing can resume without rereading it.
			if (!key || offset === -1) {
				const next = await options.nextKey(prefix, key);
				if (next === null) return { rows: [], next: null };
				if (
					next <= key ||
					!next.startsWith(prefix) ||
					!next.endsWith(".ndjson.gz")
				)
					throw new Error("Invalid archive pagination");
				key = next;
				offset = 0;
			}
			const bytes = await options.get(key);
			const digest = /-([a-f0-9]{64})\.ndjson\.gz$/.exec(key)?.[1];
			if (digest && createHash("sha256").update(bytes).digest("hex") !== digest)
				throw new Error("Archive object checksum mismatch");
			const rows = gunzipSync(bytes, { maxOutputLength: 16 * 1024 * 1024 })
				.toString("utf8")
				.split("\n")
				.filter(Boolean)
				.map((line) => JSON.parse(line) as Row);
			if (!rows.length) throw new Error("Empty archive object");
			const selected = rows.slice(offset, offset + limit);
			if (
				selected.some(
					(row) =>
						"organization_id" in row &&
						row.organization_id !== options.organization,
				)
			)
				throw new Error("Archive organization mismatch");
			return {
				rows: selected,
				next: {
					key,
					offset:
						offset + selected.length >= rows.length
							? -1
							: offset + selected.length,
				},
			};
		},
	};
}
