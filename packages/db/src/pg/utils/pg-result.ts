/**
 * Affected-rows reader for Postgres statement results. The pg-plane analogue
 * of `utils/d1-result.getAffectedRows`: Drizzle pg drivers expose `rowCount`
 * (node-postgres / pglite sessions); fall back to `affectedRows` and row
 * arrays so a `RETURNING` result counts its rows too.
 */

export type PgStatementResult = {
	rowCount?: number | null;
	affectedRows?: number | null;
	rows?: unknown[];
};

export function getAffectedRows(result: unknown): number {
	const res = result as PgStatementResult | undefined;
	if (!res) return 0;
	if (typeof res.rowCount === "number") return res.rowCount;
	if (typeof res.affectedRows === "number") return res.affectedRows;
	if (Array.isArray(res.rows)) return res.rows.length;
	if (Array.isArray(result)) return result.length;
	return 0;
}
