import type { BillingLedgerOutput } from "@tedix/api-contract/contracts/org-usage";
import { describe, expect, it } from "vite-plus/test";
import { groupRecordedRunCosts } from "./billing-run-costs";
function row(id: string, runId: string | null, amount: number | null) {
	return {
		id,
		runId,
		snapshotAt: "2026-10-11T10:00:00Z",
		provider: "openai",
		dataQuality: amount === null ? "quarantined_no_pricing" : "ok",
		estimatedCostUsd: amount,
		costBasis: amount === null ? "unknown" : "governed_estimate",
		totalTokens: 100,
	} as BillingLedgerOutput["rows"][number];
}
describe("returned run cost records", () => {
	it("does not count repeated ledger identities twice or merge unlinked calls into a run", () => {
		const first = row("a", "run-a", 0.5);
		const result = groupRecordedRunCosts([
			first,
			first,
			row("b", "run-a", 0.25),
			row("c", null, 0),
		]);
		expect(result).toHaveLength(2);
		expect(result[0]!.callCount).toBe(2);
		expect(result[0]!.reading).toMatchObject({ kind: "priced", costUsd: 0.75 });
		expect(result[1]!).toMatchObject({
			runId: null,
			callCount: 1,
			reading: { kind: "zero" },
		});
	});
	it("keeps an unpriced record a caution state, not zero", () => {
		expect(
			groupRecordedRunCosts([row("a", "run-a", null)])[0]!.reading.kind,
		).not.toBe("zero");
	});
});
