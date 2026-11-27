/**
 * Rollback replay: writes the changes Postgres recorded after the switch
 * (cutover_changes, filled by the cutover_capture trigger) back into D1, in
 * the order they happened, so D1 can take traffic again.
 *
 * Inserts and updates become upserts on the table's keys, never INSERT OR
 * REPLACE: with D1's foreign keys a replace deletes the old row first and
 * would cascade into its children. Deletes delete by key. Columns the copy
 * blanked (secrets kept only in D1) are never overwritten from Postgres.
 */
import type { PgQuery } from "../../../scripts/db/core-copy.ts";
import { planTable, type CoreCopyTable } from "./plan.ts";
import type { ProgressStore } from "./store.ts";

type Scalar = string | number | null;
export interface D1Statement {
	sql: string;
	params: Scalar[];
}

export interface ReplayPorts {
	query: PgQuery;
	writeD1(statements: D1Statement[]): Promise<void>;
	store: ProgressStore;
}

export interface ReplayResult {
	applied: number;
	skipped: { table: string; count: number }[];
	cursor: number;
	done: boolean;
	dryRun: boolean;
	sample?: D1Statement[];
}

const quote = (name: string) => {
	if (!/^[a-z_][a-z0-9_]*$/.test(name))
		throw new Error(`Invalid identifier: ${name}`);
	return `"${name}"`;
};

function d1Value(
	kind: CoreCopyTable["columns"][string],
	value: unknown,
): Scalar {
	if (value === null || value === undefined) return null;
	switch (kind) {
		case "json":
			return JSON.stringify(value);
		case "boolean":
			return value === true || value === "t" || value === 1 ? 1 : 0;
		case "epoch":
			return Math.floor(Date.parse(String(value)) / 1000);
		case "timestamp":
			return new Date(Date.parse(String(value))).toISOString();
		default:
			if (typeof value === "object") return JSON.stringify(value);
			if (typeof value === "boolean") return value ? 1 : 0;
			return value as Scalar;
	}
}

/** One D1 statement for one captured change. */
export function replayStatement(
	entry: CoreCopyTable,
	operation: string,
	row: Record<string, unknown>,
): D1Statement {
	const d1Column = (column: string) =>
		column === entry.sourceRowid ? "rowid" : column;
	if (operation === "DELETE") {
		return {
			sql: `DELETE FROM ${quote(entry.table)} WHERE ${entry.keys.map((k) => `${quote(d1Column(k))} = ?`).join(" AND ")}`,
			params: entry.keys.map((k) => d1Value(entry.columns[k]!, row[k])),
		};
	}
	if (operation !== "INSERT" && operation !== "UPDATE")
		throw new Error(`Unknown captured operation ${operation}`);
	const columns = Object.keys(entry.columns).filter((c) => c in row);
	const blank = new Set(Object.keys(entry.blank ?? {}));
	const updates = columns.filter(
		(c) => !entry.keys.includes(c) && !blank.has(c) && c !== entry.sourceRowid,
	);
	const conflict = updates.length
		? `DO UPDATE SET ${updates.map((c) => `${quote(c)} = excluded.${quote(c)}`).join(", ")}`
		: "DO NOTHING";
	return {
		sql: `INSERT INTO ${quote(entry.table)} (${columns.map((c) => quote(d1Column(c))).join(", ")}) VALUES (${columns.map(() => "?").join(", ")}) ON CONFLICT (${entry.keys.map((k) => quote(d1Column(k))).join(", ")}) ${conflict}`,
		params: columns.map((c) => d1Value(entry.columns[c]!, row[c])),
	};
}

/**
 * Replays up to `limit` captured changes after the stored cursor. A dry run
 * builds the statements and returns a sample without writing D1 or moving
 * the cursor.
 */
export async function replayChanges(
	ports: ReplayPorts,
	options: { limit?: number; dryRun?: boolean } = {},
): Promise<ReplayResult> {
	const limit = Math.min(Math.max(options.limit ?? 200, 1), 500);
	const dryRun = options.dryRun ?? false;
	const cursor = await ports.store.replayCursor();
	const result = await ports.query(
		`SELECT id, table_name, operation, row FROM cutover_changes WHERE id > $1 ORDER BY id LIMIT $2`,
		[cursor, limit],
	);
	const rows = result.rows as {
		id: number | string;
		table_name: string;
		operation: string;
		row: Record<string, unknown> | string;
	}[];
	const statements: D1Statement[] = [];
	const skipped = new Map<string, number>();
	let last = cursor;
	for (const change of rows) {
		last = Number(change.id);
		const entry = planTable(change.table_name);
		if (!entry) {
			skipped.set(change.table_name, (skipped.get(change.table_name) ?? 0) + 1);
			continue;
		}
		const row =
			typeof change.row === "string" ? JSON.parse(change.row) : change.row;
		statements.push(replayStatement(entry, change.operation, row));
	}
	if (!dryRun && statements.length) await ports.writeD1(statements);
	if (!dryRun) await ports.store.setReplayCursor(last);
	return {
		applied: dryRun ? 0 : statements.length,
		skipped: [...skipped].map(([table, count]) => ({ table, count })),
		cursor: dryRun ? cursor : last,
		done: rows.length < limit,
		dryRun,
		...(dryRun ? { sample: statements.slice(0, 5) } : {}),
	};
}
