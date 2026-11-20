/// <reference types="node" />
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vite-plus/test";
import { createDbClient } from "../../client";
import {
	billingCreditConsumptions,
	billingUsageCharges,
	billingUsageReservations,
} from "../../schema/billing";
import { createD1Facade } from "../../test/d1-facade";
import { schemaDdl } from "../../test/schema-ddl";
import { sumRunCredits, sumRunCreditsByRun } from "./spending";

const from = "2026-10-01T00:00:00.000Z";
const to = "2026-11-01T00:00:00.000Z";
function fixture() {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec("PRAGMA foreign_keys = OFF");
	sqlite.exec(
		schemaDdl(
			billingUsageReservations,
			billingUsageCharges,
			billingCreditConsumptions,
		),
	);
	sqlite.exec(`INSERT INTO billing_usage_reservations(id,organization_id,plan_version_id,source,provider,model,period_start,period_end,run_id,idempotency_key,expires_at,created_at,updated_at)
	 VALUES('hold','own','plan','kernel','fictional','fictional-model','${from}','${to}','own-run','hold','${to}','${from}','${from}'),
	 ('second-hold','own','plan','kernel','fictional','fictional-model','${from}','${to}','second-run','second','${to}','${from}','${from}'),
	 ('foreign-hold','other','plan','kernel','fictional','fictional-model','${from}','${to}','other-run','foreign','${to}','${from}','${from}');`);
	/** A settled charge and, unless `consumed` is false, its AI consumption. */
	function charge(
		id: string,
		credits: number,
		{
			org = "own",
			hold = "hold" as string | null,
			consumed = true,
			kind = "ai",
		} = {},
	) {
		sqlite
			.prepare(`INSERT INTO billing_usage_charges(id,organization_id,reservation_id,usage_period_id,provider,model,source,credit_applied_micros,customer_charge_micros,provider_cost_micros,rate_card_version,occurred_at,metadata,created_at)
		 VALUES(?,?,?,'period','fictional','fictional-model','kernel',999,999,999,'price-1','${from}','{}','${from}')`)
			.run(id, org, hold);
		if (!consumed) return;
		sqlite
			.prepare(`INSERT INTO billing_credit_consumptions(id,organization_id,kind,source_ref,period_start,period_end,credits,included_credits,top_up_credits,payg_credits,payg_charge_micros,created_at)
		 VALUES(?,?,?,?,'${from}','${to}',?,?,0,0,0,'${from}')`)
			.run(`consumption-${id}`, org, kind, id, credits, credits);
	}
	return { sqlite, db: createDbClient(createD1Facade(sqlite)), charge };
}

describe("credits per run", () => {
	it("scopes workspace chat charges to its settled turns and billing period", async () => {
		const f = fixture();
		try {
			const workspaceChat = { workspaceId: "own-workspace", periodStart: from };
			const setMetadata = f.sqlite.prepare(
				"UPDATE billing_usage_reservations SET metadata = ? WHERE id = ?",
			);
			setMetadata.run(
				JSON.stringify({
					source: "workspace_chat",
					workspaceId: "own-workspace",
				}),
				"hold",
			);
			setMetadata.run(
				JSON.stringify({
					source: "workspace_chat",
					workspaceId: "other-workspace",
				}),
				"second-hold",
			);
			f.charge("own-charge", 3);
			f.charge("outside-period", 4);
			f.charge("unsettled-charge", 20, { consumed: false });
			f.charge("other-workspace", 100, { hold: "second-hold" });
			f.sqlite
				.prepare(
					"UPDATE billing_credit_consumptions SET period_start = ? WHERE source_ref = ?",
				)
				.run("2026-09-01T00:00:00.000Z", "outside-period");
			const input = {
				organizationId: "own",
				runIds: ["own-run", "second-run"],
				workspaceChat,
			};
			expect(await sumRunCredits(f.db, input)).toEqual({
				credits: 3,
				chargeCount: 1,
			});
			setMetadata.run(
				JSON.stringify({ source: "home_chat", workspaceId: "own-workspace" }),
				"hold",
			);
			expect(await sumRunCredits(f.db, input)).toEqual({
				credits: 0,
				chargeCount: 0,
			});
		} finally {
			f.sqlite.close();
		}
	});

	it("sums AI credit consumptions per run and leaves runs without any out", async () => {
		const f = fixture();
		try {
			f.charge("first", 3);
			f.charge("second", 4);
			f.charge("other-run-call", 7, { hold: "second-hold" });
			// A charge with no consumption is not a credit draw.
			f.charge("unconsumed", 50, { consumed: false });
			// A code-run consumption never matches a charge's run.
			f.charge("code", 9, { kind: "code_run" });
			f.charge("foreign", 11, { org: "other", hold: "foreign-hold" });
			const byRun = await sumRunCreditsByRun(f.db, {
				organizationId: "own",
				runIds: ["own-run", "second-run", "other-run", "no-such-run"],
			});
			expect(Object.fromEntries(byRun)).toEqual({
				"own-run": { credits: 7, chargeCount: 2 },
				"second-run": { credits: 7, chargeCount: 1 },
			});
			expect(
				(await sumRunCreditsByRun(f.db, { organizationId: "own", runIds: [] }))
					.size,
			).toBe(0);
		} finally {
			f.sqlite.close();
		}
	});

	it("sums a conversation's credits across runs, scoped to the organization", async () => {
		const f = fixture();
		try {
			f.charge("first", 3);
			f.charge("second", 4);
			f.charge("foreign", 11, { org: "other", hold: "foreign-hold" });
			f.charge("orphan", 5, { hold: null });
			expect(
				await sumRunCredits(f.db, {
					organizationId: "own",
					runIds: ["own-run", "other-run", "own-run"],
				}),
			).toEqual({ credits: 7, chargeCount: 2 });
			expect(
				await sumRunCredits(f.db, {
					organizationId: "own",
					runIds: ["no-such-run"],
				}),
			).toEqual({ credits: 0, chargeCount: 0 });
			// More run ids than one statement may bind still sums once.
			expect(
				await sumRunCredits(f.db, {
					organizationId: "own",
					runIds: [
						...Array.from({ length: 150 }, (_, index) => `run-${index}`),
						"own-run",
					],
				}),
			).toEqual({ credits: 7, chargeCount: 2 });
		} finally {
			f.sqlite.close();
		}
	});
});
