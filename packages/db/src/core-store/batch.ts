/** The only driver-specific access to Drizzle's pinned prepared-query contract. */
interface BatchQuery {
	_prepare(): {
		getQuery(): { sql: string; params: unknown[] };
		mapper?: (rows: unknown[][]) => unknown;
		mode: string;
	};
}
export interface BatchResult {
	rows: unknown[][];
	count: number;
}
export type RunAtomicBatch = (
	statements: readonly { sql: string; params: unknown[] }[],
) => Promise<BatchResult[]>;
export function postgresBatch(run: RunAtomicBatch) {
	return async (queries: readonly BatchQuery[]): Promise<unknown[]> => {
		if (!queries.length) return [];
		const prepared = queries.map((query) => query._prepare());
		const results = await run(prepared.map((query) => query.getQuery()));
		if (results.length !== queries.length)
			throw new Error("Postgres batch result count mismatch");
		return results.map((result, index) => {
			const query = prepared[index]!;
			return query.mapper
				? query.mapper(result.rows)
				: { success: true, results: [], meta: { changes: result.count } };
		});
	};
}
