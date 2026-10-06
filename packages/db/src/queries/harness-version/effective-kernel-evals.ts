/**
 * Eval rows are immutable. A correction writes a newer row for the same Home
 * run, so consumers must use one effective outcome per original run.
 * Input is newest-first (created_at, id); rows without a run id remain distinct.
 */
export function effectiveKernelEvalRows<
	T extends {
		id?: string;
		metadata: Record<string, unknown> | null;
	},
>(rows: readonly T[], limit: number): T[] {
	const correctedRunIds = new Set(
		rows
			.filter((row) => row.metadata?.source === "kernel-route-correction")
			.map((row) => row.metadata?.runId)
			.filter((id): id is string => typeof id === "string"),
	);
	const seen = new Set<string>();
	const effective: T[] = [];
	for (const row of rows) {
		const runId =
			typeof row.metadata?.runId === "string" ? row.metadata.runId : null;
		// A delayed base/backfill must never restore a positive after a
		// correction revision, even if the base row has a later created_at.
		if (
			runId &&
			correctedRunIds.has(runId) &&
			row.metadata?.source !== "kernel-route-correction"
		)
			continue;
		const key = runId ?? row.id ?? null;
		if (key && seen.has(key)) continue;
		if (key) seen.add(key);
		effective.push(row);
		if (effective.length >= limit) break;
	}
	return effective;
}
