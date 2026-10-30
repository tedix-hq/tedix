CREATE TABLE `machine_provider_probe_results` (
	`id` text PRIMARY KEY,
	`organization_id` text NOT NULL,
	`principal_id` text NOT NULL,
	`session_id` text NOT NULL,
	`client_record_id` text NOT NULL,
	`client_id` text NOT NULL,
	`mcp_server_id` text NOT NULL,
	`profile_id` text NOT NULL,
	`profile_digest` text NOT NULL,
	`args_digest` text NOT NULL,
	`account_revision_digest` text NOT NULL,
	`expires_at` text NOT NULL,
	CONSTRAINT `fk_machine_provider_probe_results_organization_id_organizations_id_fk` FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX `machine_provider_probe_results_org_idx` ON `machine_provider_probe_results` (`organization_id`,`expires_at`);