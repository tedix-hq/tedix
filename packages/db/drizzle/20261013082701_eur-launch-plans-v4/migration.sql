-- EUR launch plans (Stripe catalog v4): per-tedi pricing, annual = 10 months,
-- priced overage off. Enterprise keeps internal metering at version 5 because
-- enterprise-v4 is the USD internal-metered row. Existing accounts keep the
-- plan version they reference.
INSERT INTO billing_plan_versions (
	id, plan_key, version, status, name, currency,
	monthly_price_micros, annual_price_micros,
	included_monthly_tokens, included_monthly_credit_micros,
	overage_unit_tokens, overage_unit_price_micros,
	max_tedis, max_cron_jobs_per_tedi, max_iterations_per_task,
	default_daily_token_limit, default_daily_message_limit, allow_overage,
	metadata, effective_at
) VALUES
	(
		'growth-v4', 'growth', 4, 'active', 'Growth', 'eur',
		200000000, 2000000000, 2000000, 0, 1000, 0,
		1, 10, 16, 1000000, 200, 0,
		'{"stripeCatalogVersion":4}',
		'2026-10-13T00:00:00.000Z'
	),
	(
		'business-v4', 'business', 4, 'active', 'Business', 'eur',
		500000000, 5000000000, 8000000, 0, 1000, 0,
		3, 25, 32, 4000000, 500, 0,
		'{"stripeCatalogVersion":4}',
		'2026-10-13T00:00:00.000Z'
	),
	(
		'enterprise-v5', 'enterprise', 5, 'active', 'Enterprise', 'eur',
		1000000000, 10000000000, 0, 0, 1000, 0,
		-1, -1, 64, -1, -1, 1,
		'{"stripeCatalogVersion":4,"internalMetered":true,"meterAllUsage":true}',
		'2026-10-13T00:00:00.000Z'
	)
ON CONFLICT(id) DO NOTHING;
