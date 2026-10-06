UPDATE `billing_accounts`
SET
	`billing_mode` = 'internal',
	`updated_at` = CURRENT_TIMESTAMP
WHERE `organization_id` = (
	SELECT `id`
	FROM `organizations`
	WHERE `slug` = 'tedix'
)
	AND `plan_version_id` = 'enterprise-v4'
	AND `status` = 'active'
	AND `billing_mode` = 'stripe'
	AND `stripe_environment` = 'test';
