import { sql } from "drizzle-orm";
import { expect, it } from "vite-plus/test";
import { createDbQueryClient } from "../../query-client";
import { createD1Facade } from "../../test/d1-facade";
import { createMigratedSqlite } from "../../test/migrated-sqlite";
import { monetaryPeriodSpendSql } from "./monetary-inference";

it("sums period EUR spend from the monetary charge index, not every charge", async () => {
	const sqlite = createMigratedSqlite({ foreignKeys: false });
	const start = "2026-10-20T00:00:00.000Z";
	const end = "2026-11-20T00:00:00.000Z";
	const reservation = sqlite.prepare(
		"INSERT INTO billing_usage_reservations (id, organization_id, source, provider, model, period_start, period_end, idempotency_key, expires_at, plan_version_id) VALUES (?, 'org-example', 'tedi', 'example', 'example', ?, ?, ?, ?, 'plan-example')",
	);
	reservation.run("current", start, end, "current", end);
	reservation.run(
		"previous",
		"2026-09-20T00:00:00.000Z",
		start,
		"previous",
		start,
	);
	const charge = sqlite.prepare(
		"INSERT INTO billing_usage_charges (id, organization_id, usage_period_id, provider, model, source, reservation_id, occurred_at, credit_applied_micros, customer_charge_micros, metadata) VALUES (?, 'org-example', 'period-example', 'example', 'example', 'tedi', ?, ?, ?, ?, ?)",
	);
	const eur = JSON.stringify({
		monetaryQuote: {
			schemaVersion: 1,
			rateSnapshot: { customerCurrency: "EUR" },
		},
	});
	for (let i = 0; i < 3000; i++)
		charge.run(`token-${i}`, "current", "2026-11-01T00:00:00.000Z", 0, 7, "{}");
	charge.run(
		"eur-current",
		"current",
		"2026-11-02T00:00:00.000Z",
		100,
		20,
		eur,
	);
	charge.run(
		"eur-previous",
		"previous",
		"2026-10-01T00:00:00.000Z",
		999,
		999,
		eur,
	);
	const plans: string[] = [];
	const db = createDbQueryClient(
		createD1Facade({
			prepare(query) {
				plans.push(
					...sqlite
						.prepare(`EXPLAIN QUERY PLAN ${query}`)
						.all(...Array((query.match(/\?/g) ?? []).length).fill(null))
						.map((row) => String(row.detail)),
				);
				return sqlite.prepare(query);
			},
			exec: (query) => sqlite.exec(query),
		}),
	);
	const [row] = (await db.all(
		sql`SELECT ${monetaryPeriodSpendSql()} AS spend FROM (SELECT ${"org-example"} AS organization_id, ${start} AS period_start, ${end} AS period_end) AS account`,
	)) as Array<{ spend: number }>;
	expect(row?.spend).toBe(120);
	expect(plans).toContainEqual(
		expect.stringMatching(
			/SEARCH charge USING INDEX idx_billing_charge_monetary_eur \(organization_id=\? AND occurred_at>\?\)/,
		),
	);
	sqlite.close();
});
