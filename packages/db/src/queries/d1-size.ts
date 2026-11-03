/**
 * Database size, as D1 itself reports it. Every D1 result carries
 * `meta.size_after`, the database size in bytes after the statement ran, so
 * a trivial statement measures the database without scanning anything.
 */

import { sql, type SQL } from "drizzle-orm";
import { createDbQueryClient, type DbQueryClient } from "../query-client";

/** The operator supplies only transport; inventory SQL stays in this owner. */
export function createD1StorageReader(
	read: (
		query: string,
		params: (string | number | null)[],
	) => Promise<{
		success: boolean;
		results: Record<string, unknown>[];
		meta?: { size_after?: number; rows_written?: number };
	}>,
): DbQueryClient {
	const binding = {
		prepare(query: string) {
			if (
				!/^\s*(SELECT\b|PRAGMA\s+(table_xinfo|index_xinfo)\s*\()/i.test(query)
			)
				throw new Error("D1 size adapter accepts inventory reads only");
			const statement = (params: (string | number | null)[]) => ({
				bind: (...values: (string | number | null)[]) => statement(values),
				all: () => read(query, params),
				run: () => read(query, params),
			});
			return statement([]);
		},
	};
	return createDbQueryClient(
		binding as unknown as Parameters<typeof createDbQueryClient>[0],
	);
}

export async function readD1SizeBytes(
	db: DbQueryClient,
): Promise<number | null> {
	try {
		const result = await db.run(sql`SELECT 1`);
		const size = (result.meta as { size_after?: unknown } | undefined)
			?.size_after;
		return typeof size === "number" && Number.isFinite(size) ? size : null;
	} catch (error) {
		console.warn(
			JSON.stringify({
				signal: "d1.size.probe_failed",
				message: error instanceof Error ? error.message : String(error),
			}),
		);
		return null;
	}
}

export interface D1StorageObject {
	name: string;
	table: string;
	type: "table" | "index";
	bytes: number | null;
	rows: number | null;
	sampledRows: number | null;
	note: string | null;
}

export interface D1StorageReport {
	inventory: Pick<D1StorageObject, "name" | "table" | "type">[];
	method: "dbstat" | "estimate";
	dbstatProbeError: string | null;
	sizeBefore: number | null;
	sizeAfter: number | null;
	objects: D1StorageObject[];
	attributedBytes: number;
	unattributedBytes: number | null;
	gapPercent: number | null;
	complete: boolean;
	notes: string[];
}

interface SchemaObject {
	name: string;
	tbl_name: string;
	type: "table" | "index";
	sql: string | null;
	rootpage: number;
}

interface Column {
	name: string;
	type: string;
	pk: number;
}

const identifier = (name: string) => sql.raw(`"${name.replaceAll('"', '""')}"`);

/** Extract only SQLite-validated index expressions/predicate from sqlite_master. */
function indexDefinition(definition: string): {
	terms: string[];
	predicate: string;
} {
	let depth = 0;
	let start = 0;
	const terms: string[] = [];
	for (let i = 0; i < definition.length; i++) {
		const char = definition[i]!;
		if (char === "'" || char === '"' || char === "`" || char === "[") {
			const end = char === "[" ? "]" : char;
			while (++i < definition.length) {
				if (definition[i] !== end) continue;
				if (char !== "[" && definition[i + 1] === end) {
					i++;
					continue;
				}
				break;
			}
		} else if (definition.slice(i, i + 2) === "--") {
			const newline = definition.indexOf("\n", i + 2);
			i = newline < 0 ? definition.length : newline;
		} else if (definition.slice(i, i + 2) === "/*") {
			const end = definition.indexOf("*/", i + 2);
			if (end < 0) throw new Error("Unterminated index comment");
			i = end + 1;
		} else if (char === "(") {
			if (depth++ === 0) start = i + 1;
		} else if (char === "," && depth === 1) {
			terms.push(definition.slice(start, i));
			start = i + 1;
		} else if (char === ")" && --depth === 0) {
			terms.push(definition.slice(start, i));
			const suffix = definition
				.slice(i + 1)
				.trim()
				.replace(/;\s*$/, "");
			if (suffix && !/^WHERE\s/i.test(suffix))
				throw new Error("Unrecognized index suffix");
			return {
				terms: terms.map((term) =>
					term.trim().replace(/\s+(ASC|DESC)\s*$/i, ""),
				),
				predicate: suffix ? suffix.replace(/^WHERE\s+/i, "") : "1",
			};
		}
	}
	throw new Error("Unrecognized index definition");
}

function message(error: unknown): string {
	// Drizzle wraps the provider's diagnostic in one or more query errors.
	for (
		let depth = 0;
		depth < 8 && error instanceof Error && error.cause;
		depth++
	) {
		error = error.cause;
	}
	return error instanceof Error ? error.message : String(error);
}

/**
 * Operator-only inventory; never call from a request handler. Fallback counts
 * walk keyset pages and sample every column in the first rows of each page.
 * No row contents or cursor values are included in the returned report.
 */
export async function readD1StorageReport(
	db: DbQueryClient,
	options: {
		pageSize?: number;
		sampleSize?: number;
		maxPages?: number;
		concurrency?: number;
		excludeTables?: readonly string[];
		onTable?: (objects: D1StorageObject[]) => void | Promise<void>;
	} = {},
): Promise<D1StorageReport> {
	const pageSize = options.pageSize ?? 1000;
	const sampleSize = options.sampleSize ?? 32;
	const maxPages = options.maxPages ?? 100_000;
	const concurrency = options.concurrency ?? 1;
	if (
		!Number.isInteger(concurrency) ||
		concurrency < 1 ||
		concurrency > 4 ||
		!Number.isInteger(pageSize) ||
		pageSize < 1 ||
		pageSize > 5000 ||
		!Number.isInteger(sampleSize) ||
		sampleSize < 1 ||
		sampleSize > pageSize ||
		!Number.isInteger(maxPages) ||
		maxPages < 1 ||
		maxPages > 100_000
	)
		throw new Error("Invalid D1 report page/sample budget");

	const report: D1StorageReport = {
		inventory: [],
		method: "dbstat",
		dbstatProbeError: null,
		sizeBefore: await readD1SizeBytes(db),
		sizeAfter: null,
		objects: [],
		attributedBytes: 0,
		unattributedBytes: null,
		gapPercent: null,
		complete: true,
		notes: [],
	};
	// Probe only; do not CREATE a virtual table or change connection settings.
	try {
		await db.all(
			sql`SELECT name, pgsize FROM dbstat WHERE aggregate = TRUE LIMIT 1`,
		);
	} catch (error) {
		// Only a dbstat-specific rejection permits the more expensive fallback.
		if (
			!/no such (?:table|module): (?:main\.)?dbstat|not authorized.*dbstat|dbstat.*not authorized/i.test(
				message(error),
			)
		)
			throw new Error(`D1 dbstat probe failed: ${message(error)}`, {
				cause: error,
			});
		report.method = "estimate";
		report.dbstatProbeError = message(error);
	}

	let pages = 0;
	const spendPage = () => {
		if (++pages > maxPages) throw new Error("D1 report query budget exhausted");
	};
	const schema: SchemaObject[] = [];
	let afterName = "";
	while (true) {
		spendPage();
		const page = await db.all<SchemaObject>(sql`
			SELECT name, tbl_name, type, sql, rootpage FROM sqlite_master
			WHERE type IN ('table', 'index') AND name > ${afterName}
			ORDER BY name LIMIT 100`);
		schema.push(...page);
		if (page.length < 100) break;
		afterName = page[page.length - 1]!.name;
	}
	report.inventory = schema.map((object) => ({
		name: object.name,
		table: object.tbl_name,
		type: object.type,
	}));

	if (report.method === "dbstat") {
		// The schema btree is omitted from sqlite_master itself.
		for (const object of [
			{
				name: "sqlite_schema",
				tbl_name: "sqlite_schema",
				type: "table" as const,
				rootpage: 1,
			},
			...schema,
		]) {
			spendPage();
			const [stat] = await db.all<{ bytes: number }>(sql`
				SELECT pgsize AS bytes FROM dbstat
				WHERE aggregate = TRUE AND name = ${object.name} LIMIT 1`);
			const bytes = stat?.bytes ?? (object.rootpage === 0 ? 0 : null);
			report.objects.push({
				name: object.name,
				table: object.tbl_name,
				type: object.type,
				bytes,
				rows: null,
				sampledRows: null,
				note:
					object.rootpage === 0
						? "No own btree; virtual/embedded storage is counted in its backing btrees."
						: null,
			});
		}
		report.notes.push(
			"Physical btree page bytes from dbstat aggregate mode, including overflow and unused space. Freelist, pointer-map and lock pages are excluded by dbstat; the signed residual also includes concurrent database growth/shrinkage.",
		);
	} else {
		const tables = schema.filter(
			(object) =>
				object.type === "table" &&
				!options.excludeTables?.includes(object.name),
		);
		if (options.excludeTables?.length)
			report.notes.push(
				`Checkpoint continuation excludes already measured tables: ${options.excludeTables.join(", ")}`,
			);
		const readTable = async (table: SchemaObject) => {
			const indexes = schema.filter(
				(object) => object.type === "index" && object.tbl_name === table.name,
			);
			const objects = [table, ...indexes].map((object): D1StorageObject => ({
				name: object.name,
				table: table.name,
				type: object.type,
				bytes: null,
				rows: null,
				sampledRows: null,
				note: null,
			}));
			report.objects.push(...objects);
			if (/^CREATE\s+VIRTUAL\s+TABLE/i.test(table.sql ?? "")) {
				objects[0]!.bytes = 0;
				objects[0]!.note =
					"Virtual table has no own btree; see backing tables. Storage unknown if backing tables are inaccessible.";
				await options.onTable?.(objects);
				return;
			}
			try {
				spendPage();
				const columns = await db.all<Column>(
					sql`PRAGMA table_xinfo(${identifier(table.name)})`,
				);
				const withoutRowid = /\bWITHOUT\s+ROWID\b/i.test(table.sql ?? "");
				const rowid = ["rowid", "_rowid_", "oid"].find(
					(key) => !columns.some((c) => c.name.toLowerCase() === key),
				);
				const keys = withoutRowid
					? columns
							.filter((c) => c.pk > 0)
							.sort((a, b) => a.pk - b.pk)
							.map((c) => c.name)
					: rowid
						? [rowid]
						: [];
				if (!keys.length) throw new Error("No accessible keyset cursor");
				const keySql = sql.join(keys.map(identifier), sql`, `);
				const keyProjection = sql.join(
					keys.map(
						(key, i) => sql`${identifier(key)} AS ${identifier(`k${i}`)}`,
					),
					sql`, `,
				);
				// length(CAST AS BLOB) measures UTF-8 bytes, including embedded NULs.
				// Integer/real sizes remain textual approximations, explicitly labelled.
				const projections = columns.map(
					(c, i) =>
						sql`coalesce(length(CAST(${identifier(c.name)} AS BLOB)), 0) AS ${identifier(`c${i}`)}`,
				);
				for (let i = 0; i < indexes.length; i++) {
					spendPage();
					const index = indexes[i]!;
					const info = await db.all<{
						seqno: number;
						cid: number;
						name: string | null;
					}>(sql`PRAGMA index_xinfo(${identifier(index.name)})`);
					const definition = index.sql ? indexDefinition(index.sql) : null;
					const sizes = info.map((column) => {
						if (column.cid === -1) return sql`8`;
						const term =
							column.name !== null
								? identifier(column.name)
								: definition?.terms[column.seqno]
									? sql.raw(definition.terms[column.seqno]!)
									: null;
						if (!term) throw new Error("Unrecognized indexed expression");
						return sql`coalesce(length(CAST((${term}) AS BLOB)), 0)`;
					});
					if (!sizes.length)
						throw new Error("Index has no visible storage columns");
					const predicate = sql.raw(definition?.predicate ?? "1");
					projections.push(
						sql`CASE WHEN (${predicate}) THEN (${sql.join(sizes, sql` + `)}) ELSE 0 END AS ${identifier(`ib${i}`)}`,
						sql`CASE WHEN (${predicate}) THEN 1 ELSE 0 END AS ${identifier(`ir${i}`)}`,
					);
				}
				const totals = columns.map(() => 0);
				const indexBytes = indexes.map(() => 0);
				const indexRows = indexes.map(() => 0);
				let count = 0;
				let sampled = 0;
				let cursor: (string | number | null)[] | null = null;
				while (true) {
					const where: SQL = cursor
						? sql`(${keySql}) > (${sql.join(
								cursor.map((value) => sql`${value}`),
								sql`, `,
							)})`
						: sql`1`;
					spendPage();
					const page = await db.all<Record<string, string | number | null>>(sql`
						SELECT ${keyProjection} FROM ${identifier(table.name)}
						WHERE ${where} ORDER BY ${keySql} LIMIT ${pageSize}`);
					if (!page.length) break;
					let sample: Record<string, number>[] = [];
					// D1 limits result columns; wide tables/index sets need separate projections.
					for (let offset = 0; offset < projections.length; offset += 40) {
						spendPage();
						const chunk = await db.all<Record<string, number>>(sql`
							SELECT ${sql.join(projections.slice(offset, offset + 40), sql`, `)} FROM ${identifier(table.name)}
							WHERE ${where} ORDER BY ${keySql} LIMIT ${Math.min(sampleSize, page.length)}`);
						if (offset === 0) sample = chunk;
						else {
							if (chunk.length !== sample.length)
								throw new Error("Rows changed between sample projections");
							for (let i = 0; i < chunk.length; i++)
								Object.assign(sample[i]!, chunk[i]);
						}
					}
					count += page.length;
					sampled += sample.length;
					if (!sample.length)
						throw new Error(
							"Rows disappeared during sampling; rerun for a coherent estimate",
						);
					const weight = page.length / sample.length;
					for (const row of sample) {
						for (let i = 0; i < columns.length; i++)
							totals[i]! += weight * row[`c${i}`]!;
						for (let i = 0; i < indexes.length; i++) {
							indexBytes[i]! += weight * row[`ib${i}`]!;
							indexRows[i]! += weight * row[`ir${i}`]!;
						}
					}
					cursor = keys.map((_, i) => page[page.length - 1]![`k${i}`]!);
					if (page.length < pageSize) break;
				}
				objects[0]!.rows = count;
				objects[0]!.sampledRows = sampled;
				objects[0]!.bytes = Math.round(
					totals.reduce((sum, value) => sum + value, 0),
				);
				objects[0]!.note =
					"Estimate: exact paged row count × mean sampled byte length of every column; not allocated physical bytes.";
				for (let i = 0; i < indexes.length; i++) {
					const object = objects[i + 1]!;
					object.bytes = Math.round(indexBytes[i]!);
					object.rows = Math.round(indexRows[i]!);
					object.sampledRows = sampled;
					object.note =
						"Estimate: page-weighted sampled index expressions and predicate, including auxiliary primary-key columns or an 8-byte rowid allowance. Index row count is also estimated.";
				}
			} catch (error) {
				if (message(error) === "D1 report query budget exhausted") throw error;
				for (const object of objects)
					object.note = `Unknown/incomplete: ${message(error)}`;
				report.complete = false;
			}
			await options.onTable?.(objects);
		};
		let nextTable = 0;
		await Promise.all(
			Array.from({ length: Math.min(concurrency, tables.length) }, async () => {
				while (nextTable < tables.length) await readTable(tables[nextTable++]!);
			}),
		);
		report.objects.sort(
			(a, b) => a.table.localeCompare(b.table) || a.name.localeCompare(b.name),
		);
		report.notes.push(
			"Estimates are logical payload proxies, not measured allocation. Samples use the first rows of every keyset page, not a random sample; skew and concurrent writes can bias counts and means. Numeric encoding, record headers, btree cell/branch overhead, page fill, overflow framing, freelist and internal schema pages are not attributed. No residual is distributed across tables to force reconciliation.",
		);
	}
	report.sizeAfter = await readD1SizeBytes(db);
	report.attributedBytes = report.objects.reduce(
		(sum, object) => sum + (object.bytes ?? 0),
		0,
	);
	if (report.sizeAfter !== null) {
		report.unattributedBytes = report.sizeAfter - report.attributedBytes;
		report.gapPercent =
			report.sizeAfter === 0
				? 0
				: (100 * report.unattributedBytes) / report.sizeAfter;
	}
	report.complete &&=
		!options.excludeTables?.length &&
		report.objects.every((object) => object.bytes !== null);
	return report;
}
