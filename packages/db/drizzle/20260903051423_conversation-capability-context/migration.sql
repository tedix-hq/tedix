CREATE TABLE `kernel_conversation_capabilities` (
	`id` text PRIMARY KEY,
	`organization_id` text NOT NULL,
	`conversation_id` text NOT NULL,
	`capability_id` text NOT NULL,
	`replay_name` text NOT NULL,
	`attached_by_type` text NOT NULL,
	`attached_by_id` text NOT NULL,
	`created_at` text NOT NULL,
	CONSTRAINT `fk_kernel_conversation_capabilities_organization_id_organizations_id_fk` FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_kernel_conversation_capabilities_capability_id_org_capabilities_id_fk` FOREIGN KEY (`capability_id`) REFERENCES `org_capabilities`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_kernel_conversation_capability_name` ON `kernel_conversation_capabilities` (`organization_id`,`conversation_id`,`replay_name`);--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_kernel_conversation_capability_target` ON `kernel_conversation_capabilities` (`organization_id`,`conversation_id`,`capability_id`);--> statement-breakpoint
CREATE INDEX `idx_kernel_conversation_capability_conversation` ON `kernel_conversation_capabilities` (`organization_id`,`conversation_id`,`created_at`);