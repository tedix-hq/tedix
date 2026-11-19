-- tedix: destructive-reviewed Work-Item: b035a564-f807-4db6-8f42-8e197bda081e
-- The only row deletion removes billing_inference_policies rows whose sole
-- content was daily limits (live: 14 rows without model tiers); the
-- following migration drops those columns, so nothing they held survives.
-- Tedix credits (Work-Item b035a564-f807-4db6-8f42-8e197bda081e, owner
-- approval 19 Nov 2026). Usage is billed and limited in Tedix credits with
-- monthly limits only: 1 credit = EUR 0.01.
--
-- New plan versions keep each plan's price, Stripe catalog metadata and
-- runtime limits, add the included monthly credits and pin the ECB reference
-- rate already pinned by the live EUR credit wallet (USD 1.1181 per EUR,
-- 2026-10-12). Every account moves to its plan's new version and the old
-- versions retire.
INSERT INTO billing_plan_versions (
	id, plan_key, version, status, name, currency,
	monthly_price_micros, annual_price_micros,
	included_monthly_tokens, included_monthly_credit_micros,
	overage_unit_tokens, overage_unit_price_micros,
	max_tedis, max_cron_jobs_per_tedi, max_iterations_per_task,
	default_daily_token_limit, default_daily_message_limit, allow_overage,
	included_monthly_credits, credit_fx, metadata, effective_at
)
SELECT
	plan.id, plan.plan_key,
	COALESCE((
		SELECT MAX(existing.version)
		FROM billing_plan_versions AS existing
		WHERE existing.plan_key = plan.plan_key
	), 0) + 1,
	'active', plan.name, 'eur',
	plan.monthly_price_micros,
	COALESCE(current.annual_price_micros, plan.monthly_price_micros * 10),
	0, 0, 1000, 0,
	COALESCE(current.max_tedis, plan.max_tedis),
	COALESCE(current.max_cron_jobs_per_tedi, plan.max_cron_jobs_per_tedi),
	COALESCE(current.max_iterations_per_task, plan.max_iterations_per_task),
	0, 0, plan.allow_overage,
	plan.included_monthly_credits,
	'{"microUsdPerEur":1118100,"source":"https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml","asOf":"2026-10-12"}',
	COALESCE(current.metadata, '{}'),
	'2026-11-19T00:00:00.000Z'
FROM (
	SELECT 'starter-credits-v1' AS id, 'starter' AS plan_key,
		'Starter' AS name, 0 AS monthly_price_micros, 500 AS included_monthly_credits,
		0 AS allow_overage, 1 AS max_tedis, 2 AS max_cron_jobs_per_tedi,
		8 AS max_iterations_per_task
	UNION ALL SELECT 'growth-credits-v1', 'growth', 'Growth', 200000000, 15000,
		1, 1, 10, 16
	UNION ALL SELECT 'business-credits-v1', 'business', 'Business', 500000000,
		40000, 1, 3, 25, 32
	UNION ALL SELECT 'enterprise-credits-v1', 'enterprise', 'Enterprise',
		1000000000, 100000, 1, -1, -1, 64
) AS plan
LEFT JOIN billing_plan_versions AS current
	ON current.id = (
		SELECT candidate.id FROM billing_plan_versions AS candidate
		WHERE candidate.plan_key = plan.plan_key
			AND candidate.status = 'active'
			AND candidate.metadata NOT LIKE '%monetaryInference%'
		ORDER BY candidate.effective_at DESC, candidate.version DESC
		LIMIT 1
	)
WHERE NOT EXISTS (
	SELECT 1 FROM billing_plan_versions AS existing WHERE existing.id = plan.id
);
--> statement-breakpoint
UPDATE billing_accounts
SET plan_version_id = (
		SELECT next.id FROM billing_plan_versions AS next
		WHERE next.plan_key = (
			SELECT old.plan_key FROM billing_plan_versions AS old
			WHERE old.id = billing_accounts.plan_version_id
		)
			AND next.id LIKE '%-credits-v1'
	),
	-- Pay-as-you-go stays off until an admin opts in with a monthly cap.
	hard_spend_limit_micros = CASE
		WHEN overage_enabled = 1 THEN hard_spend_limit_micros
		ELSE NULL
	END,
	entitlement_version = entitlement_version + 1,
	updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE plan_version_id NOT LIKE '%-credits-v1';
--> statement-breakpoint
UPDATE billing_plan_versions
SET status = 'retired'
WHERE status <> 'retired' AND id NOT LIKE '%-credits-v1';
--> statement-breakpoint
-- tedix is internal; its real use is about EUR 3,600 of inference a month.
UPDATE billing_accounts
SET included_credits_override = 1000000,
	entitlement_version = entitlement_version + 1,
	updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE organization_id = '00000000-0000-4000-8000-000000000000';
--> statement-breakpoint
-- A remaining EUR wallet balance becomes top-up credits at EUR 0.01 each,
-- rounded up, valid for 12 months.
INSERT INTO billing_credit_top_ups (
	id, organization_id, credits, consumed_credits, source_type, source_ref,
	idempotency_key, expires_at, metadata, created_at, updated_at
)
SELECT
	'wallet-conversion:' || organization_id,
	organization_id,
	CAST((credit_balance_micros + 9999) / 10000 AS INTEGER),
	0, 'wallet_conversion', plan_version_id,
	'wallet-conversion:' || organization_id,
	strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '+12 months'),
	json_object('walletBalanceMicros', credit_balance_micros, 'currency', 'eur'),
	strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
	strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM billing_accounts
WHERE credit_balance_micros > 0
ON CONFLICT(idempotency_key) DO NOTHING;
--> statement-breakpoint
-- Unexpired SEO service credits fold into the shared pool the same way.
INSERT INTO billing_credit_top_ups (
	id, organization_id, credits, consumed_credits, source_type, source_ref,
	idempotency_key, expires_at, metadata, created_at, updated_at
)
SELECT
	'service-credit-conversion:' || organization_id || ':' || service_key,
	organization_id,
	SUM(amount_credits),
	0, 'service_credit_conversion', service_key,
	'service-credit-conversion:' || organization_id || ':' || service_key,
	strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '+12 months'),
	json_object('serviceKey', service_key),
	strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
	strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM billing_service_credit_entries
WHERE expires_at IS NULL OR datetime(expires_at) > datetime('now')
GROUP BY organization_id, service_key
HAVING SUM(amount_credits) > 0
ON CONFLICT(idempotency_key) DO NOTHING;
--> statement-breakpoint
-- One-time top-up packs replace the daily capacity packs: 12 months, EUR,
-- prices before tax. The Stripe lookup keys match reconcile-stripe.ts.
INSERT INTO billing_top_up_pack_versions (
	id, pack_key, version, status, name, currency, price_micros, credits,
	valid_months, stripe_environment, stripe_lookup_key, effective_at
)
SELECT
	'credits-' || pack.credits || '-' || env.name || '-v1',
	'credits-' || pack.credits, 1, 'active',
	pack.label, 'eur', pack.credits * 10000, pack.credits, 12,
	env.name, 'tedix_credits_' || pack.credits || '_eur_v1',
	'2026-11-19T00:00:00.000Z'
FROM (
	SELECT 1000 AS credits, '1,000 credits' AS label
	UNION ALL SELECT 5000, '5,000 credits'
	UNION ALL SELECT 10000, '10,000 credits'
	UNION ALL SELECT 25000, '25,000 credits'
	UNION ALL SELECT 50000, '50,000 credits'
) AS pack
CROSS JOIN (SELECT 'live' AS name UNION ALL SELECT 'test') AS env
WHERE NOT EXISTS (
	SELECT 1 FROM billing_top_up_pack_versions AS existing
	WHERE existing.id = 'credits-' || pack.credits || '-' || env.name || '-v1'
);
--> statement-breakpoint
-- Enterprise gets finite organization limits instead of -1.
UPDATE organizations
SET features = json_set(
		features,
		'$.maxApps', CASE WHEN json_extract(features, '$.maxApps') < 0 THEN 50 ELSE json_extract(features, '$.maxApps') END,
		'$.maxCmsSites', CASE WHEN json_extract(features, '$.maxCmsSites') < 0 THEN 25 ELSE json_extract(features, '$.maxCmsSites') END,
		'$.maxTeamMembers', CASE WHEN json_extract(features, '$.maxTeamMembers') < 0 THEN 50 ELSE json_extract(features, '$.maxTeamMembers') END
	)
WHERE json_valid(features)
	AND (json_extract(features, '$.maxApps') < 0
		OR json_extract(features, '$.maxCmsSites') < 0
		OR json_extract(features, '$.maxTeamMembers') < 0);
--> statement-breakpoint
-- Daily inference limits go. A policy row that held only daily limits has
-- nothing left to say; model-tier rows stay.
DELETE FROM billing_inference_policies WHERE allowed_model_tiers IS NULL;
--> statement-breakpoint
UPDATE tedis
SET budgets = json_remove(
		budgets,
		'$.dailyTokenLimit', '$.dailyMessageLimit',
		'$.operatorTokenReserve', '$.operatorMessageReserve',
		'$.governedLearningTokenReserve', '$.governedLearningMessageReserve',
		'$.aiGatewayPolicy.dailyTokenLimit', '$.aiGatewayPolicy.dailySpendLimitMicros'
	)
WHERE budgets IS NOT NULL AND json_valid(budgets);
