CREATE TABLE `kernel_tool_results` (
	`id` text PRIMARY KEY,
	`organization_id` text NOT NULL,
	`conversation_id` text NOT NULL,
	`run_id` text,
	`source_kind` text NOT NULL,
	`source_id` text NOT NULL,
	`object_key` text NOT NULL,
	`sha256` text NOT NULL,
	`byte_size` integer NOT NULL,
	`content_type` text DEFAULT 'application/json' NOT NULL,
	`created_at` text NOT NULL,
	`expires_at` text NOT NULL,
	`evicted_at` text,
	`eviction_reason` text,
	CONSTRAINT `fk_kernel_tool_results_organization_id_organizations_id_fk` FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON DELETE CASCADE,
	CONSTRAINT "chk_kernel_tool_result_byte_size" CHECK("byte_size" >= 0 AND "byte_size" <= 1048576)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_kernel_tool_results_object_key` ON `kernel_tool_results` (`object_key`);--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_kernel_tool_results_source` ON `kernel_tool_results` (`organization_id`,`source_kind`,`source_id`);--> statement-breakpoint
CREATE INDEX `idx_kernel_tool_results_conversation_active` ON `kernel_tool_results` (`organization_id`,`conversation_id`,`evicted_at`,`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `idx_kernel_tool_results_cleanup` ON `kernel_tool_results` (`evicted_at`,`expires_at`,`id`);--> statement-breakpoint
CREATE INDEX `idx_kernel_tool_results_digest` ON `kernel_tool_results` (`organization_id`,`conversation_id`,`sha256`);