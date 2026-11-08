CREATE TABLE `os_workspace_resources` (
	`id` text PRIMARY KEY,
	`organization_id` text NOT NULL,
	`workspace_id` text NOT NULL,
	`slot` text,
	`provider_id` text NOT NULL,
	`connection_scope` text NOT NULL,
	`personal_owner_user_id` text,
	`connection_instance_id` text,
	`provider_access` text,
	`required_scopes` text DEFAULT '[]' NOT NULL,
	`resource_type` text NOT NULL,
	`provider_resource_id` text NOT NULL,
	`name` text NOT NULL,
	`metadata` text DEFAULT '{}' NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`created_by_kind` text NOT NULL,
	`created_by_id` text NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL,
	`removed_at` text,
	CONSTRAINT `fk_os_workspace_resources_workspace_id_os_workspaces_id_fk` FOREIGN KEY (`workspace_id`) REFERENCES `os_workspaces`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `kernel_conversations` (
	`id` text PRIMARY KEY,
	`organization_id` text NOT NULL,
	`conversation_id` text NOT NULL,
	`title` text,
	`title_source` text,
	`channel` text,
	`origin` text,
	`workspace_id` text,
	`workpiece_kind` text,
	`workpiece_id` text,
	`last_message_at` text NOT NULL,
	`message_count` integer DEFAULT 0 NOT NULL,
	`deleted_at` text,
	`archived_at` text,
	`pinned_at` text,
	`created_at` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL,
	`updated_at` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `kernel_runtime_events` (
	`id` text PRIMARY KEY,
	`organization_id` text NOT NULL,
	`kind` text NOT NULL,
	`conversation_id` text NOT NULL,
	`run_id` text,
	`message_id` text,
	`cause_event_id` text,
	`delegated_tedi_id` text,
	`child_run_id` text,
	`sequence` integer,
	`delta` text,
	`payload` text,
	`runtime_backend` text DEFAULT 'custom' NOT NULL,
	`runtime_external_id` text,
	`runtime_external_url` text,
	`runtime_metadata` text,
	`trace_id` text,
	`created_at` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `kernel_runtime_runs` (
	`id` text PRIMARY KEY,
	`organization_id` text NOT NULL,
	`conversation_id` text NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`input_message_id` text,
	`output_message_id` text,
	`delegated_tedi_id` text,
	`child_run_id` text,
	`child_conversation_id` text,
	`progress_value` integer,
	`progress_label` text,
	`progress_detail` text,
	`latest_event_kind` text,
	`latest_event_at` text,
	`preview` text,
	`runtime_backend` text DEFAULT 'custom' NOT NULL,
	`runtime_external_id` text,
	`runtime_external_url` text,
	`runtime_metadata` text,
	`metadata` text,
	`started_at` text,
	`completed_at` text,
	`created_at` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL,
	`updated_at` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL,
	`output_revision_id` text,
	`sensitive_data_latch` text
);
--> statement-breakpoint
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
	CONSTRAINT "chk_kernel_tool_result_byte_size" CHECK("byte_size" >= 0 AND "byte_size" <= 1048576)
);
--> statement-breakpoint
CREATE TABLE `tedi_artifacts` (
	`id` text PRIMARY KEY,
	`organization_id` text NOT NULL,
	`tedi_id` text NOT NULL,
	`conversation_id` text,
	`run_id` text,
	`message_id` text,
	`kind` text NOT NULL,
	`name` text NOT NULL,
	`mime_type` text,
	`uri` text,
	`size_bytes` integer,
	`metadata` text,
	`access_classification` text,
	`content_digest` text,
	`producer_execution_id` text,
	`access_envelope` text,
	`publication_state` text,
	`created_at` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `os_workspace_resources_workspace_slot_unique` ON `os_workspace_resources` (`workspace_id`,`slot`);--> statement-breakpoint
CREATE UNIQUE INDEX `os_workspace_resources_provider_object_unique` ON `os_workspace_resources` (`workspace_id`,`provider_id`,`connection_scope`,coalesce("personal_owner_user_id", ''),coalesce("connection_instance_id", ''),`resource_type`,`provider_resource_id`);--> statement-breakpoint
CREATE INDEX `os_workspace_resources_org_workspace_idx` ON `os_workspace_resources` (`organization_id`,`workspace_id`,`status`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_kernel_conversations_org_conversation` ON `kernel_conversations` (`organization_id`,`conversation_id`);--> statement-breakpoint
CREATE INDEX `idx_kernel_conversations_org_last_message` ON `kernel_conversations` (`organization_id`,`last_message_at`,`conversation_id`);--> statement-breakpoint
CREATE INDEX `idx_kernel_conversations_org_workspace_last_message` ON `kernel_conversations` (`organization_id`,`workspace_id`,`last_message_at`,`conversation_id`);--> statement-breakpoint
CREATE INDEX `idx_kernel_runtime_events_created` ON `kernel_runtime_events` (`created_at`);--> statement-breakpoint
CREATE INDEX `idx_kernel_runtime_events_org_created` ON `kernel_runtime_events` (`organization_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_kernel_runtime_events_conversation_created` ON `kernel_runtime_events` (`organization_id`,`conversation_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_kernel_runtime_events_run_created` ON `kernel_runtime_events` (`organization_id`,`run_id`,`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `idx_kernel_runtime_events_child_created` ON `kernel_runtime_events` (`organization_id`,`child_run_id`,`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `idx_kernel_runtime_events_delegated_tedi` ON `kernel_runtime_events` (`delegated_tedi_id`);--> statement-breakpoint
CREATE INDEX `idx_kernel_runtime_events_trace` ON `kernel_runtime_events` (`organization_id`,`trace_id`,`created_at`) WHERE trace_id is not null;--> statement-breakpoint
CREATE INDEX `idx_kernel_runtime_runs_conversation_updated` ON `kernel_runtime_runs` (`organization_id`,`conversation_id`,`updated_at`);--> statement-breakpoint
CREATE INDEX `idx_kernel_runtime_runs_status_updated` ON `kernel_runtime_runs` (`organization_id`,`status`,`updated_at`);--> statement-breakpoint
CREATE INDEX `idx_kernel_runtime_runs_child` ON `kernel_runtime_runs` (`delegated_tedi_id`,`child_run_id`);--> statement-breakpoint
CREATE INDEX `idx_kernel_runtime_runs_org_child` ON `kernel_runtime_runs` (`organization_id`,`child_run_id`);--> statement-breakpoint
CREATE INDEX `idx_kernel_runtime_runs_org_output_revision` ON `kernel_runtime_runs` (`organization_id`,`output_revision_id`);--> statement-breakpoint
CREATE INDEX `idx_kernel_runtime_runs_org_updated` ON `kernel_runtime_runs` (`organization_id`,`updated_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_kernel_tool_results_object_key` ON `kernel_tool_results` (`object_key`);--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_kernel_tool_results_source` ON `kernel_tool_results` (`organization_id`,`source_kind`,`source_id`);--> statement-breakpoint
CREATE INDEX `idx_kernel_tool_results_conversation_active` ON `kernel_tool_results` (`organization_id`,`conversation_id`,`evicted_at`,`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `idx_kernel_tool_results_cleanup` ON `kernel_tool_results` (`evicted_at`,`expires_at`,`id`);--> statement-breakpoint
CREATE INDEX `idx_kernel_tool_results_digest` ON `kernel_tool_results` (`organization_id`,`conversation_id`,`sha256`);--> statement-breakpoint
CREATE INDEX `idx_tedi_artifacts_org` ON `tedi_artifacts` (`organization_id`);--> statement-breakpoint
CREATE INDEX `idx_tedi_artifacts_tedi_created` ON `tedi_artifacts` (`tedi_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_tedi_artifacts_conversation` ON `tedi_artifacts` (`tedi_id`,`conversation_id`);--> statement-breakpoint
CREATE INDEX `idx_tedi_artifacts_run` ON `tedi_artifacts` (`tedi_id`,`run_id`);--> statement-breakpoint
CREATE INDEX `idx_tedi_artifacts_kind` ON `tedi_artifacts` (`tedi_id`,`kind`);