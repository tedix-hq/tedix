CREATE TABLE `external_agent_mcp_issuance_leases` (
	`id` text PRIMARY KEY,
	`organization_id` text NOT NULL,
	`principal_id` text NOT NULL,
	`session_id` text NOT NULL,
	`mcp_server_id` text NOT NULL,
	`owner_token` text NOT NULL,
	`expires_at` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	CONSTRAINT `fk_external_agent_mcp_issuance_leases_organization_id_organizations_id_fk` FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_external_agent_mcp_issuance_lease_session_org` FOREIGN KEY (`organization_id`,`principal_id`,`session_id`) REFERENCES `external_agent_sessions`(`organization_id`,`principal_id`,`id`) ON DELETE CASCADE,
	CONSTRAINT "chk_external_agent_mcp_issuance_lease_expiry" CHECK("expires_at" > "updated_at")
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_external_agent_mcp_issuance_lease_target` ON `external_agent_mcp_issuance_leases` (`organization_id`,`principal_id`,`session_id`,`mcp_server_id`);