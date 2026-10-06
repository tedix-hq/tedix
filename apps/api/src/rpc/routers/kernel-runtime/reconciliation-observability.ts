export interface RunReconciliationRow {
	id: string;
	status: string;
	updatedAt?: string | null;
}

export interface RunSetReconciliationSummary {
	changedRows: number;
	statusTransitions: Record<string, number>;
	oldestChangedAgeMs: number | null;
}

/** Structured, bounded diagnostics for canonical read-time reconciliation. */
export function summarizeRunSetReconciliation(
	before: readonly RunReconciliationRow[],
	after: readonly RunReconciliationRow[],
	nowMs = Date.now(),
): RunSetReconciliationSummary | null {
	const previous = new Map(before.map((row) => [row.id, row]));
	let changedRows = 0;
	let oldestChangedAgeMs: number | null = null;
	const statusTransitions: Record<string, number> = {};
	for (const row of after) {
		const prior = previous.get(row.id);
		if (
			!prior ||
			(prior.status === row.status && prior.updatedAt === row.updatedAt)
		) {
			continue;
		}
		changedRows += 1;
		const transition = `${prior.status}->${row.status}`;
		statusTransitions[transition] = (statusTransitions[transition] ?? 0) + 1;
		const startedAt = Date.parse(prior.updatedAt ?? "");
		if (Number.isFinite(startedAt)) {
			const age = Math.max(0, nowMs - startedAt);
			oldestChangedAgeMs = Math.max(oldestChangedAgeMs ?? 0, age);
		}
	}
	return changedRows > 0
		? { changedRows, statusTransitions, oldestChangedAgeMs }
		: null;
}
