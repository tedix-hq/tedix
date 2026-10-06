CREATE TABLE `provider_model_rate_versions` (
	`id` text PRIMARY KEY,
	`provider` text NOT NULL,
	`model_id` text NOT NULL,
	`deployment_scope` text NOT NULL,
	`effective_from` text NOT NULL,
	`effective_until` text NOT NULL,
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
	CONSTRAINT `fk_provider_model_rate_versions_supersedes_rate_version_id_provider_model_rate_versions_id_fk` FOREIGN KEY (`supersedes_rate_version_id`) REFERENCES `provider_model_rate_versions`(`id`) ON DELETE RESTRICT,
	CONSTRAINT "chk_provider_model_rate_scope" CHECK(length(trim("deployment_scope", char(9) || char(10) || char(13) || ' ')) > 0),
	CONSTRAINT "chk_provider_model_rate_interval" CHECK(julianday("effective_from") IS NOT NULL AND julianday("effective_until") IS NOT NULL AND julianday("effective_until") > julianday("effective_from")),
	CONSTRAINT "chk_provider_model_rate_currency" CHECK("currency" = 'USD'),
	CONSTRAINT "chk_provider_model_rate_amounts" CHECK(typeof("input_microusd_per_million") = 'integer' AND "input_microusd_per_million" BETWEEN 0 AND 9007199254740991 AND typeof("output_microusd_per_million") = 'integer' AND "output_microusd_per_million" BETWEEN 0 AND 9007199254740991 AND typeof("cache_read_microusd_per_million") = 'integer' AND "cache_read_microusd_per_million" BETWEEN 0 AND 9007199254740991 AND typeof("cache_write_microusd_per_million") = 'integer' AND "cache_write_microusd_per_million" BETWEEN 0 AND 9007199254740991)
);
--> statement-breakpoint
CREATE INDEX `idx_provider_model_rate_lookup` ON `provider_model_rate_versions` (`provider`,`model_id`,`deployment_scope`,`effective_from`,`effective_until`);--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_provider_model_rate_correction` ON `provider_model_rate_versions` (`supersedes_rate_version_id`);