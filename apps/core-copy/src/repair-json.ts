/**
 * Finds jsonb values stored as a JSON string whose text is itself a JSON array
 * or object (double encoding), and with apply, stores the decoded value.
 * Strings that are not valid JSON arrays or objects are left alone.
 */
import type { PgQuery } from "../../../scripts/db/core-copy.ts";

const ident = /^[a-z_][a-z0-9_]*$/;

export async function repairJsonStrings(
	query: PgQuery,
	options: { dryRun: boolean; table?: string },
) {
	const columns = await query(
		`SELECT table_name, column_name FROM information_schema.columns
		WHERE table_schema = 'public' AND data_type = 'jsonb'
		${options.table ? "AND table_name = $1" : ""}
		ORDER BY table_name, column_name`,
		options.table ? [options.table] : [],
	);
	const found: { table: string; column: string; rows: number }[] = [];
	for (const row of columns.rows as {
		table_name: string;
		column_name: string;
	}[]) {
		if (!ident.test(row.table_name) || !ident.test(row.column_name)) continue;
		const c = `"${row.column_name}"`;
		const where = `jsonb_typeof(${c}) = 'string' AND (${c} #>> '{}') ~ '^\\s*[\\[{]' AND pg_input_is_valid(${c} #>> '{}', 'jsonb')`;
		const result = options.dryRun
			? await query(
					`SELECT count(*)::int AS n FROM "${row.table_name}" WHERE ${where}`,
					[],
				)
			: await query(
					`WITH fixed AS (UPDATE "${row.table_name}" SET ${c} = (${c} #>> '{}')::jsonb WHERE ${where} RETURNING 1) SELECT count(*)::int AS n FROM fixed`,
					[],
				);
		const n = Number((result.rows[0] as { n?: number })?.n ?? 0);
		if (n)
			found.push({ table: row.table_name, column: row.column_name, rows: n });
	}
	return { checked: columns.rows.length, found, dryRun: options.dryRun };
}
