import type { BillingGatewayReconciliationRow } from "@tedix/db/schema/billing-gateway-reconciliations";
import { describe, expect, it } from "vite-plus/test";
import {
	buildHealthDigest,
	formatGatewayReconciliation,
	gatewayReconciliationHealthConditions,
	reconcileHealthConditions,
} from "./health-digest";

const NOW_MS = Date.parse("2026-11-19T08:00:00.000Z");

function row(
	patch: Partial<BillingGatewayReconciliationRow>,
): BillingGatewayReconciliationRow {
	const ledger = patch.ledgerCostMicros ?? 0;
	const gateway = patch.gatewayCostMicros ?? 0;
	return {
		id: crypto.randomUUID(),
		day: "2026-11-18",
		gatewayId: "test-llm-gateway",
		provider: "workers-ai",
		model: "",
		ledgerCostMicros: ledger,
		gatewayCostMicros: gateway,
		differenceMicros: ledger - gateway,
		ledgerRowCount: 0,
		gatewayRequestCount: 0,
		coverage: {
			missingCallCount: 0,
			missingCostMicros: 0,
			missingUnpricedCallCount: 0,
			tokenCheckedCallCount: 1,
			tokenMismatchCallCount: 0,
			tokenUnknownCallCount: 0,
			platformOverheadCallCount: 0,
			platformOverheadCostMicros: 0,
		},
		status: "matched",
		computedAt: "2026-11-19T02:00:00.000Z",
		...patch,
	};
}

describe("gateway reconciliation health conditions", () => {
	it("ignores pricing differences, token mismatches, and historical alerts below the coverage thresholds", () => {
		const matched = row({
			ledgerCostMicros: 60300000,
			gatewayCostMicros: 67160000,
			gatewayRequestCount: 1819,
		});
		expect(
			gatewayReconciliationHealthConditions(
				[
					matched,
					row({ status: "drift", coverage: null }),
					{
						...matched,
						status: "drift",
						coverage: {
							...matched.coverage!,
							missingCallCount: 4,
							missingCostMicros: 12372,
						},
					},
					row({
						coverage: { ...matched.coverage!, tokenMismatchCallCount: 1 },
					}),
				],
				NOW_MS,
			),
		).toEqual([]);
	});
	it("alerts once per provider for real misses and includes overhead in the digest", () => {
		const covered = row({});
		const total = row({
			provider: "azure-openai",
			status: "drift",
			gatewayRequestCount: 1000,
			coverage: {
				...covered.coverage!,
				missingCallCount: 69,
				missingCostMicros: 1100000,
			},
		});
		const overhead = row({
			coverage: {
				...covered.coverage!,
				platformOverheadCallCount: 1800,
				platformOverheadCostMicros: 1070000,
			},
		});
		const rows = [
			total,
			row({ ...total, model: "openai/gpt-6.1-sol" }),
			overhead,
		];
		const conditions = gatewayReconciliationHealthConditions(rows, NOW_MS);
		expect(conditions).toHaveLength(1);
		expect(conditions[0]?.detail).toContain(
			"69 Gateway calls without charges, gateway estimate $1.10",
		);
		const digest = buildHealthDigest(
			reconcileHealthConditions(conditions, [], "2026-11-19T08:00:00.000Z"),
			{
				isWeeklyHeartbeat: false,
				nowIso: "2026-11-19T08:00:00.000Z",
				gatewayReconciliation: rows,
			},
		);
		expect(digest?.subject).toContain("ledger misses");
		expect(digest?.text).toContain("69 missing calls, gateway estimate $1.10");
		expect(formatGatewayReconciliation(rows)).toContain(
			"platform overhead 1800 calls, $1.07",
		);
	});
	it("reports stale reconciliation instead of resolving open drift", () => {
		expect(
			gatewayReconciliationHealthConditions(
				[row({ day: "2026-11-15" })],
				NOW_MS,
			).map((c) => c.key),
		).toEqual(["billing-gateway-reconciliation-stale"]);
	});
});
