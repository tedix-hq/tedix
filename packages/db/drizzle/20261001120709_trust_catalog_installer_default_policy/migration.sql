-- Publish a new system-default policy revision that trusts only the canonical
-- tenant catalog installer. The per-tenant aggregate slug varies, so the
-- allowlist uses the exact-tool wildcard introduced with this migration.
INSERT INTO `policy_packs` (
	`id`,
	`organization_id`,
	`name`,
	`slug`,
	`description`,
	`scope`,
	`target`,
	`status`,
	`version`,
	`supersedes_revision_id`,
	`change_summary`,
	`published_at`,
	`published_by`,
	`definition`,
	`created_at`,
	`updated_at`
)
SELECT
	'7ad8b176-76af-4c66-9a86-87cb13d3a339',
	NULL,
	`name`,
	`slug`,
	`description`,
	`scope`,
	`target`,
	'active',
	`version` + 1,
	`id`,
	'Trust low-risk tenant catalog installation while preserving OAuth consent',
	CURRENT_TIMESTAMP,
	'platform-migration',
	json_set(
		CASE
			WHEN json_type(`definition`, '$.governancePolicy.writeTier.trustedTools') = 'array'
				AND NOT EXISTS (
					SELECT 1
					FROM json_each(`definition`, '$.governancePolicy.writeTier.trustedTools')
					WHERE value = '*:tenant.install_tenant_mcp_apps'
				)
				THEN json_insert(
					`definition`,
					'$.governancePolicy.writeTier.trustedTools[#]',
					'*:tenant.install_tenant_mcp_apps'
				)
			WHEN json_type(`definition`, '$.governancePolicy.writeTier.trustedTools') = 'array'
				THEN `definition`
			ELSE json_set(
				`definition`,
				'$.governancePolicy.writeTier.trustedTools',
				json_array('*:tenant.install_tenant_mcp_apps')
			)
		END,
		'$.governancePolicy.writeTier.autoApproveLowRisk',
		json('true')
	),
	CURRENT_TIMESTAMP,
	CURRENT_TIMESTAMP
FROM `policy_packs`
WHERE `scope` = 'system'
	AND `slug` = 'system-default'
	AND `status` = 'active'
	AND `published_at` IS NOT NULL
ORDER BY `version` DESC
LIMIT 1;
