#!/usr/bin/env bun

/**
 * Daily read-only snapshot of a shared D1 database, grouped by what the tables
 * hold: core business data, organization and tedi memory, append-only history
 * and the app catalog cache. Evidence for the Postgres-vs-D1 decision in
 * docs/engineering/core-database-decision.md.
 *
 * Uses the `cf` CLI login of the operator machine; nothing here writes to D1.
 * D1 statements go through the audited scripts/lib/remote-d1.ts path.
 * Per table: exact row count, plus byte estimates from the newest rows.
 * Per group, last 24 h: executions, rows read and written, DB time (D1
 * insights, top 1,000 statements by reads, duration and executions).
 * Worker logs, last 24 h: D1 overload (7429), "temporarily unavailable" and
 * other D1_ERROR events per Worker.
 *
 *   bun scripts/db/core-capacity-snapshot.ts --database-id <uuid> \
 *     [--out-dir ~/.tedix/core-capacity] [--sheet <outputId> --tedix-profile connect --tedix-organization <slug>]
 *
 * --sheet appends one row per group to a Tedix sheet Output (columns below).
 * --from-file <snapshot.json> --sheet <outputId> re-sends a saved snapshot.
 * Keep live ids out of this repository; pass them as arguments.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
	type RemoteD1StatementResult,
	remoteD1CfQuery,
} from "../lib/remote-d1";

export type Group = "core" | "memory" | "history" | "catalog";
export const GROUPS: Group[] = ["core", "memory", "history", "catalog"];

/** Append-only history: rows are added, rarely updated, and kept as evidence. */
const HISTORY = new Set([
	"agent_session_events",
	"audit_events",
	"audit_metadata_refs",
	"external_agent_attributions",
	"external_agent_workload_token_uses",
	"kernel_request_events",
	"kernel_runtime_events",
	"learning_interaction_events",
	"machine_provider_probe_results",
	"machine_tool_calls",
	"mcp_inbound_client_attempts",
	"mcp_payment_events",
	"os_gadget_executions",
	"os_gadget_state_mutations",
	"os_workspace_events",
	"platform_cron_executions",
	"provider_event_deliveries",
	"provider_probe_receipts",
	"provider_probe_results",
	"residency_execution_receipts",
	"skill_usage_events",
	"stripe_webhook_events",
	"tedi_approval_dependency_events",
	"tedi_approval_execution_receipts",
	"tedi_artifact_contribution_receipts",
	"tedi_call_costs",
	"tedi_control_plane_binding_history",
	"tedi_cron_executions",
	"tedi_email_events",
	"tedi_plugin_events",
	"tedi_runtime_events",
	"tedi_usage_events",
	"widget_events",
	"work_events",
	"workflow_run_ledger",
	"workspace_activity",
	"workspace_feed_ledger",
]);

const MEMORY = new Set([
	"knowledge_entries",
	"rationale_org_counts",
	"tedi_expertise",
	"tedi_memory_documents",
	"tedi_muscle_memory",
	"tedi_rationale_records",
]);

export function groupOf(table: string): Group {
	if (HISTORY.has(table)) return "history";
	if (table.startsWith("memory_") || MEMORY.has(table)) return "memory";
	if (table.startsWith("app_catalog") || table === "upstream_drift_reports")
		return "catalog";
	return "core";
}

/** The table a statement mainly reads or writes: its target, else its first FROM. */
export function primaryTable(
	query: string,
	known: ReadonlySet<string>,
): string | null {
	const target =
		/^\s*(?:insert\s+(?:or\s+\w+\s+)?into|replace\s+into|update|delete\s+from)\s+["`]?(\w+)/i.exec(
			query.replace(/^\s*with\b[\s\S]*?\)\s*(?=insert|update|delete)/i, ""),
		);
	if (target && known.has(target[1]!)) return target[1]!;
	for (const match of query.matchAll(
		/\b(?:from|join|into|update)\s+["`]?(\w+)/gi,
	)) {
		if (known.has(match[1]!)) return match[1]!;
	}
	return null;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function cf(args: string[]): Promise<unknown> {
	for (let attempt = 1; ; attempt++) {
		const proc = Bun.spawn(["cf", ...args], { stdout: "pipe", stderr: "pipe" });
		const [out, err, code] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited,
		]);
		const json = out.slice(Math.max(0, out.search(/^[[{]/m)));
		if (code === 0 && json) return JSON.parse(json);
		// D1 7429 (overloaded): back off instead of adding load.
		if (attempt < 4 && /7429|overloaded|timeout|ECONN/i.test(out + err)) {
			await sleep(30_000 * attempt);
			continue;
		}
		throw new Error(`cf ${args.slice(0, 3).join(" ")} failed: ${err || out}`);
	}
}

/** Time D1 itself spent on this script's statements, for pacing. */
let serverMs = 0;

/**
 * Several read statements in one `cf d1 query` call (one D1 batch), so the
 * CLI round trip (~3 s) is paid once per batch instead of once per statement.
 */
async function d1Batch(databaseId: string, statements: string[]) {
	let result: RemoteD1StatementResult[];
	for (let attempt = 1; ; attempt++) {
		try {
			result = await remoteD1CfQuery({
				databaseId,
				sql: statements.join(";\n"),
				caller: "scripts/db/core-capacity-snapshot.ts",
			});
			break;
		} catch (error) {
			// D1 7429 (overloaded): back off instead of adding load.
			if (
				attempt >= 4 ||
				!/7429|7403|overloaded|timeout|5[0-9][0-9] /i.test(String(error))
			)
				throw error;
			await sleep(30_000 * attempt);
		}
	}
	if (result.length !== statements.length)
		throw new Error("D1 batch returned an unexpected number of results");
	if (result.some((r) => r.meta?.rows_written))
		throw new Error("Read-only snapshot unexpectedly wrote rows");
	const ms = result.reduce((sum, r) => sum + (r.meta?.duration ?? 0), 0);
	serverMs += ms;
	return { results: result.map((r) => r.results), ms };
}

async function d1(databaseId: string, query: string) {
	return (await d1Batch(databaseId, [query])).results[0]!;
}

/** Run statements in batches, leaving the database idle 3x as long as each batch held it. */
async function inBatches<T>(
	databaseId: string,
	items: T[],
	size: number,
	pause: number,
	statement: (item: T) => string,
	onResult: (item: T, rows: Record<string, unknown>[]) => void,
) {
	for (let i = 0; i < items.length; i += size) {
		const chunk = items.slice(i, i + size);
		const { results, ms } = await d1Batch(databaseId, chunk.map(statement));
		chunk.forEach((item, j) => onResult(item, results[j]!));
		console.error(`${Math.min(i + size, items.length)}/${items.length}`);
		await sleep(Math.max(pause, 3 * ms));
	}
}

/** Tables whose rowid span is larger than this are not counted row by row. */
const COUNT_LIMIT = 250_000;

const ident = (name: string) => `"${name.replaceAll('"', '""')}"`;

interface TableStats {
	table: string;
	group: Group;
	rows: number;
	tableBytes: number;
	indexBytes: number;
	sampledRows: number;
	rowsEstimated?: boolean;
	error?: string;
}

interface TediMemoryWrites {
	versions: number;
	contentBytes: number;
	revisionBytes: number;
}

async function measureTables(
	databaseId: string,
	pause: number,
	since: Date,
	until: Date,
) {
	const schema = (await d1(
		databaseId,
		"SELECT type, name, tbl_name AS tbl, coalesce(sql, '') AS sql FROM sqlite_master WHERE type IN ('table','index') AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'",
	)) as { type: string; name: string; tbl: string; sql: string }[];
	const columns = (await d1(
		databaseId,
		"SELECT m.name AS t, p.name AS c FROM sqlite_master m JOIN pragma_table_xinfo(m.name) p WHERE m.type = 'table' AND m.name NOT LIKE 'sqlite_%' AND m.name NOT LIKE '_cf_%'",
	)) as { t: string; c: string }[];
	const indexColumns = (await d1(
		databaseId,
		"SELECT m.name AS i, m.tbl_name AS t, p.name AS c FROM sqlite_master m JOIN pragma_index_info(m.name) p WHERE m.type = 'index'",
	)) as { i: string; t: string; c: string | null }[];

	const tables = schema.filter(
		(object) =>
			object.type === "table" && !/^CREATE\s+VIRTUAL/i.test(object.sql),
	);
	const cols = new Map(
		tables.map((t) => [
			t.name,
			columns.filter((c) => c.t === t.name).map((c) => c.c),
		]),
	);
	const rowidTables = tables.filter((t) => !/WITHOUT\s+ROWID/i.test(t.sql));
	const stats = new Map<string, TableStats>(
		tables.map((t) => [
			t.name,
			{
				table: t.name,
				group: groupOf(t.name),
				rows: 0,
				tableBytes: 0,
				indexBytes: 0,
				sampledRows: 0,
			},
		]),
	);
	// count(*) scans the table and holds the database for seconds on
	// million-row tables. Above COUNT_LIMIT, the rowid span (two index seeks)
	// stands in: exact for append-only tables, an upper bound where rows were
	// deleted from the middle.
	const span = new Map<string, number>();
	let memoryFirstRowid = 0;
	let memoryLastRowid = -1;
	console.error("rowid spans");
	await inBatches(
		databaseId,
		rowidTables,
		25,
		pause,
		(t) =>
			`SELECT coalesce(max(rowid) - min(rowid) + 1, 0) AS n, min(rowid) AS first_rowid, max(rowid) AS last_rowid FROM ${ident(t.name)}`,
		(t, rows) => {
			span.set(t.name, Number(rows[0]?.n ?? 0));
			if (t.name === "tedi_memory_documents") {
				memoryFirstRowid = Number(rows[0]?.first_rowid ?? 0);
				memoryLastRowid = Number(rows[0]?.last_rowid ?? -1);
			}
		},
	);
	for (const [name, n] of span) {
		// FTS shadow tables encode segment levels in rowid: their span says nothing.
		if (n > COUNT_LIMIT && n < 100_000_000)
			Object.assign(stats.get(name)!, { rows: n, rowsEstimated: true });
	}
	const counts = tables
		.filter(
			(t) => (span.get(t.name) ?? 1) > 0 && !stats.get(t.name)!.rowsEstimated,
		)
		.map((t) => ({
			sql: `SELECT count(*) AS n FROM ${ident(t.name)}`,
			onResult: (row: Record<string, unknown>) => {
				stats.get(t.name)!.rows = Number(row.n ?? 0);
			},
		}));
	const tediMemory: TediMemoryWrites = {
		versions: 0,
		contentBytes: 0,
		revisionBytes: 0,
	};
	// No created_at index exists. Bound each scan to 1,000 rowids and batch
	// with the counts; filtering by time must not assume rowid order is time order.
	for (let first = memoryFirstRowid; first <= memoryLastRowid; first += 1_000) {
		counts.push({
			sql: `SELECT count(*) AS versions,
				coalesce(sum(coalesce(length(CAST(sections AS BLOB)), 0) + coalesce(length(CAST(description AS BLOB)), 0) + coalesce(length(CAST(content AS BLOB)), 0)), 0) AS content_bytes,
				coalesce(sum(length(CAST(revision AS BLOB))), 0) AS revision_bytes
				FROM tedi_memory_documents WHERE rowid >= ${first} AND rowid < ${first + 1_000}
				AND datetime(created_at) >= datetime('${since.toISOString()}') AND datetime(created_at) < datetime('${until.toISOString()}')`,
			onResult: (row) => {
				tediMemory.versions += Number(row.versions);
				tediMemory.contentBytes += Number(row.content_bytes);
				tediMemory.revisionBytes += Number(row.revision_bytes);
			},
		});
	}
	console.error("row counts and tedi memory writes");
	await inBatches(
		databaseId,
		counts,
		10,
		pause,
		(item) => item.sql,
		(item, rows) => item.onResult(rows[0]!),
	);
	// One statement per table over its newest 200 rows: the mean row width
	// and the mean key width of each index (expressions count 16 bytes).
	const len = (c: string) => `coalesce(length(CAST(${ident(c)} AS BLOB)), 0)`;
	const indexesOf = (table: string) =>
		schema.filter((o) => o.type === "index" && o.tbl === table);
	const width = new Map<string, { row: number; indexes: number[] }>();
	console.error("byte samples");
	await inBatches(
		databaseId,
		tables.filter((t) => stats.get(t.name)!.rows > 0),
		1,
		pause,
		(t) => {
			const order = /WITHOUT\s+ROWID/i.test(t.sql) ? "" : "ORDER BY rowid DESC";
			const keys = indexesOf(t.name).map((index, i) => {
				const terms = indexColumns.filter((c) => c.i === index.name);
				const sum = terms
					.map((term) => (term.c ? len(term.c) : "16"))
					.join(" + ");
				return `, avg(${sum || "0"}) AS k${i}`;
			});
			return `SELECT count(*) AS sampled, avg(${cols.get(t.name)!.map(len).join(" + ")}) AS w${keys.join("")} FROM (SELECT * FROM ${ident(t.name)} ${order} LIMIT 200)`;
		},
		(t, rows) => {
			const row = rows[0] ?? {};
			stats.get(t.name)!.sampledRows = Number(row.sampled ?? 0);
			width.set(t.name, {
				row: Number(row.w ?? 0),
				indexes: indexesOf(t.name).map((_, i) => Number(row[`k${i}`] ?? 0)),
			});
		},
	);
	for (const table of tables) {
		const entry = stats.get(table.name)!;
		const w = width.get(table.name) ?? { row: 0, indexes: [] };
		// Payload plus a 1-byte header per column and ~9 bytes of cell framing.
		entry.tableBytes = Math.round(
			entry.rows * (w.row + cols.get(table.name)!.length + 9),
		);
		indexesOf(table.name).forEach((index, i) => {
			const terms = indexColumns.filter((c) => c.i === index.name).length;
			// Key bytes, a header byte per term and the 8-byte rowid with framing.
			// Partial indexes are counted as full: an upper bound.
			entry.indexBytes += Math.round(
				entry.rows * ((w.indexes[i] ?? 0) + terms + 17),
			);
		});
	}
	return {
		stats: [...stats.values()],
		tableNames: new Set(tables.map((t) => t.name)),
		tediMemory,
	};
}

interface InsightRow {
	query: string;
	executions: number;
	rows_read: number;
	rows_written: number;
	total_duration_ms: number;
}

async function readInsights(
	databaseId: string,
	since: string,
	until: string,
	known: ReadonlySet<string>,
) {
	const statements = new Map<string, InsightRow>();
	for (const orderBy of ["rows_read", "duration", "executions"]) {
		const rows = (await cf([
			"d1",
			"insights",
			"queries",
			"--database-id",
			databaseId,
			"--since",
			since,
			"--until",
			until,
			"--order-by",
			orderBy,
			"--limit",
			"1000",
		])) as InsightRow[];
		for (const row of rows) statements.set(row.query, row);
		await sleep(2_000);
	}
	const databases = (await cf([
		"d1",
		"insights",
		"databases",
		"--since",
		since,
		"--until",
		until,
	])) as {
		database_id: string;
		rows_read: number;
		rows_written: number;
		queries: number;
	}[];
	const totals = databases.find((d) => d.database_id === databaseId) ?? null;

	const groups = Object.fromEntries(
		[...GROUPS, "unknown"].map((g) => [
			g,
			{ executions: 0, rowsRead: 0, rowsWritten: 0, durationMs: 0 },
		]),
	) as Record<
		Group | "unknown",
		{
			executions: number;
			rowsRead: number;
			rowsWritten: number;
			durationMs: number;
		}
	>;
	const byTable = new Map<
		string,
		{ rowsRead: number; rowsWritten: number; durationMs: number }
	>();
	for (const row of statements.values()) {
		const table = primaryTable(row.query, known);
		const group = table ? groupOf(table) : "unknown";
		const target = groups[group];
		target.executions += row.executions;
		target.rowsRead += row.rows_read;
		target.rowsWritten += row.rows_written;
		target.durationMs += row.total_duration_ms;
		if (table) {
			const t = byTable.get(table) ?? {
				rowsRead: 0,
				rowsWritten: 0,
				durationMs: 0,
			};
			t.rowsRead += row.rows_read;
			t.rowsWritten += row.rows_written;
			t.durationMs += row.total_duration_ms;
			byTable.set(table, t);
		}
	}
	const top = [...statements.values()]
		.sort((a, b) => b.total_duration_ms - a.total_duration_ms)
		.slice(0, 15)
		.map((row) => ({
			table: primaryTable(row.query, known),
			executions: row.executions,
			rowsRead: row.rows_read,
			rowsWritten: row.rows_written,
			durationMs: Math.round(row.total_duration_ms),
			query: row.query.replace(/\s+/g, " ").slice(0, 200),
		}));
	const covered = [...statements.values()].reduce(
		(sum, row) => ({
			executions: sum.executions + row.executions,
			rowsRead: sum.rowsRead + row.rows_read,
			rowsWritten: sum.rowsWritten + row.rows_written,
			durationMs: sum.durationMs + row.total_duration_ms,
		}),
		{ executions: 0, rowsRead: 0, rowsWritten: 0, durationMs: 0 },
	);
	return { statements: statements.size, totals, covered, groups, byTable, top };
}

const ERROR_KINDS = {
	// Counts log events (one failure can log more than one), across all D1
	// databases a Worker uses, not only main.
	d1Overloaded: 'D1 DB is overloaded|"overloaded"',
	temporarilyUnavailable: "Database temporarily unavailable",
	d1ErrorAny: "D1_ERROR",
} as const;

async function readErrors(fromMs: number, toMs: number) {
	const result: Record<
		string,
		{ total: number; byService: Record<string, number> }
	> = {};
	for (const [kind, needle] of Object.entries(ERROR_KINDS)) {
		const body = {
			queryId: `core-capacity-${kind}`,
			view: "calculations",
			timeframe: { from: fromMs, to: toMs },
			parameters: {
				datasets: ["cloudflare-workers"],
				calculations: [{ operator: "count", alias: "n" }],
				groupBys: [{ type: "string", value: "$metadata.service" }],
				needle: { value: needle, isRegex: true, matchCase: false },
				limit: 50,
			},
			ignoreSeries: true,
		};
		const response = (await cf([
			"o11y",
			"telemetry",
			"query",
			"--body",
			JSON.stringify(body),
		])) as {
			calculations?: { aggregates?: { groupKey: string; value: number }[] }[];
		};
		const byService: Record<string, number> = {};
		for (const aggregate of response.calculations?.[0]?.aggregates ?? [])
			byService[aggregate.groupKey] = aggregate.value;
		result[kind] = {
			total: Object.values(byService).reduce((sum, n) => sum + n, 0),
			byService,
		};
		await sleep(2_000);
	}
	return result;
}

export const SHEET_COLUMNS = [
	"Date (UTC)",
	"Group",
	"Tables",
	"Rows",
	"Est. table MB",
	"Est. index MB",
	"Share of file MB",
	"Executions 24h",
	"Rows read 24h",
	"Rows written 24h",
	"DB time s 24h",
	"File MB",
	"D1 overload 24h",
	"Temporarily unavailable 24h",
	"D1_ERROR 24h",
	"Insights coverage (rows read %)",
	"Tedi memory versions 24h",
	"Tedi memory content bytes 24h",
	"Tedi memory revision bytes 24h",
	"Tedi memory total bytes 24h",
	"Tedi memory >50 MB/day",
];

function sheetRows(snapshot: Snapshot): (string | number | null)[][] {
	const mb = (n: number) => Math.round(n / 1e5) / 10;
	return [...GROUPS, "total" as const].map((group) => {
		const isTotal = group === "total";
		const memory = group === "memory" ? snapshot.tediMemory : undefined;
		const memoryBytes = memory
			? memory.contentBytes + memory.revisionBytes
			: null;
		const size = isTotal ? snapshot.size.total : snapshot.size.groups[group];
		const load = isTotal
			? snapshot.insights.covered
			: snapshot.insights.groups[group];
		return [
			snapshot.date,
			group,
			size.tables,
			size.rows,
			mb(size.tableBytes),
			mb(size.indexBytes),
			mb(size.shareOfFileBytes),
			load.executions,
			load.rowsRead,
			load.rowsWritten,
			Math.round(load.durationMs / 1000),
			isTotal ? mb(snapshot.fileBytes) : null,
			isTotal ? snapshot.errors.d1Overloaded!.total : null,
			isTotal ? snapshot.errors.temporarilyUnavailable!.total : null,
			isTotal ? snapshot.errors.d1ErrorAny!.total : null,
			isTotal ? snapshot.insights.coveragePercent : null,
			...(snapshot.tediMemory
				? [
						memory?.versions ?? null,
						memory?.contentBytes ?? null,
						memory?.revisionBytes ?? null,
						memoryBytes,
						memoryBytes !== null && memoryBytes > 50_000_000
							? ">50 MB/day"
							: null,
					]
				: []),
		];
	});
}

async function appendToSheet(
	snapshot: Snapshot,
	outputId: string,
	profile: string,
	organization: string,
) {
	const rows = sheetRows(snapshot);
	// Read the sheet, then write below its last row against that revision.
	const program = `async () => {
		const out = await os.get_os_output({ outputId: ${JSON.stringify(outputId)} });
		const revision = out.revision ?? out.currentRevision ?? out.output?.currentRevision;
		const content = typeof revision?.content === "string" ? JSON.parse(revision.content) : revision?.content;
		const existing = content?.rows ?? [];
		if (existing.some((r) => r[0] === ${JSON.stringify(snapshot.date)})) return { skipped: "already recorded" };
		let expectedRevision = revision.revision;
		const columns = ${JSON.stringify(SHEET_COLUMNS)};
		// Range writes cannot add columns. Extend the sheet once, preserving its rows and workbook.
		if (${Boolean(snapshot.tediMemory)} && content.columns.length < columns.length) {
			const expanded = { ...content, columns: [...content.columns, ...columns.slice(content.columns.length)] };
			const active = expanded.workbook?.sheets.find((s) => s.id === expanded.workbook.activeSheetId);
			if (active) active.columns.push(...columns.slice(active.columns.length).map((label, i) => ({ id: "tedi-memory-" + i, label, width: 180 })));
			const resized = await os.revise_os_output({ outputId: ${JSON.stringify(outputId)}, content: expanded,
				expectedRevisionId: revision.id, expectedRevision, note: "tedi memory capacity columns" });
			expectedRevision = resized.revision.revision;
		}
		const res = await os.set_os_sheet_range({ outputId: ${JSON.stringify(outputId)}, startRow: existing.length, startColumn: 0,
			cells: ${JSON.stringify(rows)}, expectedRevision, note: "core capacity snapshot ${snapshot.date}" });
		return { revision: res.revision?.revision, startRow: existing.length };
	}`;
	// The gateway answers "retry shortly" during deploys and index refreshes.
	for (let attempt = 1; ; attempt++) {
		const proc = Bun.spawn(
			[
				"tedix",
				"-w",
				profile,
				"--organization",
				organization,
				"code",
				program,
				"--json",
			],
			{
				stdout: "pipe",
				stderr: "pipe",
				env: { ...process.env, TEDIX_EXTERNAL_AGENT: undefined },
			},
		);
		const [out, err, code] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited,
		]);
		if (code === 0 && !/^\s*\{"error"/.test(out)) return out.trim();
		if (
			attempt >= 5 ||
			!/retry|unavailable|rate.?limit|refreshing/i.test(out + err)
		)
			throw new Error(`sheet append failed: ${err || out}`);
		await sleep(60_000 * attempt);
	}
}

interface SizeTotals {
	tables: number;
	rows: number;
	tableBytes: number;
	indexBytes: number;
	shareOfFileBytes: number;
}

interface Snapshot {
	date: string;
	window: { since: string; until: string };
	databaseId: string;
	fileBytes: number;
	/** Absent in snapshots saved before tedi memory write measurement. */
	tediMemory?: TediMemoryWrites;
	size: {
		total: SizeTotals;
		groups: Record<Group, SizeTotals>;
		failedTables: string[];
	};
	insights: Awaited<ReturnType<typeof readInsights>> & {
		coveragePercent: number | null;
	};
	errors: Awaited<ReturnType<typeof readErrors>>;
	tables: (TableStats & {
		rowsRead24h: number;
		rowsWritten24h: number;
		dbTimeS24h: number;
	})[];
}

function required(name: string): string {
	const value = arg(name);
	if (!value) throw new Error(`Pass --${name}`);
	return value;
}

function arg(name: string): string | undefined {
	const index = process.argv.indexOf(`--${name}`);
	return index >= 0 ? process.argv[index + 1] : undefined;
}

async function main() {
	// Re-send a snapshot already written (after a failed sheet append).
	const fromFile = arg("from-file");
	const sheet = arg("sheet");
	if (fromFile) {
		if (!sheet) throw new Error("--from-file needs --sheet");
		const saved = JSON.parse(await Bun.file(fromFile).text()) as Snapshot;
		console.log(
			await appendToSheet(
				saved,
				sheet,
				arg("tedix-profile") ?? "connect",
				required("tedix-organization"),
			),
		);
		return;
	}
	const databaseId =
		arg("database-id") ?? process.env.CORE_SNAPSHOT_DATABASE_ID;
	if (!databaseId)
		throw new Error("Pass --database-id <uuid> of the shared main D1");
	const outDir = arg("out-dir") ?? join(homedir(), ".tedix", "core-capacity");
	// 12 s between statements keeps the snapshot a small share of D1 time.
	const pause = Number(arg("pause-ms") ?? 12_000);
	// The window is the 24 h ending at the last full UTC hour.
	const until = new Date();
	until.setUTCMinutes(0, 0, 0);
	const since = new Date(until.getTime() - 86_400_000);
	const date = until.toISOString().slice(0, 10);

	const info = (await cf(["d1", "get", databaseId])) as { file_size: number };
	const { stats, tableNames, tediMemory } = await measureTables(
		databaseId,
		pause,
		since,
		until,
	);
	const insights = await readInsights(
		databaseId,
		since.toISOString(),
		until.toISOString(),
		tableNames,
	);
	const errors = await readErrors(since.getTime(), until.getTime());

	const estimated = stats.reduce(
		(sum, s) => sum + s.tableBytes + s.indexBytes,
		0,
	);
	const empty = (): SizeTotals => ({
		tables: 0,
		rows: 0,
		tableBytes: 0,
		indexBytes: 0,
		shareOfFileBytes: 0,
	});
	const groups = Object.fromEntries(GROUPS.map((g) => [g, empty()])) as Record<
		Group,
		SizeTotals
	>;
	const total = empty();
	for (const s of stats) {
		const share = estimated
			? (info.file_size * (s.tableBytes + s.indexBytes)) / estimated
			: 0;
		for (const target of [groups[s.group], total]) {
			target.tables++;
			target.rows += s.rows;
			target.tableBytes += s.tableBytes;
			target.indexBytes += s.indexBytes;
			target.shareOfFileBytes += share;
		}
	}
	const snapshot: Snapshot = {
		date,
		window: { since: since.toISOString(), until: until.toISOString() },
		databaseId,
		fileBytes: info.file_size,
		size: {
			total,
			groups,
			failedTables: stats.filter((s) => s.error).map((s) => s.table),
		},
		insights: {
			...insights,
			coveragePercent: insights.totals
				? Math.round(
						(1000 * insights.covered.rowsRead) /
							Math.max(1, insights.totals.rows_read),
					) / 10
				: null,
		},
		errors,
		tediMemory,
		tables: stats
			.map((s) => {
				const load = insights.byTable.get(s.table);
				return {
					...s,
					rowsRead24h: load?.rowsRead ?? 0,
					rowsWritten24h: load?.rowsWritten ?? 0,
					dbTimeS24h: Math.round((load?.durationMs ?? 0) / 1000),
				};
			})
			.sort(
				(a, b) => b.tableBytes + b.indexBytes - (a.tableBytes + a.indexBytes),
			),
	};
	mkdirSync(outDir, { recursive: true });
	const file = join(outDir, `${date}.json`);
	writeFileSync(
		file,
		JSON.stringify(
			{ ...snapshot, insights: { ...snapshot.insights, byTable: undefined } },
			null,
			2,
		),
	);
	console.log(`Snapshot written to ${file}`);
	console.table(
		sheetRows(snapshot).map((row) =>
			Object.fromEntries(SHEET_COLUMNS.map((column, i) => [column, row[i]])),
		),
	);
	if (sheet)
		console.log(
			await appendToSheet(
				snapshot,
				sheet,
				arg("tedix-profile") ?? "connect",
				required("tedix-organization"),
			),
		);
}

if (import.meta.main) await main();
