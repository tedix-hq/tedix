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
		gatewayId: "tedix-llm-production",
		provider: "workers-ai",
		model: "",
		ledgerCostMicros: ledger,
		gatewayCostMicros: gateway,
		differenceMicros: ledger - gateway,
		ledgerRowCount: 0,
		gatewayRequestCount: 0,
		status: "matched",
		computedAt: "2026-11-19T02:00:00.000Z",
		...patch,
	};
}

describe("gateway reconciliation health conditions", () => {
	it("is silent when every provider-day matches", () => {
		expect(
			gatewayReconciliationHealthConditions(
				[
					row({ ledgerCostMicros: 62_760_000, gatewayCostMicros: 62_760_000 }),
					row({
						model: "@cf/moonshotai/kimi-k2.7-code",
						ledgerCostMicros: 62_760_000,
						gatewayCostMicros: 62_760_000,
					}),
				],
				NOW_MS,
			),
		).toEqual([]);
		expect(gatewayReconciliationHealthConditions([], NOW_MS)).toEqual([]);
	});

	it("raises provider drift from the total and one-sided models together", () => {
		const conditions = gatewayReconciliationHealthConditions(
			[
				row({
					provider: "azure-openai",
					ledgerCostMicros: 34_490_000,
					gatewayCostMicros: 104_030_000,
					status: "drift",
				}),
				// Model-level drift does not alert on its own; the total does.
				row({
					provider: "azure-openai",
					model: "openai/gpt-6.1-sol",
					ledgerCostMicros: 34_490_000,
					gatewayCostMicros: 60_790_000,
					status: "drift",
				}),
				row({
					provider: "azure-openai",
					model: "openai/gpt-6-astra",
					gatewayCostMicros: 43_240_000,
					status: "gateway_only",
				}),
			],
			NOW_MS,
		);
		expect(conditions.map((c) => c.key)).toEqual([
			"billing-gateway-drift:azure-openai",
			"billing-gateway-one-sided",
		]);
		expect(conditions[0]).toMatchObject({ severity: "P2", bucketRank: 2 });
		expect(conditions[0]?.detail).toBe(
			"azure-openai cost drift on 2026-11-18: ledger $34.49 vs AI Gateway $104.03 (difference -$69.54)",
		);
		expect(conditions[1]?.detail).toContain(
			"azure-openai/openai/gpt-6-astra gateway $43.24",
		);
	});

	it("reports a stale reconciliation instead of resolving open drift", () => {
		const conditions = gatewayReconciliationHealthConditions(
			[row({ day: "2026-11-15", status: "drift" })],
			NOW_MS,
		);
		expect(conditions.map((c) => c.key)).toEqual([
			"billing-gateway-reconciliation-stale",
		]);
	});

	it("shows the latest provider totals in a sent digest", () => {
		const rows = [
			row({
				provider: "azure-openai",
				ledgerCostMicros: 34_490_000,
				gatewayCostMicros: 104_030_000,
				status: "drift",
			}),
			row({ ledgerCostMicros: 62_760_000, gatewayCostMicros: 62_760_000 }),
			row({ model: "@cf/x", ledgerCostMicros: 1, gatewayCostMicros: 1 }),
		];
		expect(formatGatewayReconciliation(rows)).toBe(
			"LEDGER VS AI GATEWAY (2026-11-18):\n" +
				"  • azure-openai: ledger $34.49, gateway $104.03, difference -$69.54 — drift\n" +
				"  • workers-ai: ledger $62.76, gateway $62.76, difference $0.00 — matched",
		);
		const result = reconcileHealthConditions(
			gatewayReconciliationHealthConditions(rows, NOW_MS),
			[],
			"2026-11-19T08:00:00.000Z",
		);
		const digest = buildHealthDigest(result, {
			isWeeklyHeartbeat: false,
			nowIso: "2026-11-19T08:00:00.000Z",
			gatewayReconciliation: rows,
		});
		expect(digest?.text).toContain("LEDGER VS AI GATEWAY (2026-11-18)");
		expect(digest?.subject).toContain("azure-openai cost drift");
	});
});
