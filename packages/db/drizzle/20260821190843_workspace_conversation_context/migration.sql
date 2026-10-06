ALTER TABLE `kernel_conversations` ADD `workspace_id` text;--> statement-breakpoint
ALTER TABLE `kernel_conversations` ADD `workpiece_kind` text;--> statement-breakpoint
ALTER TABLE `kernel_conversations` ADD `workpiece_id` text;--> statement-breakpoint
CREATE INDEX `idx_kernel_conversations_org_workspace_last_message` ON `kernel_conversations` (`organization_id`,`workspace_id`,`last_message_at`,`conversation_id`);