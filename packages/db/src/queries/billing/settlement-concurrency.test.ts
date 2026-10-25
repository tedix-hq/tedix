import { DatabaseSync } from "node:sqlite";
import { createServer } from "node:http";
import { describe, expect, it } from "vite-plus/test";
import { createDbClient } from "../../client";
import {
	billingAccounts,
	billingPlanVersions,
	billingUsageReservations,
	billingUsagePeriods,
	billingUsageCharges,
	billingCreditEntries,
	stripeMeterOutbox,
} from "../../schema/billing";
import { organizations } from "../../schema/organizations";
import { createD1Facade } from "../../test/d1-facade";
import { schemaDdl } from "../../test/schema-ddl";
import { settleBillingUsage } from "./settlement";
import { releaseBillingReservation } from "./reservations";

const now = "2026-10-22T12:00:00.000Z";
const periodStart = "2026-10-01T00:00:00.000Z";
const periodEnd = "2026-11-01T00:00:00.000Z";

function setup() {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec("PRAGMA foreign_keys = OFF");
	sqlite.exec(
		schemaDdl(
			organizations,
			billingPlanVersions,
			billingAccounts,
			billingUsageReservations,
			billingUsagePeriods,
			billingUsageCharges,
			billingCreditEntries,
			stripeMeterOutbox,
		),
	);
	sqlite.exec(`
 INSERT INTO organizations(id,name,slug) VALUES ('org','Fictional','fictional');
 INSERT INTO billing_plan_versions(id,plan_key,version,name,included_monthly_tokens,
 overage_unit_tokens,overage_unit_price_micros,allow_overage,max_tedis,
 max_cron_jobs_per_tedi,max_iterations_per_task,default_daily_token_limit,
 default_daily_message_limit,effective_at,created_at)
 VALUES ('plan','business',1,'Fictional',5000,1000,1000,1,3,5,30,1000000,100,'${periodStart}','${now}');
 INSERT INTO billing_accounts(organization_id,plan_version_id,status,billing_mode,
 stripe_environment,stripe_customer_id,overage_enabled,credit_balance_micros,period_start,period_end,created_at,updated_at)
 VALUES ('org','plan','active','stripe','live','cus_fictional',1,5000,'${periodStart}','${periodEnd}','${now}','${now}');
 CREATE TRIGGER apply_credit AFTER INSERT ON billing_credit_entries BEGIN
 UPDATE billing_accounts SET credit_balance_micros=credit_balance_micros+NEW.amount_micros
 WHERE organization_id=NEW.organization_id; END;
 `);
	const insert = sqlite.prepare(`INSERT INTO billing_usage_reservations
 (id,organization_id,plan_version_id,source,provider,model,period_start,period_end,idempotency_key,expires_at,created_at,updated_at)
 VALUES (?,'org','plan','kernel','fictional','fictional',?,?,?,?, '${now}', '${now}')`);
	for (let i = 0; i < 50; i++)
		insert.run(
			`reservation:${i}`,
			periodStart,
			periodEnd,
			`reserve:${i}`,
			periodEnd,
		);
	return {
		sqlite,
		db: createDbClient(createD1Facade(sqlite, { maxBoundParams: 100 })),
	};
}
function usage(i: number, settler: number) {
	return {
		id: `charge:${i}:${settler}`,
		organizationId: "org",
		reservationId: `reservation:${i}`,
		gatewayLogId: `gateway:${i}`,
		provider: "fictional",
		model: "fictional",
		source: "kernel" as const,
		inputTokens: 1000,
		outputTokens: 100,
		providerCostMicros: 7,
		usageQuality: "provider_reported" as const,
		providerCostQuality: "estimated" as const,
		meteringReady: true,
		occurredAt: now,
		now,
	};
}

describe("billing settlement concurrency", () => {
	it("cannot replay a rolled-back settlement after cleanup releases its reservation", async () => {
		const { sqlite, db } = setup();
		try {
			sqlite.exec(`CREATE TRIGGER fail_charge BEFORE INSERT ON billing_usage_charges
				BEGIN SELECT RAISE(ABORT, 'settlement unavailable'); END;`);
			await expect(settleBillingUsage(db, usage(0, 0))).rejects.toThrow(
				"settlement unavailable",
			);
			const released = await releaseBillingReservation(db, {
				reservationId: "reservation:0",
				organizationId: "org",
				reason: "replay_cleanup",
				now,
			});
			expect(released?.status).toBe("released");
			sqlite.exec("DROP TRIGGER fail_charge");
			await expect(settleBillingUsage(db, usage(0, 1))).rejects.toThrow(
				"cannot settle from released",
			);
			expect(
				sqlite.prepare("SELECT COUNT(*) AS n FROM billing_usage_charges").get(),
			).toEqual({ n: 0 });
			expect(
				sqlite
					.prepare(
						"SELECT settlement_version AS version FROM billing_usage_periods",
					)
					.get(),
			).toEqual({ version: 0 });
		} finally {
			sqlite.close();
		}
	});

	it.each([false, true])(
		"reconciles a loopback reset with committed=%s using the same reservation and receipt",
		async (committed) => {
			const { sqlite, db } = setup();
			const first = usage(0, 0);
			let serverError: unknown;
			let reset = false;
			const server = createServer(async (request) => {
				try {
					if (committed) await settleBillingUsage(db, first);
				} catch (error) {
					serverError = error;
				} finally {
					// Drop the TCP response, including when the database already committed.
					reset = true;
					request.socket.resetAndDestroy();
				}
			});
			try {
				await new Promise<void>((resolve) =>
					server.listen(0, "127.0.0.1", resolve),
				);
				const address = server.address();
				if (!address || typeof address === "string")
					throw new Error("missing loopback address");
				await expect(
					fetch(`http://127.0.0.1:${address.port}`, {
						method: "POST",
						body: JSON.stringify(first),
						signal: AbortSignal.timeout(5000),
					}),
				).rejects.toMatchObject({
					cause: {
						code: expect.stringMatching(/^(ECONNRESET|UND_ERR_SOCKET)$/),
					},
				});
				expect(reset).toBe(true);
				expect(serverError).toBeUndefined();
				expect(
					sqlite
						.prepare(
							"SELECT id, reservation_id AS reservation, gateway_log_id AS receipt FROM billing_usage_charges",
						)
						.all(),
				).toEqual(
					committed
						? [
								{
									id: first.id,
									reservation: first.reservationId,
									receipt: first.gatewayLogId,
								},
							]
						: [],
				);
				expect(
					sqlite
						.prepare(
							"SELECT status FROM billing_usage_reservations WHERE id='reservation:0'",
						)
						.get(),
				).toEqual({ status: committed ? "settled" : "reserved" });
				// A transport error alone cannot decide whether to release the hold.
				const replayed = await settleBillingUsage(db, usage(0, 1));
				expect(replayed.id).toBe(committed ? first.id : usage(0, 1).id);
				const before = sqlite
					.prepare("SELECT * FROM billing_usage_periods")
					.all();
				expect(await settleBillingUsage(db, usage(0, 2))).toEqual(replayed);
				expect(
					await releaseBillingReservation(db, {
						reservationId: first.reservationId,
						organizationId: first.organizationId,
						reason: "replay_cleanup",
						now,
					}),
				).toBeNull();
				expect(
					sqlite.prepare("SELECT * FROM billing_usage_periods").all(),
				).toEqual(before);
				expect(
					sqlite
						.prepare(
							"SELECT COUNT(*) AS n, SUM(input_tokens + output_tokens) AS tokens FROM billing_usage_charges",
						)
						.get(),
				).toEqual({ n: 1, tokens: 1100 });
				expect(
					sqlite
						.prepare(
							"SELECT settlement_version AS version FROM billing_usage_periods",
						)
						.get(),
				).toEqual({ version: 1 });
			} finally {
				server.closeAllConnections();
				await new Promise<void>((resolve) => server.close(() => resolve()));
				sqlite.close();
			}
		},
	);

	it("rolls back the claim and totals if a later batch statement fails, then retries safely", async () => {
		const { sqlite, db } = setup();
		try {
			sqlite.exec(`UPDATE billing_plan_versions SET included_monthly_tokens=0;
				UPDATE billing_accounts SET credit_balance_micros=0;
				CREATE TRIGGER fail_outbox BEFORE INSERT ON stripe_meter_outbox BEGIN SELECT RAISE(ABORT, 'outbox unavailable'); END;`);
			await expect(settleBillingUsage(db, usage(0, 0))).rejects.toThrow(
				"outbox unavailable",
			);
			expect(
				sqlite.prepare("SELECT COUNT(*) AS n FROM billing_usage_charges").get(),
			).toEqual({ n: 0 });
			expect(
				sqlite
					.prepare(
						"SELECT settlement_version AS version FROM billing_usage_periods",
					)
					.get(),
			).toEqual({ version: 0 });
			expect(
				sqlite
					.prepare(
						"SELECT status FROM billing_usage_reservations WHERE id='reservation:0'",
					)
					.get(),
			).toEqual({ status: "reserved" });
			sqlite.exec("DROP TRIGGER fail_outbox");
			await settleBillingUsage(db, usage(0, 0));
			expect(
				sqlite
					.prepare(
						"SELECT settlement_version AS version FROM billing_usage_periods",
					)
					.get(),
			).toEqual({ version: 1 });
		} finally {
			sqlite.close();
		}
	});

	it("rejects a receipt or charge id belonging to another reservation without settling it", async () => {
		const { sqlite, db } = setup();
		try {
			const first = await settleBillingUsage(db, usage(0, 0));
			for (const identity of [
				{ id: first.id },
				{ gatewayLogId: first.gatewayLogId },
			]) {
				await expect(
					settleBillingUsage(db, { ...usage(1, 0), ...identity }),
				).rejects.toThrow("identity mismatch");
			}
			expect(
				sqlite
					.prepare(
						"SELECT status FROM billing_usage_reservations WHERE id='reservation:1'",
					)
					.get(),
			).toEqual({ status: "reserved" });
			expect(
				sqlite
					.prepare(
						"SELECT settlement_version AS version FROM billing_usage_periods",
					)
					.get(),
			).toEqual({ version: 1 });
		} finally {
			sqlite.close();
		}
	});
	it.each(["gateway", "reservation", "charge"] as const)(
		"settles 50 reservations with two racing settlers sharing a %s identity",
		async (identity) => {
			const { sqlite, db } = setup();
			try {
				const results = await Promise.allSettled(
					Array.from({ length: 50 }, (_, i) =>
						[0, 1].map((s) =>
							settleBillingUsage(db, {
								...usage(i, s),
								id: identity === "charge" ? `charge:${i}` : `charge:${i}:${s}`,
								gatewayLogId:
									identity === "reservation"
										? `gateway:${i}:${s}`
										: `gateway:${i}`,
							}),
						),
					).flat(),
				);
				expect(results.filter((r) => r.status === "rejected")).toEqual([]);
				expect(
					sqlite
						.prepare(`SELECT COUNT(*) AS n, SUM(input_tokens) AS input, SUM(output_tokens) AS output,
 SUM(included_tokens_applied) AS included, SUM(metered_overage_tokens) AS metered,
 SUM(customer_charge_micros) AS charged, SUM(credit_applied_micros) AS credited FROM billing_usage_charges`)
						.get(),
				).toEqual({
					n: 50,
					input: 50000,
					output: 5000,
					included: 5000,
					metered: 45000,
					charged: 45000,
					credited: 5000,
				});
				expect(
					sqlite
						.prepare(`SELECT used_input_tokens AS input,used_output_tokens AS output,metered_overage_tokens AS metered,
 provider_cost_micros AS cost,customer_charge_micros AS charged,credit_applied_micros AS credited,
 settlement_version AS version FROM billing_usage_periods`)
						.get(),
				).toEqual({
					input: 50000,
					output: 5000,
					metered: 45000,
					cost: 350,
					charged: 45000,
					credited: 5000,
					version: 50,
				});
				expect(
					sqlite
						.prepare(
							"SELECT COUNT(*) AS n FROM billing_usage_reservations WHERE status='settled'",
						)
						.get(),
				).toEqual({ n: 50 });
				expect(
					sqlite
						.prepare(
							"SELECT credit_balance_micros AS balance FROM billing_accounts",
						)
						.get(),
				).toEqual({ balance: 0 });
				expect(
					sqlite
						.prepare(
							"SELECT SUM(amount_micros) AS amount FROM billing_credit_entries",
						)
						.get(),
				).toEqual({ amount: -5000 });
				expect(
					sqlite
						.prepare(
							"SELECT SUM(quantity) AS quantity FROM stripe_meter_outbox",
						)
						.get(),
				).toEqual({ quantity: 45000 });
				const before = sqlite
					.prepare("SELECT * FROM billing_usage_periods")
					.get();
				await Promise.all(
					Array.from({ length: 50 }, (_, i) =>
						settleBillingUsage(db, usage(i, 2)),
					),
				);
				expect(
					sqlite.prepare("SELECT * FROM billing_usage_periods").get(),
				).toEqual(before);
			} finally {
				sqlite.close();
			}
		},
	);
});
