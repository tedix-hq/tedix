import type { BillingLedgerOutput } from "@tedix/api-contract/contracts/org-usage";
import { callCostRunReading } from "@/lib/cost-reading";

/** Group only the returned ledger page. Never imply full-run or workspace allocation. */
export function groupRecordedRunCosts(rows: BillingLedgerOutput["rows"]) {
	const seen = new Set<string>();
	const groups = new Map<string | null, BillingLedgerOutput["rows"]>();
	for (const row of rows) {
		if (seen.has(row.id)) continue;
		seen.add(row.id);
		const group = groups.get(row.runId) ?? [];
		group.push(row);
		groups.set(row.runId, group);
	}
	return [...groups].map(([runId, calls]) => ({
		runId,
		callCount: calls.length,
		latestAt: calls.reduce(
			(latest, call) => (call.snapshotAt > latest ? call.snapshotAt : latest),
			"",
		),
		reading: callCostRunReading(calls),
	}));
}
