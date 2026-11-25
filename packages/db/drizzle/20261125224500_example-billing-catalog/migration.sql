-- Public installations seed only an example billing catalog. Plan prices and
-- quotas are operator data: Tedix Cloud applies its real catalog from
-- tedix-cloud-ops as D1 rows, and the newest active version per plan key is
-- the one sold, so operator rows supersede these examples. Nothing is deleted:
-- existing accounts keep the plan version they reference, and retired rows
-- stay for reservations and usage history. Credit top-up packs are not
-- catalog data; their sizes and EUR 0.01-per-credit price are the fixed public
-- contract in apps/api/scripts/billing/stripe-catalog.ts.
UPDATE billing_plan_versions
SET status = 'retired'
WHERE status = 'active';
--> statement-breakpoint
INSERT INTO billing_plan_versions (
	id, plan_key, version, status, name, currency,
	monthly_price_micros, annual_price_micros,
	included_monthly_credits, credit_fx,
	max_tedis, max_cron_jobs_per_tedi, max_iterations_per_task,
	allow_overage, metadata, effective_at
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
	plan.included_monthly_credits,
	'{"microUsdPerEur":1000000,"source":"https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml","asOf":"2026-11-25"}',
	plan.max_tedis, plan.max_cron_jobs_per_tedi, plan.max_iterations_per_task,
	plan.allow_overage, plan.metadata, '2026-11-25T00:00:00.000Z'
FROM (
	SELECT
		'starter-example' AS id, 'starter' AS plan_key, 'Starter' AS name,
		0 AS monthly_price_micros, 0 AS annual_price_micros,
		100 AS included_monthly_credits,
		1 AS max_tedis, 2 AS max_cron_jobs_per_tedi,
		8 AS max_iterations_per_task, 0 AS allow_overage,
		'{"exampleCatalog":true,"stripeCatalogVersion":1}' AS metadata
	UNION ALL
	SELECT
		'growth-example', 'growth', 'Growth',
		10000000, 100000000, 1000,
		1, 5, 16, 1,
		'{"exampleCatalog":true,"stripeCatalogVersion":1}'
	UNION ALL
	SELECT
		'business-example', 'business', 'Business',
		25000000, 250000000, 5000,
		3, 15, 32, 1,
		'{"exampleCatalog":true,"stripeCatalogVersion":1}'
	UNION ALL
	SELECT
		'enterprise-example', 'enterprise', 'Enterprise',
		50000000, 500000000, 25000,
		10, 50, 64, 1,
		'{"exampleCatalog":true,"stripeCatalogVersion":1}'
) AS plan
WHERE NOT EXISTS (
	SELECT 1 FROM billing_plan_versions AS existing WHERE existing.id = plan.id
);
