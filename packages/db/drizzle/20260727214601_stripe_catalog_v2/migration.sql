UPDATE billing_plan_versions
SET status = 'retired'
WHERE plan_key IN ('growth', 'business', 'enterprise')
	AND version < 2
	AND status = 'active';
--> statement-breakpoint
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
		'growth-v2', 'growth', 2, 'active', 'Growth', 'usd',
		249000000, 2399000000, 500000, 0, 1000, 50000,
		1, 10, 16, 250000, 200, 1,
		NULL, NULL,
		NULL,
		NULL,
		'{"stripeCatalogVersion":2,"stripeTransformQuantity":{"divideBy":1000,"round":"up"}}',
		'2026-07-27T21:46:00.000Z'
	),
	(
		'business-v2', 'business', 2, 'active', 'Business', 'usd',
		499000000, 4799000000, 2000000, 0, 1000, 50000,
		3, 25, 32, 1000000, 500, 1,
		NULL, NULL,
		NULL,
		NULL,
		'{"stripeCatalogVersion":2,"stripeTransformQuantity":{"divideBy":1000,"round":"up"}}',
		'2026-07-27T21:46:00.000Z'
	),
	(
		'enterprise-v2', 'enterprise', 2, 'active', 'Enterprise', 'usd',
		999000000, 9599000000, -1, 0, 1000, 0,
		-1, -1, 64, -1, -1, 1,
		NULL, NULL,
		NULL, NULL,
		'{"stripeCatalogVersion":2,"unlimitedTokens":true}',
		'2026-07-27T21:46:00.000Z'
	)
ON CONFLICT(id) DO NOTHING;
--> statement-breakpoint
UPDATE billing_plan_versions
SET status = 'active'
WHERE id IN ('growth-v2', 'business-v2', 'enterprise-v2');
