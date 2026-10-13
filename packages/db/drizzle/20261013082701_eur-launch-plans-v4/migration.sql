-- EUR launch plans (Stripe catalog v4): per-tedi pricing, annual = 10 months,
-- priced overage off. Each row takes the next free version of its plan key,
-- because installations may hold versions no migration created; the newest
-- active version is the one sold. Existing accounts keep the plan version
-- they reference.
INSERT INTO billing_plan_versions (
	id, plan_key, version, status, name, currency,
	monthly_price_micros, annual_price_micros,
	included_monthly_tokens, included_monthly_credit_micros,
	overage_unit_tokens, overage_unit_price_micros,
	max_tedis, max_cron_jobs_per_tedi, max_iterations_per_task,
	default_daily_token_limit, default_daily_message_limit, allow_overage,
	metadata, effective_at
)
SELECT
	plan.id, plan.plan_key,
	COALESCE((
		SELECT MAX(existing.version)
		FROM billing_plan_versions AS existing
		WHERE existing.plan_key = plan.plan_key
	), 0) + 1,
	'active', plan.name, 'eur',
	plan.monthly_price_micros, plan.annual_price_micros,
	plan.included_monthly_tokens, 0,
	1000, 0,
	plan.max_tedis, plan.max_cron_jobs_per_tedi, plan.max_iterations_per_task,
	plan.default_daily_token_limit, plan.default_daily_message_limit,
	plan.allow_overage,
	plan.metadata, '2026-10-13T00:00:00.000Z'
FROM (
	SELECT
		'growth-eur-v4' AS id, 'growth' AS plan_key, 'Growth' AS name,
		200000000 AS monthly_price_micros, 2000000000 AS annual_price_micros,
		2000000 AS included_monthly_tokens,
		1 AS max_tedis, 10 AS max_cron_jobs_per_tedi,
		16 AS max_iterations_per_task,
		1000000 AS default_daily_token_limit,
		200 AS default_daily_message_limit, 0 AS allow_overage,
		'{"stripeCatalogVersion":4}' AS metadata
	UNION ALL
	SELECT
		'business-eur-v4', 'business', 'Business',
		500000000, 5000000000, 8000000,
		3, 25, 32, 4000000, 500, 0,
		'{"stripeCatalogVersion":4}'
	UNION ALL
	SELECT
		'enterprise-eur-v4', 'enterprise', 'Enterprise',
		1000000000, 10000000000, 0,
		-1, -1, 64, -1, -1, 1,
		'{"stripeCatalogVersion":4,"internalMetered":true,"meterAllUsage":true}'
) AS plan
WHERE NOT EXISTS (
	SELECT 1 FROM billing_plan_versions AS existing WHERE existing.id = plan.id
);
