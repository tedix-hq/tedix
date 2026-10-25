import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vite-plus/test";
import { createDbClient } from "../../client";
import {
	billingUsageCharges,
	billingUsageReservations,
} from "../../schema/billing";
import { createD1Facade } from "../../test/d1-facade";
import { schemaDdl } from "../../test/schema-ddl";
import {
	listMonetaryInferenceSpending,
	sumRunInferenceCharges,
} from "./spending";

const from = "2026-10-01T00:00:00.000Z";
const to = "2026-11-01T00:00:00.000Z";
function fixture() {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec("PRAGMA foreign_keys = OFF");
	sqlite.exec(schemaDdl(billingUsageReservations, billingUsageCharges));
	sqlite.exec(`INSERT INTO billing_usage_reservations(id,organization_id,plan_version_id,source,provider,model,period_start,period_end,run_id,idempotency_key,expires_at,created_at,updated_at)
	 VALUES('hold','own','plan','kernel','fictional','fictional-model','${from}','${to}','own-run','hold','${to}','${from}','${from}'),
	 ('foreign-hold','other','plan','kernel','fictional','fictional-model','${from}','${to}','other-run','foreign','${to}','${from}','${from}');`);
	const quote = {
		monetaryQuote: {
			schemaVersion: 1,
			rateSnapshot: {
				currency: "USD",
				customerCurrency: "EUR",
				creditValueMicros: 10000,
			},
		},
	};
	function charge(
		id: string,
		org = "own",
		hold: string | null = "hold",
		metadata: object = quote,
		at = from,
	) {
		sqlite
			.prepare(`INSERT INTO billing_usage_charges(id,organization_id,reservation_id,usage_period_id,provider,model,source,credit_applied_micros,customer_charge_micros,provider_cost_micros,rate_card_version,occurred_at,metadata,created_at)
		 VALUES(?,?,?,'period','fictional','fictional-model','kernel',40,10,999,'price-1',?,?,'${from}')`)
			.run(id, org, hold, at, JSON.stringify(metadata));
	}
	return { sqlite, db: createDbClient(createD1Facade(sqlite)), charge };
}
describe("settled monetary spending", () => {
	it("reads actual customer components once, excludes legacy/provider estimates and other tenants", async () => {
		const f = fixture();
		try {
			f.charge("monetary");
			f.charge("foreign", "other", "foreign-hold");
			f.charge("legacy", "own", "hold", {});
			f.charge("outside", "own", "hold", undefined, to);
			const r = await listMonetaryInferenceSpending(f.db, {
				organizationId: "own",
				from,
				to,
				limit: 10,
			});
			expect(r).toMatchObject({
				hasMore: false,
				rows: [
					{
						id: "monetary",
						runId: "own-run",
						creditAppliedMicros: 40,
						customerChargeMicros: 10,
						creditValueMicros: 10000,
					},
				],
			});
			expect(r.rows).toHaveLength(1);
			expect(r.rows[0]).not.toHaveProperty("providerCostMicros");
		} finally {
			f.sqlite.close();
		}
	});
	it("does not leak a foreign run through a corrupt reservation link; retains unlinked charges and reports a bounded page", async () => {
		const f = fixture();
		try {
			f.charge("z-orphan", "own", "foreign-hold");
			f.charge("a-own");
			const r = await listMonetaryInferenceSpending(f.db, {
				organizationId: "own",
				from,
				to,
				limit: 1,
			});
			expect(r.hasMore).toBe(true);
			expect(r.rows).toHaveLength(1);
			expect(r.rows[0]).toMatchObject({
				id: "z-orphan",
				runId: null,
				traceId: null,
			});
		} finally {
			f.sqlite.close();
		}
	});
	it("sums a conversation's settled EUR charges by run, scoped to the organization", async () => {
		const f = fixture();
		try {
			f.charge("monetary");
			f.charge("second");
			f.charge("legacy", "own", "hold", {});
			f.charge("foreign", "other", "foreign-hold");
			f.charge("orphan", "own", null);
			expect(
				await sumRunInferenceCharges(f.db, {
					organizationId: "own",
					runIds: ["own-run", "other-run", "own-run"],
				}),
			).toEqual({ chargedMicros: 100, chargeCount: 2 });
			expect(
				await sumRunInferenceCharges(f.db, {
					organizationId: "own",
					runIds: ["no-such-run"],
				}),
			).toEqual({ chargedMicros: 0, chargeCount: 0 });
			expect(
				await sumRunInferenceCharges(f.db, {
					organizationId: "own",
					runIds: [],
				}),
			).toEqual({ chargedMicros: 0, chargeCount: 0 });
			// More run ids than one statement may bind still sums once.
			expect(
				await sumRunInferenceCharges(f.db, {
					organizationId: "own",
					runIds: [
						...Array.from({ length: 150 }, (_, index) => `run-${index}`),
						"own-run",
					],
				}),
			).toEqual({ chargedMicros: 100, chargeCount: 2 });
		} finally {
			f.sqlite.close();
		}
	});
});
