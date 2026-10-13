-- tedix: destructive-reviewed Work-Item: 81e811c6-ea38-44ed-9d8e-843833d92f62
-- EUR becomes the only billing currency. No plan, pack or price row is
-- deleted: USD rows are retired, accounts move to the newest active EUR row
-- of their plan key, and each USD capacity pack gets an EUR version with the
-- same round numbers. Every step only acts where an EUR replacement exists,
-- so an installation without one keeps selling what it sells today, and a
-- rerun is a no-op. The pack-immutability trigger is lifted only for the
-- retirement and restored unchanged.

-- Starter is free in every currency; its EUR row copies the newest active
-- USD row under the next free version.
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
	'starter-eur', plan.plan_key,
	(SELECT MAX(existing.version) FROM billing_plan_versions AS existing
		WHERE existing.plan_key = plan.plan_key) + 1,
	'active', plan.name, 'eur',
	plan.monthly_price_micros, plan.annual_price_micros,
	plan.included_monthly_tokens, plan.included_monthly_credit_micros,
	plan.overage_unit_tokens, plan.overage_unit_price_micros,
	plan.max_tedis, plan.max_cron_jobs_per_tedi, plan.max_iterations_per_task,
	plan.default_daily_token_limit, plan.default_daily_message_limit,
	plan.allow_overage, plan.metadata, '2026-10-13T00:00:00.000Z'
FROM billing_plan_versions AS plan
WHERE plan.plan_key = 'starter'
	AND plan.status = 'active'
	AND plan.currency <> 'eur'
	AND plan.monthly_price_micros = 0
	AND plan.annual_price_micros = 0
	AND plan.id NOT LIKE 'credit-plan:%'
	AND NOT EXISTS (
		SELECT 1 FROM billing_plan_versions AS eur
		WHERE eur.plan_key = 'starter' AND eur.currency = 'eur'
	)
ORDER BY plan.version DESC
LIMIT 1;
--> statement-breakpoint
UPDATE billing_accounts
SET
	plan_version_id = (
		SELECT eur.id
		FROM billing_plan_versions AS eur
		JOIN billing_plan_versions AS current
			ON current.id = billing_accounts.plan_version_id
		WHERE eur.plan_key = current.plan_key
			AND eur.currency = 'eur'
			AND eur.status = 'active'
		ORDER BY eur.version DESC
		LIMIT 1
	),
	entitlement_version = entitlement_version + 1,
	updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE EXISTS (
	SELECT 1
	FROM billing_plan_versions AS current
	JOIN billing_plan_versions AS eur
		ON eur.plan_key = current.plan_key
		AND eur.currency = 'eur'
		AND eur.status = 'active'
	WHERE current.id = billing_accounts.plan_version_id
		AND current.currency <> 'eur'
);
--> statement-breakpoint
UPDATE billing_plan_versions
SET status = 'retired'
WHERE currency <> 'eur'
	AND status <> 'retired'
	AND EXISTS (
		SELECT 1 FROM billing_plan_versions AS eur
		WHERE eur.plan_key = billing_plan_versions.plan_key
			AND eur.currency = 'eur'
			AND eur.status = 'active'
	)
	AND NOT EXISTS (
		SELECT 1 FROM billing_accounts AS account
		WHERE account.plan_version_id = billing_plan_versions.id
	);
--> statement-breakpoint
INSERT INTO billing_inference_capacity_pack_versions (
	id, pack_key, version, status, name, currency,
	price_micros, token_amount, spend_amount_micros,
	stripe_environment, stripe_lookup_key, metadata, effective_at
)
SELECT
	'inference-capacity-' || replace(pack.pack_key, '_', '-') || '-'
		|| pack.stripe_environment || '-eur',
	pack.pack_key, pack.version + 1, 'active', pack.name, 'eur',
	pack.price_micros, pack.token_amount, pack.spend_amount_micros,
	pack.stripe_environment,
	'tedix_inference_capacity_' || pack.pack_key || '_v' || (pack.version + 1),
	pack.metadata, '2026-10-13T00:00:00.000Z'
FROM billing_inference_capacity_pack_versions AS pack
WHERE pack.status = 'active'
	AND pack.currency <> 'eur'
	AND pack.version = (
		SELECT MAX(existing.version)
		FROM billing_inference_capacity_pack_versions AS existing
		WHERE existing.pack_key = pack.pack_key
			AND existing.stripe_environment = pack.stripe_environment
	)
	AND NOT EXISTS (
		SELECT 1 FROM billing_inference_capacity_pack_versions AS taken
		WHERE taken.stripe_environment = pack.stripe_environment
			AND taken.stripe_lookup_key =
				'tedix_inference_capacity_' || pack.pack_key || '_v' || (pack.version + 1)
	);
--> statement-breakpoint
DROP TRIGGER `billing_inference_capacity_pack_versions_immutable`;
--> statement-breakpoint
UPDATE billing_inference_capacity_pack_versions
SET status = 'retired'
WHERE currency <> 'eur'
	AND status = 'active'
	AND EXISTS (
		SELECT 1 FROM billing_inference_capacity_pack_versions AS eur
		WHERE eur.pack_key = billing_inference_capacity_pack_versions.pack_key
			AND eur.stripe_environment =
				billing_inference_capacity_pack_versions.stripe_environment
			AND eur.currency = 'eur'
			AND eur.status = 'active'
	);
--> statement-breakpoint
CREATE TRIGGER `billing_inference_capacity_pack_versions_immutable`
BEFORE UPDATE ON `billing_inference_capacity_pack_versions`
BEGIN
	SELECT RAISE(ABORT, 'billing inference capacity pack versions are immutable');
END;
