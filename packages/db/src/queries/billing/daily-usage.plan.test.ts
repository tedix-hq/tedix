import { expect, it } from "vite-plus/test";
import { createDbQueryClient } from "../../query-client";
import { createD1Facade } from "../../test/d1-facade";
import { createMigratedSqlite } from "../../test/migrated-sqlite";
import { reserveBillingUsage } from "./reservations";

const now = "2026-11-04T20:00:00.000Z";
const expiresAt = "2026-11-04T20:10:00.000Z";

it("reads one day of reservations and charges through their indexes", async () => {
	const sqlite = createMigratedSqlite({ foreignKeys: false });
	sqlite.exec(`
		INSERT INTO organizations (id, name, slug) VALUES ('org-1', 'Org', 'org');
		INSERT INTO billing_plan_versions (
			id, plan_key, version, status, name, included_monthly_tokens,
			max_tedis, max_cron_jobs_per_tedi, max_iterations_per_task,
			default_daily_token_limit, default_daily_message_limit,
			effective_at, created_at
		) VALUES ('plan-example', 'plan-example', 1, 'active', 'Starter', 1000000000,
			1, 2, 8, 100, 100, '2026-07-01T00:00:00.000Z', '${now}');
		INSERT INTO billing_accounts (
			organization_id, plan_version_id, status, billing_mode,
			stripe_environment, period_start, period_end, created_at, updated_at
		) VALUES ('org-1', 'plan-example', 'trial', 'trial', 'live',
			'2026-10-20T00:00:00.000Z', '2026-11-20T00:00:00.000Z', '${now}', '${now}');
		INSERT INTO billing_usage_periods (
			id, organization_id, plan_version_id, period_start, period_end,
			included_tokens, created_at, updated_at
		) VALUES ('period-1', 'org-1', 'plan-example',
			'2026-10-20T00:00:00.000Z', '2026-11-20T00:00:00.000Z',
			1000000000, '${now}', '${now}');
	`);
	const reservation = sqlite.prepare(`
		INSERT INTO billing_usage_reservations (
			id, organization_id, plan_version_id, tedi_id, status, source,
			provider, model, estimated_input_tokens, estimated_output_tokens,
			estimated_charge_micros, period_start, period_end, idempotency_key,
			expires_at, created_at, updated_at
		) VALUES (?, 'org-1', 'plan-example', 'tedi-1', ?, 'operator',
			'example', 'example', ?, 0, ?,
			'2026-10-20T00:00:00.000Z', '2026-11-20T00:00:00.000Z',
			?, ?, ?, ?)
	`);
	const charge = sqlite.prepare(
		"INSERT INTO billing_usage_charges (id, organization_id, usage_period_id, tedi_id, provider, model, source, reservation_id, occurred_at, provider_cost_micros, input_tokens, output_tokens, metadata) VALUES (?, 'org-1', 'period-1', 'tedi-1', 'example', 'example', 'operator', ?, ?, ?, ?, 0, '{}')",
	);
	// Earlier days dominate, as in production: the gate must not walk them.
	for (let i = 0; i < 3000; i++) {
		const day = `2026-10-${String(21 + (i % 10)).padStart(2, "0")}`;
		reservation.run(
			`old-${i}`,
			"settled",
			50,
			5,
			`old-${i}`,
			`${day}T00:10:00.000Z`,
			`${day}T00:00:00.000Z`,
			`${day}T00:00:00.000Z`,
		);
		charge.run(`old-${i}`, `old-${i}`, `${day}T00:05:00.000Z`, 7, 40);
	}
	reservation.run(
		"today-settled",
		"settled",
		100,
		10,
		"today-settled",
		"2026-11-04T10:10:00.000Z",
		"2026-11-04T10:00:00.000Z",
		"2026-11-04T10:00:00.000Z",
	);
	charge.run(
		"today-settled",
		"today-settled",
		"2026-11-04T10:05:00.000Z",
		9,
		80,
	);
	reservation.run(
		"today-live",
		"reserved",
		30,
		3,
		"today-live",
		"2026-11-04T20:00:01.000Z",
		"2026-11-04T19:55:00.000Z",
		"2026-11-04T19:55:00.000Z",
	);
	// datetime() truncates to seconds: expiring within the current second is expired.
	reservation.run(
		"today-expiring",
		"reserved",
		500,
		50,
		"today-expiring",
		"2026-11-04T20:00:00.900Z",
		"2026-11-04T19:55:00.000Z",
		"2026-11-04T19:55:00.000Z",
	);
	reservation.run(
		"tomorrow",
		"reserved",
		700,
		70,
		"tomorrow",
		"2026-11-05T00:10:00.000Z",
		"2026-11-05T00:00:00.000Z",
		"2026-11-05T00:00:00.000Z",
	);

	const plans: string[] = [];
	const db = createDbQueryClient(
		createD1Facade({
			prepare(query) {
				if (/^\s*(WITH|SELECT|INSERT)/i.test(query))
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

	const attempt = (id: string, estimatedInputTokens: number) =>
		reserveBillingUsage(db, {
			id,
			organizationId: "org-1",
			tediId: "tedi-1",
			source: "operator",
			provider: "example",
			model: "example",
			estimatedInputTokens,
			estimatedOutputTokens: 0,
			idempotencyKey: `test:${id}`,
			expiresAt,
			now,
			aiGatewayLimits: {
				organizationDailyTokenLimit: 120,
				organizationDailySpendLimitMicros: 13,
				tediDailyTokenLimit: 120,
				tediDailySpendLimitMicros: 13,
			},
		});

	// Today's usage is 80 (settled charge) + 30 (live estimate) tokens and
	// 9 + 3 micros; expired, earlier-day and next-day rows do not count.
	expect(await attempt("fits", 10)).toMatchObject({ allowed: true });
	expect(await attempt("too-many-tokens", 11)).toMatchObject({
		allowed: false,
	});

	for (const table of ["billing_usage_reservations", "billing_usage_charges"])
		expect(plans).not.toContainEqual(
			expect.stringMatching(
				new RegExp(`SCAN (${table}|reservation|charge)\\b`),
			),
		);
	expect(plans).toContainEqual(
		expect.stringMatching(
			/SEARCH (billing_usage_charges|charge) USING INDEX idx_billing_charge_org_occurred \(organization_id=\? AND occurred_at>\? AND occurred_at<\?\)/,
		),
	);
	expect(plans).toContainEqual(
		expect.stringMatching(
			/SEARCH reservation USING INDEX idx_billing_reservation_org_created \(organization_id=\? AND created_at>\? AND created_at<\?\)/,
		),
	);
	expect(plans).toContainEqual(
		expect.stringMatching(
			/SEARCH (billing_usage_reservations|reservation) USING INDEX idx_billing_reservation_org_status \(organization_id=\? AND status=\? AND expires_at>\?\)/,
		),
	);
	sqlite.close();
});
