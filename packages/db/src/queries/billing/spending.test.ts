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
	/**
	 * A settled charge. A pre-wallet charge names its run through its D1 hold;
	 * a wallet-settled one (`hold: null`) carries the run and request metadata.
	 */
	function charge(
		id: string,
		credits: number,
		{
			org = "own",
			hold = "hold" as string | null,
			metadata = {} as Record<string, unknown>,
			occurredAt = from,
		} = {},
	) {
		sqlite
			.prepare(`INSERT INTO billing_usage_charges(id,organization_id,reservation_id,usage_period_id,provider,model,source,credit_applied_micros,customer_charge_micros,provider_cost_micros,credits,rate_card_version,occurred_at,metadata,created_at)
		 VALUES(?,?,?,'period','fictional','fictional-model','kernel',999,999,999,?,'price-1',?,?,'${from}')`)
			.run(id, org, hold, credits, occurredAt, JSON.stringify(metadata));
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
			f.charge("outside-period", 4, {
				occurredAt: "2026-09-01T00:00:00.000Z",
			});
			f.charge("other-workspace", 100, { hold: "second-hold" });
			// Wallet-settled turns carry the hold's request metadata themselves.
			f.charge("wallet-turn", 5, {
				hold: null,
				metadata: {
					runId: "own-run",
					reservation: {
						source: "workspace_chat",
						workspaceId: "own-workspace",
					},
				},
			});
			f.charge("wallet-other-workspace", 50, {
				hold: null,
				metadata: {
					runId: "own-run",
					reservation: {
						source: "workspace_chat",
						workspaceId: "other-workspace",
					},
				},
			});
			const input = {
				organizationId: "own",
				runIds: ["own-run", "second-run"],
				workspaceChat,
			};
			expect(await sumRunCredits(f.db, input)).toEqual({
				credits: 8,
				chargeCount: 2,
			});
			setMetadata.run(
				JSON.stringify({ source: "home_chat", workspaceId: "own-workspace" }),
				"hold",
			);
			expect(await sumRunCredits(f.db, input)).toEqual({
				credits: 5,
				chargeCount: 1,
			});
		} finally {
			f.sqlite.close();
		}
	});

	it("sums AI credits per run from pre-wallet and wallet charges and leaves runs without any out", async () => {
		const f = fixture();
		try {
			f.charge("first", 3);
			f.charge("second", 4);
			f.charge("other-run-call", 7, { hold: "second-hold" });
			f.charge("wallet", 6, { hold: null, metadata: { runId: "second-run" } });
			f.charge("foreign", 11, { org: "other", hold: "foreign-hold" });
			f.charge("foreign-wallet", 13, {
				org: "other",
				hold: null,
				metadata: { runId: "own-run" },
			});
			const byRun = await sumRunCreditsByRun(f.db, {
				organizationId: "own",
				runIds: ["own-run", "second-run", "other-run", "no-such-run"],
			});
			expect(Object.fromEntries(byRun)).toEqual({
				"own-run": { credits: 7, chargeCount: 2 },
				"second-run": { credits: 13, chargeCount: 2 },
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
