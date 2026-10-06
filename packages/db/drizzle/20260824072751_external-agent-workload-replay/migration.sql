CREATE TABLE `external_agent_workload_token_uses` (
	`id` text PRIMARY KEY,
	`organization_id` text NOT NULL,
	`principal_id` text NOT NULL,
	`issuer` text NOT NULL,
	`subject` text NOT NULL,
	`audience` text NOT NULL,
	`jti` text NOT NULL,
	`external_session_key` text NOT NULL,
	`token_issued_at` text NOT NULL,
	`token_expires_at` text NOT NULL,
	`consumed_at` text NOT NULL,
	CONSTRAINT `fk_external_agent_workload_token_uses_organization_id_organizations_id_fk` FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_external_agent_workload_use_principal_org` FOREIGN KEY (`organization_id`,`principal_id`) REFERENCES `external_agent_principals`(`organization_id`,`id`) ON DELETE RESTRICT,
	CONSTRAINT "chk_external_agent_workload_token_lifetime" CHECK("token_expires_at" > "token_issued_at")
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_external_agent_workload_issuer_jti` ON `external_agent_workload_token_uses` (`issuer`,`jti`);--> statement-breakpoint
CREATE INDEX `idx_external_agent_workload_principal` ON `external_agent_workload_token_uses` (`organization_id`,`principal_id`,`consumed_at`);