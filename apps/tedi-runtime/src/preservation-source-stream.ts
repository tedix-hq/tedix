import { z } from "zod";
import { compareCutoverWorkflowIds } from "@tedix/api-contract/schemas/tedi";
export type PreservationSqlStorage = Pick<DurableObjectStorage, "sql">;
type Column = { name: string; pk: number; hidden: number };
const CELL_BYTES = 65_536,
	LOCATOR_BYTES = 8_192,
	DESCRIPTOR_COLUMNS = 8;
const count = z.number().int().nonnegative().safe();
const quote = (s: string) => '"' + s.replaceAll('"', '""') + '"';
export function presentSqlTable(
	storage: PreservationSqlStorage,
	table: string,
) {
	return (
		[
			...storage.sql.exec(
				"SELECT name FROM sqlite_master WHERE type='table' AND name=?",
				table,
			),
		].length === 1
	);
}
/** Private framed stream: JSON descriptors followed by exactly N raw bytes and a newline. */
export function sourceDescriptor(value: unknown, refuse: () => never) {
	const text = JSON.stringify(value) + "\n";
	if (Buffer.byteLength(text) > CELL_BYTES) return refuse();
	return Buffer.from(text);
}
function asBytes(value: unknown, refuse: () => never) {
	if (value instanceof ArrayBuffer) return new Uint8Array(value);
	if (value instanceof Uint8Array) return value;
	return refuse();
}
function one<T extends Record<string, SqlStorageValue>>(
	storage: PreservationSqlStorage,
	sql: string,
	refuse: () => never,
	...args: SqlStorageValue[]
): T {
	const it = storage.sql.exec<T>(sql, ...args)[Symbol.iterator](),
		first = it.next();
	if (first.done || !it.next().done) return refuse();
	return first.value;
}
function conjunction(terms: string[], refuse: () => never): string {
	if (!terms.length) return refuse();
	if (terms.length === 1) return terms[0]!;
	const mid = Math.floor(terms.length / 2);
	return `(${conjunction(terms.slice(0, mid), refuse)} AND ${conjunction(terms.slice(mid), refuse)})`;
}
/** Locators are read without materializing source cells; rowid is exact decimal, PK cells bounded. */
function locators(
	storage: PreservationSqlStorage,
	table: string,
	columns: Column[],
	refuse: () => never,
) {
	const entry = [
		...storage.sql.exec<{ name: string; wr: number; type: string }>(
			"PRAGMA table_list",
		),
	].find((r) => r.name === table);
	if (!entry || entry.type !== "table") return refuse();
	if (entry.wr === 0) {
		const rowid = ["rowid", "_rowid_", "oid"].find(
			(n) => !columns.some((c) => c.name.toLowerCase() === n),
		);
		if (!rowid) return refuse();
		return {
			cursor: storage.sql.exec<{ locator: string }>(
				`SELECT CAST(${quote(rowid)} AS TEXT) AS locator FROM ${quote(table)} ORDER BY ${quote(rowid)}`,
			),
			resolve: (row: Record<string, SqlStorageValue>) => {
				if (
					typeof row.locator !== "string" ||
					!/^-?(0|[1-9][0-9]*)$/.test(row.locator)
				)
					return refuse();
				return {
					where: `${quote(rowid)} IS CAST(? AS INTEGER)`,
					args: [row.locator] as SqlStorageValue[],
				};
			},
		};
	}
	if (entry.wr !== 1) return refuse();
	const pk = columns.filter((c) => c.pk > 0).sort((a, b) => a.pk - b.pk);
	if (!pk.length || pk.some((c, i) => c.pk !== i + 1)) return refuse();
	const select = pk.flatMap((c, i) => {
		const n = quote(c.name);
		return [
			`typeof(${n}) AS t${i}`,
			`CASE WHEN typeof(${n})='integer' THEN CAST(${n} AS TEXT) WHEN typeof(${n}) IN ('text','blob') THEN substr(CAST(${n} AS BLOB),1,${LOCATOR_BYTES + 1}) ELSE ${n} END AS v${i}`,
		];
	});
	return {
		cursor: storage.sql.exec(
			`SELECT ${select.join(",")} FROM ${quote(table)} ORDER BY ${pk.map((c) => `${quote(c.name)} COLLATE BINARY`).join(",")}`,
		),
		resolve: (row: Record<string, SqlStorageValue>) => {
			const terms: string[] = [],
				args: SqlStorageValue[] = [];
			let bytes = 0;
			for (const [i, c] of pk.entries()) {
				const t = row[`t${i}`],
					v = row[`v${i}`];
				const type =
					t === "integer"
						? "INTEGER"
						: t === "text"
							? "TEXT"
							: t === "blob"
								? "BLOB"
								: t === "real"
									? "REAL"
									: refuse();
				if (t === "text" || t === "blob") {
					const b = asBytes(v, refuse);
					bytes += b.byteLength;
					if (bytes > LOCATOR_BYTES) return refuse();
					args.push(b.slice().buffer as ArrayBuffer);
				} else if (t === "integer") {
					if (typeof v !== "string" || !/^-?(0|[1-9][0-9]*)$/.test(v))
						return refuse();
					bytes += Buffer.byteLength(v);
					if (bytes > LOCATOR_BYTES) return refuse();
					args.push(v);
				} else {
					if (typeof v !== "number" || !Number.isFinite(v)) return refuse();
					bytes += 8;
					if (bytes > LOCATOR_BYTES) return refuse();
					args.push(v);
				}
				terms.push(`${quote(c.name)} IS CAST(? AS ${type}) COLLATE BINARY`);
			}
			return { where: conjunction(terms, refuse), args };
		},
	};
}
export function* streamSqlTable(
	storage: PreservationSqlStorage,
	table: string,
	refuse: () => never,
): Generator<Uint8Array> {
	const readOne = <T extends Record<string, SqlStorageValue>>(
		storage: PreservationSqlStorage,
		sql: string,
		...args: SqlStorageValue[]
	) => one<T>(storage, sql, refuse, ...args);
	if (!presentSqlTable(storage, table)) {
		yield sourceDescriptor(["table", table, "absent"], refuse);
		return;
	}
	yield sourceDescriptor(["table", table, "present"], refuse);
	// No raw schema digest leaves this private stream. Unsupported overlarge DDL refuses.
	for (const row of storage.sql.exec(
		"SELECT type,name,tbl_name,rootpage,sql FROM sqlite_master WHERE tbl_name=? ORDER BY type COLLATE BINARY,name COLLATE BINARY",
		table,
	))
		yield sourceDescriptor(["schema", table, row], refuse);
	const columns = [
		...storage.sql.exec<Column>(`PRAGMA table_xinfo(${quote(table)})`),
	];
	if (
		!columns.length ||
		new Set(columns.map((c) => c.name)).size !== columns.length
	)
		return refuse();
	for (const column of columns)
		yield sourceDescriptor(["column", table, column], refuse);
	const loc = locators(storage, table, columns, refuse);
	// Only scalar descriptors are grouped: no source TEXT/BLOB payload is selected.
	// A wide future schema still uses at most 24 uniquely named output fields.
	const groups = [];
	for (let at = 0; at < columns.length; at += DESCRIPTOR_COLUMNS) {
		const batch = columns.slice(at, at + DESCRIPTOR_COLUMNS);
		const select = batch.flatMap((c, i) => {
			const name = quote(c.name);
			return [
				`typeof(${name}) AS k${i}`,
				`CASE WHEN typeof(${name}) IN ('text','blob') THEN length(CAST(${name} AS BLOB)) ELSE NULL END AS b${i}`,
				`CASE WHEN typeof(${name})='integer' THEN CAST(${name} AS TEXT) WHEN typeof(${name})='real' THEN ${name} ELSE NULL END AS v${i}`,
			];
		});
		groups.push({ batch, select: select.join(",") });
	}
	let ordinal = 0;
	for (const row of loc.cursor) {
		const { where, args } = loc.resolve(row);
		yield sourceDescriptor(["row", table, ordinal++], refuse);
		for (const { batch, select } of groups) {
			const descriptors = readOne(
				storage,
				`SELECT ${select} FROM ${quote(table)} WHERE ${where}`,
				...args,
			);
			for (const [i, c] of batch.entries()) {
				const name = quote(c.name),
					from = `FROM ${quote(table)} WHERE ${where}`;
				const size = {
					kind: descriptors[`k${i}`],
					bytes: descriptors[`b${i}`],
					value: descriptors[`v${i}`],
				};
				if (size.kind === "null") {
					yield sourceDescriptor(["cell", c.name, "null", 0], refuse);
					continue;
				}
				if (size.kind === "integer") {
					const value = size.value;
					if (typeof value !== "string" || !/^-?(0|[1-9][0-9]*)$/.test(value))
						return refuse();
					yield sourceDescriptor(["cell", c.name, "integer", value], refuse);
					continue;
				}
				if (size.kind === "real") {
					const value = size.value;
					if (typeof value !== "number" || !Number.isFinite(value))
						return refuse();
					const bytes = Buffer.alloc(8);
					bytes.writeDoubleBE(value);
					yield sourceDescriptor(["cell", c.name, "real", 8], refuse);
					yield bytes;
					yield Buffer.from("\n");
					continue;
				}
				if (size.kind !== "text" && size.kind !== "blob") return refuse();
				const length = count.parse(size.bytes);
				yield sourceDescriptor(["cell", c.name, size.kind, length], refuse);
				for (let offset = 1; offset <= length; offset += CELL_BYTES) {
					const result = readOne<{ chunk: ArrayBuffer }>(
						storage,
						`SELECT substr(CAST(${name} AS BLOB),?,${CELL_BYTES}) AS chunk ${from}`,
						offset,
						...args,
					);
					const bytes = asBytes(result.chunk, refuse);
					if (bytes.byteLength !== Math.min(CELL_BYTES, length - offset + 1))
						return refuse();
					yield bytes;
				}
				yield Buffer.from("\n");
			}
		}
	}
}
/** Bounded typed private encoder: allocate no aggregate or oversized base64/JSON value. */
export function encodePrivateKvValue(
	value: unknown,
	refuse: () => never,
): Uint8Array {
	const parts: string[] = [];
	let bytes = 0;
	const seen = new Set<object>();
	const put = (s: string) => {
		bytes += Buffer.byteLength(s);
		if (bytes > 1_000_000) return refuse();
		parts.push(s);
	};
	const text = (s: string) => {
		let n = 2;
		for (const char of s) {
			const c = char.codePointAt(0)!;
			n +=
				c === 34 || c === 92
					? 2
					: c < 32 || (c >= 0xd800 && c <= 0xdfff)
						? 6
						: Buffer.byteLength(char);
			if (n + bytes > 1_000_000) return refuse();
		}
		put(JSON.stringify(s));
	};
	const visit = (v: unknown, depth: number) => {
		if (depth > 64) return refuse();
		if (v === null) {
			put('["null"]');
			return;
		}
		if (v === undefined) {
			put('["undefined"]');
			return;
		}
		if (typeof v === "string") {
			put('["string",');
			text(v);
			put("]");
			return;
		}
		if (typeof v === "boolean") {
			put(v ? '["boolean",true]' : '["boolean",false]');
			return;
		}
		if (typeof v === "number") {
			if (!Number.isFinite(v)) return refuse();
			put('["number",');
			text(Object.is(v, -0) ? "-0" : String(v));
			put("]");
			return;
		}
		if (v instanceof ArrayBuffer || v instanceof Uint8Array) {
			const proto = Object.getPrototypeOf(v);
			if (
				proto !==
				(v instanceof ArrayBuffer
					? ArrayBuffer.prototype
					: Buffer.isBuffer(v)
						? Buffer.prototype
						: Uint8Array.prototype)
			)
				return refuse();
			for (const key of Reflect.ownKeys(v)) {
				if (
					v instanceof ArrayBuffer ||
					typeof key !== "string" ||
					!/^(0|[1-9][0-9]*)$/.test(key)
				)
					return refuse();
			}
			const tag =
				v instanceof ArrayBuffer
					? "array-buffer"
					: Buffer.isBuffer(v)
						? "buffer"
						: "uint8-array";
			if (
				v instanceof Uint8Array &&
				!Buffer.isBuffer(v) &&
				Object.getPrototypeOf(v) !== Uint8Array.prototype
			)
				return refuse();
			if (bytes + Math.ceil(v.byteLength / 3) * 4 + tag.length + 10 > 1_000_000)
				return refuse();
			put("[");
			text(tag);
			put(",");
			text(
				Buffer.from(
					v instanceof ArrayBuffer
						? new Uint8Array(v)
						: new Uint8Array(v.buffer, v.byteOffset, v.byteLength),
				).toString("base64"),
			);
			put("]");
			return;
		}
		if (typeof v !== "object" || seen.has(v)) return refuse();
		seen.add(v);
		const array = Array.isArray(v),
			proto = Object.getPrototypeOf(v);
		if (
			array
				? proto !== Array.prototype
				: proto !== Object.prototype && proto !== null
		)
			return refuse();
		const keys = Reflect.ownKeys(v);
		if (keys.some((k) => typeof k !== "string") || keys.length > 1_000_000 / 4)
			return refuse();
		if (array) {
			const length = Object.getOwnPropertyDescriptor(v, "length");
			if (
				!length ||
				!("value" in length) ||
				!Number.isSafeInteger(length.value) ||
				length.value < 0 ||
				length.value * 8 + bytes > 1_000_000
			)
				return refuse();
			if (
				keys.some(
					(k) =>
						k !== "length" &&
						(!/^(0|[1-9][0-9]*)$/.test(String(k)) || Number(k) >= length.value),
				)
			)
				return refuse();
			put('["array",[');
			for (let i = 0; i < length.value; i++) {
				if (i) put(",");
				const d = Object.getOwnPropertyDescriptor(v, String(i));
				if (!d) {
					put('["hole"]');
					continue;
				}
				if (!("value" in d)) return refuse();
				put('["present",');
				visit(d.value, depth + 1);
				put("]");
			}
			put("]]");
		} else {
			put('["object",[');
			let first = true;
			for (const key of (keys as string[]).sort(compareCutoverWorkflowIds)) {
				const d = Object.getOwnPropertyDescriptor(v, key);
				if (!d || !("value" in d)) return refuse();
				if (!first) put(",");
				first = false;
				put("[");
				text(key);
				put(",");
				visit(d.value, depth + 1);
				put("]");
			}
			put("]]");
		}
		seen.delete(v);
	};
	visit(value, 0);
	put("\n");
	return Buffer.from(parts.join(""));
}
