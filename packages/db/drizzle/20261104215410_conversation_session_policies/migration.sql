CREATE TABLE `kernel_conversation_session_policies` (
	`id` text PRIMARY KEY,
	`organization_id` text NOT NULL,
	`conversation_id` text NOT NULL,
	`scope_key` text NOT NULL,
	`effect` text NOT NULL,
	`granted_by_type` text NOT NULL,
	`granted_by_id` text NOT NULL,
	`reason` text,
	`created_at` text NOT NULL,
	`expires_at` text,
	CONSTRAINT `fk_kernel_conversation_session_policies_organization_id_organizations_id_fk` FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_kernel_conversation_session_policy_scope` ON `kernel_conversation_session_policies` (`organization_id`,`conversation_id`,`scope_key`);--> statement-breakpoint
CREATE INDEX `idx_kernel_conversation_session_policy_conversation` ON `kernel_conversation_session_policies` (`organization_id`,`conversation_id`,`created_at`);