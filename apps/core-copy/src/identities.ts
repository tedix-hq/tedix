/**
 * Moves every identity sequence in the public schema up to its column's
 * current maximum. The copy writes source keys explicitly, so a later delta
 * can land rows above the value Postgres had already handed out; new inserts
 * then collide on the key. A dry run reports the gaps without changing them.
 */
import type { PgQuery } from "../../../scripts/db/core-copy.ts";

export async function syncIdentitySequences(query: PgQuery, dryRun: boolean) {
	const columns = await query(
		`SELECT table_name, column_name, pg_get_serial_sequence(quote_ident(table_name), column_name) AS sequence
		FROM information_schema.columns
		WHERE table_schema = 'public' AND is_identity = 'YES'
		ORDER BY table_name, column_name`,
		[],
	);
	const behind: {
		table: string;
		column: string;
		max: number;
		last: number | null;
	}[] = [];
	for (const row of columns.rows as {
		table_name: string;
		column_name: string;
		sequence: string | null;
	}[]) {
		if (
			!row.sequence ||
			!/^[a-z_][a-z0-9_]*$/.test(row.table_name) ||
			!/^[a-z_][a-z0-9_]*$/.test(row.column_name)
		)
			continue;
		const state = await query(
			`SELECT (SELECT max("${row.column_name}") FROM "${row.table_name}")::bigint AS max,
				(SELECT CASE WHEN is_called THEN last_value ELSE last_value - 1 END FROM ${row.sequence}) AS last`,
			[],
		);
		const max = Number(state.rows[0]?.max ?? 0);
		const last =
			state.rows[0]?.last == null ? null : Number(state.rows[0].last);
		if (!max || (last !== null && last >= max)) continue;
		behind.push({ table: row.table_name, column: row.column_name, max, last });
		if (!dryRun)
			await query(`SELECT setval($1::regclass, $2::bigint, true)`, [
				row.sequence,
				max,
			]);
	}
	return { checked: columns.rows.length, behind, dryRun };
}
