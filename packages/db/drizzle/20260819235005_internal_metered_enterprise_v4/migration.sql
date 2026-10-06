INSERT INTO billing_plan_versions (
	id, plan_key, version, status, name, currency,
	monthly_price_micros, annual_price_micros,
	included_monthly_tokens, included_monthly_credit_micros,
	overage_unit_tokens, overage_unit_price_micros,
	max_tedis, max_cron_jobs_per_tedi, max_iterations_per_task,
	default_daily_token_limit, default_daily_message_limit, allow_overage,
	stripe_product_id, stripe_monthly_price_id, stripe_annual_price_id,
	stripe_overage_price_id, metadata, effective_at
) VALUES
	(
		'enterprise-v4', 'enterprise', 4, 'active', 'Enterprise', 'usd',
		999000000, 9599000000, 0, 0, 1000, 0,
		-1, -1, 64, -1, -1, 1,
		NULL, NULL,
		NULL, NULL,
		'{"stripeCatalogVersion":3,"internalMetered":true,"meterAllUsage":true}',
		'2026-08-19T23:50:00.000Z'
	)
ON CONFLICT(id) DO NOTHING;
