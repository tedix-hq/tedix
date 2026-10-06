CREATE TABLE `site_reconciliation_findings` (
	`id` text PRIMARY KEY,
	`run_id` text NOT NULL,
	`organization_id` text NOT NULL,
	`site_id` text NOT NULL,
	`site_slug` text NOT NULL,
	`site_type` text NOT NULL,
	`code` text NOT NULL,
	`severity` text NOT NULL,
	`detail` text NOT NULL,
	`first_detected_at` text NOT NULL,
	`last_detected_at` text NOT NULL,
	`resolved_at` text,
	`created_at` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL,
	CONSTRAINT `fk_site_reconciliation_findings_run_id_site_reconciliation_runs_id_fk` FOREIGN KEY (`run_id`) REFERENCES `site_reconciliation_runs`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_site_reconciliation_findings_organization_id_organizations_id_fk` FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `site_reconciliation_runs` (
	`id` text PRIMARY KEY,
	`organization_id` text NOT NULL,
	`source` text NOT NULL,
	`started_at` text NOT NULL,
	`completed_at` text NOT NULL,
	`sites_checked` integer NOT NULL,
	`issue_count` integer NOT NULL,
	`created_at` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL,
	CONSTRAINT `fk_site_reconciliation_runs_organization_id_organizations_id_fk` FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_site_reconciliation_findings_identity` ON `site_reconciliation_findings` (`organization_id`,`site_id`,`code`,`first_detected_at`);--> statement-breakpoint
CREATE INDEX `idx_site_reconciliation_findings_open` ON `site_reconciliation_findings` (`organization_id`,`resolved_at`,`last_detected_at`);--> statement-breakpoint
CREATE INDEX `idx_site_reconciliation_findings_run` ON `site_reconciliation_findings` (`run_id`);--> statement-breakpoint
CREATE INDEX `idx_site_reconciliation_runs_org_completed` ON `site_reconciliation_runs` (`organization_id`,`completed_at`);