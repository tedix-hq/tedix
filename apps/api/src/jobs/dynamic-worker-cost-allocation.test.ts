import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vite-plus/test";
import { createDbClient } from "@tedix/db/client";
import { billingProviderUsage } from "@tedix/db/schema/billing";
import { createD1Facade } from "@tedix/db/test/d1-facade";
import { schemaDdl } from "@tedix/db/test/schema-ddl";
import { allocateDynamicWorkerCostForPeriod } from "./dynamic-worker-cost-allocation";

it("allocates a full day across organizations, retains missing identities, and replays exactly", async () => {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec(schemaDdl(billingProviderUsage));
	const db = createDbClient(createD1Facade(sqlite));
	const period = {
		periodStart: "2026-11-01T00:00:00.000Z",
		periodEnd: "2026-11-02T00:00:00.000Z",
		totalCostMicros: 73_800_000,
		billedQuantity: 36900,
		evidenceRef: "fixture:daily-worker-charge",
	};
	const insert = sqlite.prepare(`INSERT INTO billing_provider_usage
  (id, organization_id, provider, model, usage_kind, unit, quantity, occurred_at, metadata, created_at)
  VALUES (?, ?, 'cloudflare-dynamic-workers', 'dynamic-worker', 'other', 'units', 1, ?, ?, '2026-11-01T00:00:00.000Z')`);
	try {
		for (let index = 0; index < 36593; index++)
			insert.run(
				`row-${String(index).padStart(5, "0")}`,
				index % 2 ? "org-a" : "org-b",
				period.periodStart,
				JSON.stringify({
					identity: "anonymous",
					surface: "gateway_model_code",
				}),
			);
		insert.run("named", "org-a", period.periodStart, '{"identity":"named"}');
		insert.run(
			"unattributed",
			null,
			period.periodStart,
			'{"identity":"anonymous"}',
		);
		insert.run(
			"next-day",
			"org-a",
			period.periodEnd,
			'{"identity":"anonymous"}',
		);
		const result = await allocateDynamicWorkerCostForPeriod(db, period);
		expect(result).toEqual({
			allocatedMicros: 73_186_000,
			unallocatedMicros: 614_000,
			rows: 36593,
		});
		expect(
			sqlite
				.prepare(
					"SELECT organization_id, SUM(provider_cost_micros) AS cost FROM billing_provider_usage WHERE provider_cost_quality = 'provider_reconciled' GROUP BY organization_id ORDER BY organization_id",
				)
				.all(),
		).toEqual([
			{ organization_id: "org-a", cost: 36_592_000 },
			{ organization_id: "org-b", cost: 36_594_000 },
		]);
		const before = sqlite.prepare("SELECT total_changes() AS n").get();
		expect(await allocateDynamicWorkerCostForPeriod(db, period)).toEqual(
			result,
		);
		expect(sqlite.prepare("SELECT total_changes() AS n").get()).toEqual(before);
		expect(
			sqlite
				.prepare(
					"SELECT COUNT(*) AS n FROM billing_provider_usage WHERE provider_cost_quality = 'estimated'",
				)
				.get(),
		).toEqual({ n: 3 });
		// An absent provider quantity cannot be treated as full cost coverage.
		expect(
			await allocateDynamicWorkerCostForPeriod(db, {
				...period,
				billedQuantity: null,
			}),
		).toEqual({ allocatedMicros: 0, unallocatedMicros: 73_800_000, rows: 0 });
	} finally {
		sqlite.close();
	}
});
