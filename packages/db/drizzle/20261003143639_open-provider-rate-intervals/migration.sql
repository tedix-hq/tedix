-- tedix: destructive-reviewed Work-Item: 6e9b4966-96f1-4f20-b861-0b461a6320b5
-- CTO approval 7972d572-d829-43c7-9325-346aa0e515cf, Work version 4.
-- Preserve every rate field and self-reference with foreign keys enforced.
-- deploy-safe records a Time Travel recovery point and verifies ledger/drift;
-- the release compares full provider inventory before/after. Restore is manual.
CREATE TABLE `__new_provider_model_rate_versions` (
	`id` text PRIMARY KEY,
	`provider` text NOT NULL,
	`model_id` text NOT NULL,
	`deployment_scope` text NOT NULL,
	`input_token_min` integer DEFAULT 0 NOT NULL,
	`input_token_max` integer,
	`effective_from` text NOT NULL,
	`effective_until` text,
	`input_microusd_per_million` integer NOT NULL,
	`output_microusd_per_million` integer NOT NULL,
	`cache_read_microusd_per_million` integer NOT NULL,
	`cache_write_microusd_per_million` integer NOT NULL,
	`currency` text NOT NULL,
	`evidence_uri` text NOT NULL,
	`evidence_digest` text NOT NULL,
	`verified_at` text NOT NULL,
	`published_at` text NOT NULL,
	`published_by` text NOT NULL,
	`change_reason` text NOT NULL,
	`supersedes_rate_version_id` text,
	CONSTRAINT `fk_provider_model_rate_versions_supersedes_rate_version_id_provider_model_rate_versions_id_fk` FOREIGN KEY (`supersedes_rate_version_id`) REFERENCES `__new_provider_model_rate_versions`(`id`) ON DELETE RESTRICT,
	CONSTRAINT "chk_provider_model_rate_scope" CHECK(length(trim("deployment_scope", char(9) || char(10) || char(13) || ' ')) > 0),
	CONSTRAINT "chk_provider_model_rate_interval" CHECK(julianday("effective_from") IS NOT NULL AND ("effective_until" IS NULL OR (julianday("effective_until") IS NOT NULL AND julianday("effective_until") > julianday("effective_from")))),
	CONSTRAINT "chk_provider_model_rate_currency" CHECK("currency" = 'USD'),
	CONSTRAINT "chk_provider_model_rate_amounts" CHECK(typeof("input_microusd_per_million") = 'integer' AND "input_microusd_per_million" BETWEEN 0 AND 9007199254740991 AND typeof("output_microusd_per_million") = 'integer' AND "output_microusd_per_million" BETWEEN 0 AND 9007199254740991 AND typeof("cache_read_microusd_per_million") = 'integer' AND "cache_read_microusd_per_million" BETWEEN 0 AND 9007199254740991 AND typeof("cache_write_microusd_per_million") = 'integer' AND "cache_write_microusd_per_million" BETWEEN 0 AND 9007199254740991)
);
--> statement-breakpoint
INSERT INTO `__new_provider_model_rate_versions`(`id`, `provider`, `model_id`, `deployment_scope`, `input_token_min`, `input_token_max`, `effective_from`, `effective_until`, `input_microusd_per_million`, `output_microusd_per_million`, `cache_read_microusd_per_million`, `cache_write_microusd_per_million`, `currency`, `evidence_uri`, `evidence_digest`, `verified_at`, `published_at`, `published_by`, `change_reason`, `supersedes_rate_version_id`) SELECT `id`, `provider`, `model_id`, `deployment_scope`, `input_token_min`, `input_token_max`, `effective_from`, `effective_until`, `input_microusd_per_million`, `output_microusd_per_million`, `cache_read_microusd_per_million`, `cache_write_microusd_per_million`, `currency`, `evidence_uri`, `evidence_digest`, `verified_at`, `published_at`, `published_by`, `change_reason`, `supersedes_rate_version_id` FROM `provider_model_rate_versions`;--> statement-breakpoint
-- All self-links now exist in the replacement; release only the old copy's
-- RESTRICT links before dropping it. No external FK references this table.
UPDATE `provider_model_rate_versions` SET `supersedes_rate_version_id` = NULL;--> statement-breakpoint
DROP TABLE `provider_model_rate_versions`;--> statement-breakpoint
ALTER TABLE `__new_provider_model_rate_versions` RENAME TO `provider_model_rate_versions`;--> statement-breakpoint
CREATE INDEX `idx_provider_model_rate_lookup` ON `provider_model_rate_versions` (`provider`,`model_id`,`deployment_scope`,`effective_from`,`effective_until`);--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_provider_model_rate_correction` ON `provider_model_rate_versions` (`supersedes_rate_version_id`);
