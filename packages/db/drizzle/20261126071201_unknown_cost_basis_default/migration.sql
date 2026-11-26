-- tedix: destructive-reviewed Work-Item: bb1f0291-da4f-458e-8b1f-ee9ab28d4e86
-- Rebuild only the default; copy every stored value and restore the attribution guard.
CREATE TABLE `__new_tedi_call_costs` (
	`id` text PRIMARY KEY,
	`tedi_id` text,
	`org_id` text,
	`gateway_log_id` text NOT NULL,
	`gateway_id` text NOT NULL,
	`snapshot_at` text NOT NULL,
	`model` text NOT NULL,
	`provider` text,
	`provider_resource` text,
	`provider_base_url` text,
	`deployment` text,
	`run_id` text,
	`work_item_id` text,
	`billing_reservation_id` text,
	`session_key_hash` text,
	`session_type` text DEFAULT 'unattributed' NOT NULL,
	`source` text DEFAULT 'ai-gateway-log' NOT NULL,
	`usage_kind` text,
	`usage_unit` text,
	`usage_quantity` integer,
	`input_tokens` integer DEFAULT 0 NOT NULL,
	`output_tokens` integer DEFAULT 0 NOT NULL,
	`cache_read_tokens` integer DEFAULT 0 NOT NULL,
	`cache_write_tokens` integer DEFAULT 0 NOT NULL,
	`total_tokens` integer DEFAULT 0 NOT NULL,
	`estimated_cost_usd` real,
	`provider_execution_id` text,
	`call_duration_ms` real,
	`raw_reported_cost_usd` real,
	`provider_rate_version_id` text,
	`cost_basis` text DEFAULT 'unknown' NOT NULL,
	`cost_reason` text,
	`session_count` integer DEFAULT 0 NOT NULL,
	`success` integer DEFAULT true NOT NULL,
	`cached` integer DEFAULT false NOT NULL,
	`data_quality` text DEFAULT 'ok' NOT NULL,
	`created_at` text DEFAULT (CURRENT_TIMESTAMP),
	CONSTRAINT `fk_tedi_call_costs_tedi_id_tedis_id_fk` FOREIGN KEY (`tedi_id`) REFERENCES `tedis`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_tedi_call_costs_org_id_organizations_id_fk` FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
INSERT INTO `__new_tedi_call_costs`(`id`, `tedi_id`, `org_id`, `gateway_log_id`, `gateway_id`, `snapshot_at`, `model`, `provider`, `provider_resource`, `provider_base_url`, `deployment`, `run_id`, `work_item_id`, `billing_reservation_id`, `session_key_hash`, `session_type`, `source`, `usage_kind`, `usage_unit`, `usage_quantity`, `input_tokens`, `output_tokens`, `cache_read_tokens`, `cache_write_tokens`, `total_tokens`, `estimated_cost_usd`, `provider_execution_id`, `call_duration_ms`, `raw_reported_cost_usd`, `provider_rate_version_id`, `cost_basis`, `cost_reason`, `session_count`, `success`, `cached`, `data_quality`, `created_at`) SELECT `id`, `tedi_id`, `org_id`, `gateway_log_id`, `gateway_id`, `snapshot_at`, `model`, `provider`, `provider_resource`, `provider_base_url`, `deployment`, `run_id`, `work_item_id`, `billing_reservation_id`, `session_key_hash`, `session_type`, `source`, `usage_kind`, `usage_unit`, `usage_quantity`, `input_tokens`, `output_tokens`, `cache_read_tokens`, `cache_write_tokens`, `total_tokens`, `estimated_cost_usd`, `provider_execution_id`, `call_duration_ms`, `raw_reported_cost_usd`, `provider_rate_version_id`, `cost_basis`, `cost_reason`, `session_count`, `success`, `cached`, `data_quality`, `created_at` FROM `tedi_call_costs`;--> statement-breakpoint
DROP TABLE `tedi_call_costs`;--> statement-breakpoint
ALTER TABLE `__new_tedi_call_costs` RENAME TO `tedi_call_costs`;--> statement-breakpoint
CREATE INDEX `idx_call_costs_org` ON `tedi_call_costs` (`org_id`,`snapshot_at`);--> statement-breakpoint
CREATE INDEX `idx_call_costs_created` ON `tedi_call_costs` (`created_at`);--> statement-breakpoint
CREATE INDEX `idx_call_costs_window` ON `tedi_call_costs` (`tedi_id`,`snapshot_at`);--> statement-breakpoint
CREATE INDEX `idx_call_costs_model` ON `tedi_call_costs` (`tedi_id`,`model`,`snapshot_at`);--> statement-breakpoint
CREATE INDEX `idx_call_costs_run` ON `tedi_call_costs` (`run_id`,`snapshot_at`);--> statement-breakpoint
CREATE INDEX `idx_call_costs_work_item` ON `tedi_call_costs` (`work_item_id`,`snapshot_at`);--> statement-breakpoint
CREATE INDEX `idx_call_costs_billing_reservation` ON `tedi_call_costs` (`billing_reservation_id`);--> statement-breakpoint
CREATE INDEX `idx_call_costs_execution` ON `tedi_call_costs` (`provider_execution_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_call_costs_gateway_log_id` ON `tedi_call_costs` (`gateway_log_id`);--> statement-breakpoint
CREATE INDEX `idx_call_costs_provider_units_queue` ON `tedi_call_costs` (`snapshot_at`,`gateway_log_id`) WHERE "tedi_call_costs"."usage_kind" IS NOT NULL;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS require_org_id_for_attributed_calls BEFORE INSERT ON tedi_call_costs WHEN NEW.session_type IN ('tedi', 'tedi_observer', 'kernel') AND NEW.org_id IS NULL BEGIN SELECT RAISE(ABORT, 'tedi_call_costs: org_id is required when session_type is tedi/tedi_observer/kernel'); END;
