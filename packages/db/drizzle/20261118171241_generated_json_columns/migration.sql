ALTER TABLE `work_items` ADD `repository_observer` integer GENERATED ALWAYS AS (CASE WHEN json_valid("metadata") THEN json_extract("metadata", '$.repositoryObserver') END) VIRTUAL;--> statement-breakpoint
ALTER TABLE `work_items` ADD `report` text GENERATED ALWAYS AS (CASE WHEN json_valid("metadata") THEN json_extract("metadata", '$.report') END) VIRTUAL;--> statement-breakpoint
ALTER TABLE `work_items` ADD `observer_woken_at` text GENERATED ALWAYS AS (CASE WHEN json_valid("metadata") THEN json_extract("metadata", '$.observerWokenAt') END) VIRTUAL;--> statement-breakpoint
ALTER TABLE `work_items` ADD `metadata_executor` text GENERATED ALWAYS AS (CASE WHEN json_valid("metadata") THEN json_extract("metadata", '$.executor') END) VIRTUAL;--> statement-breakpoint
ALTER TABLE `work_items` ADD `metadata_source` text GENERATED ALWAYS AS (CASE WHEN json_valid("metadata") THEN json_extract("metadata", '$.source') END) VIRTUAL;--> statement-breakpoint
ALTER TABLE `work_interactions` ADD `source` text GENERATED ALWAYS AS (CASE WHEN json_valid("metadata") THEN json_extract("metadata", '$.source') END) VIRTUAL;--> statement-breakpoint
ALTER TABLE `tedi_approval_requests` ADD `execution_status` text GENERATED ALWAYS AS (CASE WHEN json_valid("payload") THEN json_extract("payload", '$.execution.status') END) VIRTUAL;--> statement-breakpoint
ALTER TABLE `tedi_approval_requests` ADD `execution_dismissed_at` text GENERATED ALWAYS AS (CASE WHEN json_valid("payload") THEN json_extract("payload", '$.execution.dismissedAt') END) VIRTUAL;--> statement-breakpoint
ALTER TABLE `tedi_approval_requests` ADD `consumed_at` text GENERATED ALWAYS AS (CASE WHEN json_valid("payload") THEN json_extract("payload", '$.consumedAt') END) VIRTUAL;--> statement-breakpoint
ALTER TABLE `kernel_runtime_runs` ADD `work_item_id` text GENERATED ALWAYS AS (CASE WHEN json_valid("metadata") THEN json_extract("metadata", '$.workItemId') END) VIRTUAL;--> statement-breakpoint
ALTER TABLE `kernel_runtime_runs` ADD `target_tedi_id` text GENERATED ALWAYS AS (CASE WHEN json_valid("metadata") THEN json_extract("metadata", '$.homeDelegation.workOrder.targetTediId') END) VIRTUAL;--> statement-breakpoint
DROP INDEX IF EXISTS `idx_work_items_open_repository_observation`;--> statement-breakpoint
DROP INDEX IF EXISTS `idx_work_items_deferred_repository_wake`;--> statement-breakpoint
DROP INDEX IF EXISTS `idx_work_items_woken_repository_observation`;--> statement-breakpoint
DROP INDEX IF EXISTS `idx_approval_requests_open_tool_run`;--> statement-breakpoint
CREATE INDEX `idx_work_items_metadata_executor` ON `work_items` (`org_id`,`metadata_executor`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_work_items_metadata_source` ON `work_items` (`org_id`,`metadata_source`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_work_items_observer_report_woken` ON `work_items` (`org_id`,`project_id`,`repository_observer`,`report`,`observer_woken_at`);--> statement-breakpoint
CREATE INDEX `idx_work_items_open_repository_observation_columns` ON `work_items` (`created_at`,`id`) WHERE repository_observer = 1 AND disposition NOT IN ('completed', 'cancelled');--> statement-breakpoint
CREATE INDEX `idx_work_items_deferred_repository_wake_columns` ON `work_items` (`created_at`,`id`) WHERE repository_observer = 1 AND json_extract(metadata, '$.observerWakeDeferredAt') IS NOT NULL AND observer_woken_at IS NULL AND report IS NULL;--> statement-breakpoint
CREATE INDEX `idx_work_items_woken_repository_observation_columns` ON `work_items` (`org_id`,`project_id`,`id`) WHERE repository_observer = 1 AND observer_woken_at IS NOT NULL AND report IS NULL AND (disposition IN ('proposed','accepted') OR (disposition = 'cancelled' AND json_extract(metadata, '$.settleReason') = 'advisory push observation'));--> statement-breakpoint
CREATE INDEX `idx_work_interactions_source_status_org` ON `work_interactions` (`source`,`status`,`org_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_approval_requests_execution_attention` ON `tedi_approval_requests` (`org_id`,`status`,`action_type`,`execution_dismissed_at`,`execution_status`,`expires_at`);--> statement-breakpoint
CREATE INDEX `idx_approval_requests_unconsumed` ON `tedi_approval_requests` (`consumed_at`,`execution_status`,`expires_at`);--> statement-breakpoint
CREATE INDEX `idx_approval_requests_open_execution` ON `tedi_approval_requests` (execution_status,`expires_at`) WHERE status = 'approved' AND action_type = 'mcp.tool_call' AND execution_status IN ('queued', 'running', 'failed') AND execution_dismissed_at IS NULL;--> statement-breakpoint
CREATE INDEX `idx_kernel_runtime_runs_work_item` ON `kernel_runtime_runs` (`organization_id`,`work_item_id`,`updated_at`);--> statement-breakpoint
CREATE INDEX `idx_kernel_runtime_runs_target_tedi` ON `kernel_runtime_runs` (`organization_id`,`status`,`target_tedi_id`,`updated_at`);