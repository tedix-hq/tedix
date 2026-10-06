/**
 * D1 result helper
 * Extracts affected row count from Drizzle D1 mutation results.
 *
 * Drizzle v2 on D1 returns a D1Result with `meta.changes` for mutations.
 * Some paths expose `rowsAffected` directly. This helper normalises both.
 */
export function getAffectedRows(result: unknown): number {
	if (result && typeof result === "object") {
		const r = result as Record<string, unknown>;
		const meta = r.meta as Record<string, unknown> | undefined;
		if (meta && typeof meta.changes === "number") return meta.changes;
		if (typeof r.rowsAffected === "number") return r.rowsAffected;
	}
	return 0;
}
