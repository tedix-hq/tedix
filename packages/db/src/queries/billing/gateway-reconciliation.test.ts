import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vite-plus/test";
import { createDbQueryClient } from "../../query-client";
import { billingUsageCharges } from "../../schema/billing";
import {
	type NewBillingGatewayReconciliationRow,
	billingGatewayReconciliations,
} from "../../schema/billing-gateway-reconciliations";
import { createD1Facade } from "../../test/d1-facade";
import { schemaDdl } from "../../test/schema-ddl";
import {
	getLatestGatewayReconciliation,
	replaceGatewayReconciliationDay,
	sumLedgerCostByProviderModel,
} from "./gateway-reconciliation";

function fixture() {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec("PRAGMA foreign_keys = OFF");
	for (const table of [billingUsageCharges, billingGatewayReconciliations])
		sqlite.exec(schemaDdl(table));
	return createDbQueryClient(createD1Facade(sqlite));
}

let seq = 0;
function charge(
	patch: Partial<typeof billingUsageCharges.$inferInsert>,
): typeof billingUsageCharges.$inferInsert {
	seq++;
	return {
		id: `charge-${seq}`,
		organizationId: "org-1",
		usagePeriodId: "period-1",
		source: "operator",
		reservationId: `res-${seq}`,
		gatewayLogId: `log-${seq}`,
		provider: "azure-openai",
		model: "openai/gpt-6.1-sol",
		occurredAt: "2026-11-18T10:00:00.000Z",
		providerCostMicros: 1_000_000,
		metadata: { gatewayId: "tedix-llm-production" },
		...patch,
	} as typeof billingUsageCharges.$inferInsert;
}

function row(
	patch: Partial<NewBillingGatewayReconciliationRow>,
): NewBillingGatewayReconciliationRow {
	seq++;
	return {
		id: `rec-${seq}`,
		day: "2026-11-18",
		gatewayId: "tedix-llm-production",
		provider: "workers-ai",
		model: "",
		ledgerCostMicros: 0,
		gatewayCostMicros: 0,
		differenceMicros: 0,
		status: "matched",
		computedAt: "2026-11-19T02:00:00.000Z",
		...patch,
	};
}

describe("gateway reconciliation queries", () => {
	it("sums one day of ledger cost per provider and model for the gateway", async () => {
		const db = fixture();
		for (const value of [
			charge({}),
			charge({ providerCostMicros: 2_500_000 }),
			charge({
				provider: "workers-ai",
				model: "@cf/moonshotai/kimi-k2.7-code",
			}),
			// Another gateway, the previous day, and the next day are excluded.
			charge({ metadata: { gatewayId: "default" } }),
			charge({ occurredAt: "2026-11-17T23:59:59.999Z" }),
			charge({ occurredAt: "2026-11-19T00:00:00.000Z" }),
			// No recorded gateway still counts, so it can surface as ledger-only.
			charge({ provider: "typesafe", model: "typesafe/jev", metadata: {} }),
		])
			await db.insert(billingUsageCharges).values(value);

		const rows = await sumLedgerCostByProviderModel(db, {
			gatewayId: "tedix-llm-production",
			sinceInclusive: "2026-11-18T00:00:00.000Z",
			untilExclusive: "2026-11-19T00:00:00.000Z",
		});

		expect(rows.sort((a, b) => a.provider.localeCompare(b.provider))).toEqual([
			{
				provider: "azure-openai",
				model: "openai/gpt-6.1-sol",
				costMicros: 3_500_000,
				rowCount: 2,
			},
			{
				provider: "typesafe",
				model: "typesafe/jev",
				costMicros: 1_000_000,
				rowCount: 1,
			},
			{
				provider: "workers-ai",
				model: "@cf/moonshotai/kimi-k2.7-code",
				costMicros: 1_000_000,
				rowCount: 1,
			},
		]);
	});

	it("replaces a gateway-day and reads back only the latest day", async () => {
		const db = fixture();
		await replaceGatewayReconciliationDay(db, {
			day: "2026-11-17",
			gatewayId: "tedix-llm-production",
			rows: [row({ day: "2026-11-17", status: "drift" })],
		});
		// More rows than one insert chunk, to exercise chunking.
		const models = Array.from({ length: 12 }, (_, i) =>
			row({ model: `@cf/model-${String(i).padStart(2, "0")}` }),
		);
		await replaceGatewayReconciliationDay(db, {
			day: "2026-11-18",
			gatewayId: "tedix-llm-production",
			rows: [row({ model: "@cf/stale" }), ...models],
		});
		// A re-run drops models that no longer appear.
		await replaceGatewayReconciliationDay(db, {
			day: "2026-11-18",
			gatewayId: "tedix-llm-production",
			rows: [row({}), ...models],
		});

		const latest = await getLatestGatewayReconciliation(db);
		expect(latest).toHaveLength(13);
		expect(latest.every((r) => r.day === "2026-11-18")).toBe(true);
		expect(latest[0]?.model).toBe("");
		expect(latest.some((r) => r.model === "@cf/stale")).toBe(false);
	});

	it("rejects rows that belong to another day", async () => {
		const db = fixture();
		await expect(
			replaceGatewayReconciliationDay(db, {
				day: "2026-11-18",
				gatewayId: "tedix-llm-production",
				rows: [row({ day: "2026-11-17" })],
			}),
		).rejects.toThrow("does not belong");
	});
});
