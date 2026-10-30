CREATE TABLE `tenant_tool_policies` (
	`id` text PRIMARY KEY,
	`organization_id` text NOT NULL,
	`app_id` text NOT NULL,
	`tool_row_id` text NOT NULL,
	`tool_digest` text NOT NULL,
	`rule_digest` text NOT NULL,
	`predicate` text NOT NULL,
	`effect` text NOT NULL,
	`created_by` text NOT NULL,
	`created_at` text NOT NULL,
	`revoked_at` text,
	CONSTRAINT `fk_tenant_tool_policies_organization_id_organizations_id_fk` FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_tenant_tool_policies_tool_row_id_app_tools_id_fk` FOREIGN KEY (`tool_row_id`) REFERENCES `app_tools`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX `tenant_tool_policies_tool_idx` ON `tenant_tool_policies` (`organization_id`,`app_id`,`tool_row_id`);