/**
 * Row encoding shared by every command: how a stored row travels through a
 * bundle and how the reconciler turns a set of rows into one hash.
 *
 * Values are copied as stored. SQLite has text, integer, real, null and
 * blob; JSON carries the first four directly and a blob as `{ $b64 }`.
 */
import { createHash } from "node:crypto";

export type StoredValue = string | number | null | Uint8Array;
export type StoredRow = Record<string, StoredValue>;

type WireValue = string | number | null | { $b64: string };
export type WireRow = Record<string, WireValue>;

export function toWire(row: StoredRow): WireRow {
	const out: WireRow = {};
	for (const [column, value] of Object.entries(row)) {
		out[column] =
			value instanceof Uint8Array
				? { $b64: Buffer.from(value).toString("base64") }
				: value;
	}
	return out;
}

export function fromWire(row: WireRow): StoredRow {
	const out: StoredRow = {};
	for (const [column, value] of Object.entries(row)) {
		out[column] =
			value !== null && typeof value === "object"
				? new Uint8Array(Buffer.from(value.$b64, "base64"))
				: value;
	}
	return out;
}

/** Canonical form of one value inside the digest; never ambiguous across types. */
function canonicalValue(value: StoredValue): string {
	if (value === null) return "n";
	if (typeof value === "number")
		return Number.isInteger(value) ? `i${value}` : `f${value}`;
	if (value instanceof Uint8Array)
		return `b${Buffer.from(value).toString("base64")}`;
	return `s${JSON.stringify(value)}`;
}

/** A row's identity under `primaryKey`, usable as a sort key and a map key. */
export function rowKey(row: StoredRow, primaryKey: readonly string[]): string {
	return primaryKey
		.map((column) => canonicalValue(row[column] ?? null))
		.join("|");
}

/** One row as the digest sees it: every column in name order. */
export function renderRow(row: StoredRow): string {
	return Object.keys(row)
		.sort()
		.map((column) => `${column}=${canonicalValue(row[column] ?? null)}`)
		.join(",");
}

export function compareKeys(a: string, b: string): number {
	return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * One SHA-256 over all rows: sorted by primary key, each row rendered with
 * its columns in name order. Both sides of a comparison must feed the same
 * columns; a column that exists on one side only shows up as a different hash.
 */
export class RowDigest {
	readonly #lines: Array<[string, string]> = [];
	constructor(private readonly primaryKey: readonly string[]) {}

	add(row: StoredRow): void {
		this.#lines.push([rowKey(row, this.primaryKey), renderRow(row)]);
	}

	get count(): number {
		return this.#lines.length;
	}

	hex(): string {
		const hash = createHash("sha256");
		for (const [, rendered] of this.#lines.sort((a, b) =>
			compareKeys(a[0], b[0]),
		)) {
			hash.update(rendered);
			hash.update("\n");
		}
		return hash.digest("hex");
	}
}

/** Stable, repeatable id for one import chunk; a rerun reuses the receipt. */
export function batchIdFor(
	workspaceId: string,
	table: string,
	chunkIndex: number,
): string {
	return createHash("sha256")
		.update(`${workspaceId}\n${table}\n${chunkIndex}`)
		.digest("hex")
		.slice(0, 32);
}

/** Split a statement file on drizzle's breakpoint marker or on `;` lines. */
export function splitSqlStatements(sql: string): string[] {
	const parts = sql.includes("--> statement-breakpoint")
		? sql.split("--> statement-breakpoint")
		: sql.split(/;\s*\n/);
	return parts.map((part) => part.trim()).filter((part) => part.length > 0);
}
