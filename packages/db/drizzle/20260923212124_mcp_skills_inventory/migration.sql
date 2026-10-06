CREATE TABLE `app_catalog_mcp_skills` (
	`id` text PRIMARY KEY,
	`catalog_app_id` text NOT NULL,
	`skill_uri` text NOT NULL,
	`frontmatter` text NOT NULL,
	`resources` text NOT NULL,
	`detected_at` text NOT NULL,
	`last_seen_at` text NOT NULL,
	CONSTRAINT `fk_app_catalog_mcp_skills_catalog_app_id_app_catalog_id_fk` FOREIGN KEY (`catalog_app_id`) REFERENCES `app_catalog`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE UNIQUE INDEX `mcp_skills_app_uri_unique` ON `app_catalog_mcp_skills` (`catalog_app_id`,`skill_uri`);--> statement-breakpoint
CREATE INDEX `mcp_skills_app_last_seen_idx` ON `app_catalog_mcp_skills` (`catalog_app_id`,`last_seen_at`);
