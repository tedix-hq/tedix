CREATE TABLE IF NOT EXISTS `tedix_drizzle_migrations` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`name` text UNIQUE,
	`applied_at` timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
INSERT OR IGNORE INTO `tedix_drizzle_migrations` (`name`) VALUES
	('20260722173753_baseline/migration.sql'),
	('20260722181943_work_item_inbox/migration.sql'),
	('20260724175117_skill_run_admission_dedup/migration.sql'),
	('20260725044657_fresh_monster_badoon/migration.sql'),
	('20260725045314_curvy_sentinel/migration.sql'),
	('20260727021917_runtime_event_retention_index/migration.sql'),
	('20260727030243_drop_dead_telemetry_tables/migration.sql'),
	('20260727034647_graph_projection_control_plane/migration.sql'),
	('20260727060440_graph_cognition_governance/migration.sql'),
	('20260727195937_billing_credits_metering/migration.sql'),
	('20260727200039_billing_provider_reconciliation/migration.sql'),
	('20260727200116_billing_reservation_attribution/migration.sql'),
	('20260727201952_billing_reservation_plan_version/migration.sql'),
	('20260727205838_billing_overview_tool_projection/migration.sql'),
	('20260727212854_telemetry_retention_indexes/migration.sql'),
	('20260727214601_stripe_catalog_v2/migration.sql'),
	('20260728002915_ops_alert_state/migration.sql'),
	('20260728032339_connection_provider_issuer_pinning/migration.sql'),
	('20260728125845_billing_settlement_durability/migration.sql'),
	('20260728205024_worthless_skreet/migration.sql'),
	('20260729013001_work_item_commit_certifications/migration.sql'),
	('20260729183041_docs_sites/migration.sql'),
	('20260730015158_docs-governance-authoring/migration.sql'),
	('20260730020216_managed_seo_credits/migration.sql'),
	('20260730174512_kernel_hot_path_indexes/migration.sql'),
	('20260730183800_drop_prefix_redundant_indexes/migration.sql'),
	('20260801005651_stripe_catalog_v3/migration.sql'),
	('20260802042204_allow_billing_credit_cascade_delete/migration.sql');
--> statement-breakpoint
INSERT OR IGNORE INTO `tedix_drizzle_migrations` (`name`)
SELECT '20260802165727_d1_native_ledger_cutover/migration.sql'
WHERE EXISTS (
	SELECT 1 FROM sqlite_master
	WHERE type = 'table' AND name = 'd1_migrations'
);
