CREATE TABLE `provider_execution_attempts` (
	`id` text PRIMARY KEY,
	`organization_id` text NOT NULL,
	`tedi_id` text,
	`source` text NOT NULL,
	`run_id` text,
	`work_item_id` text,
	`trace_id` text,
	`idempotency_key` text NOT NULL,
	`settlement_mode` text NOT NULL,
	`billing_reservation_id` text,
	`provider` text NOT NULL,
	`request_model` text NOT NULL,
	`gateway_account_id` text NOT NULL,
	`gateway_id` text NOT NULL,
	`transport_kind` text NOT NULL,
	`api_kind` text NOT NULL,
	`provider_resource` text,
	`provider_origin` text,
	`deployment` text,
	`deployment_scope` text NOT NULL,
	`authorized_at` text NOT NULL,
	`send_before` text NOT NULL,
	CONSTRAINT "chk_provider_execution_window" CHECK(julianday("authorized_at") IS NOT NULL AND julianday("send_before") IS NOT NULL AND julianday("send_before") > julianday("authorized_at")),
	CONSTRAINT "chk_provider_execution_reservation" CHECK(("settlement_mode" = 'managed' AND "billing_reservation_id" IS NOT NULL) OR ("settlement_mode" IN ('external','disabled') AND "billing_reservation_id" IS NULL)),
	CONSTRAINT "chk_provider_execution_provider" CHECK(("provider" = 'azure-openai' AND "provider_resource" IS NOT NULL AND "provider_origin" IS NOT NULL AND "deployment" IS NOT NULL AND "deployment" = "request_model" AND "api_kind" IN ('azure-chat','azure-responses') AND "transport_kind" IN ('gateway-https','gateway-binding')) OR ("provider" = 'workers-ai' AND "provider_resource" IS NULL AND "provider_origin" IS NULL AND "deployment" IS NULL AND "api_kind" = 'workers-ai-chat' AND "transport_kind" IN ('gateway-https','gateway-binding','workers-ai-binding'))),
	CONSTRAINT "chk_provider_execution_identity" CHECK(length(trim("gateway_account_id")) > 0 AND length(trim("gateway_id")) > 0 AND length(trim("request_model")) > 0 AND length(trim("deployment_scope")) > 0 AND length(trim("organization_id")) > 0)
);
--> statement-breakpoint
ALTER TABLE `tedi_call_costs` ADD `provider_execution_id` text;--> statement-breakpoint
ALTER TABLE `tedi_call_costs` ADD `raw_reported_cost_usd` real;--> statement-breakpoint
ALTER TABLE `tedi_call_costs` ADD `provider_rate_version_id` text;--> statement-breakpoint
ALTER TABLE `tedi_call_costs` ADD `cost_basis` text DEFAULT 'legacy_estimate' NOT NULL;--> statement-breakpoint
ALTER TABLE `tedi_call_costs` ADD `cost_reason` text;--> statement-breakpoint
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
	`raw_reported_cost_usd` real,
	`provider_rate_version_id` text,
	`cost_basis` text DEFAULT 'legacy_estimate' NOT NULL,
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
INSERT INTO `__new_tedi_call_costs`(`id`, `tedi_id`, `org_id`, `gateway_log_id`, `gateway_id`, `snapshot_at`, `model`, `provider`, `provider_resource`, `provider_base_url`, `deployment`, `run_id`, `work_item_id`, `billing_reservation_id`, `session_key_hash`, `session_type`, `source`, `usage_kind`, `usage_unit`, `usage_quantity`, `input_tokens`, `output_tokens`, `cache_read_tokens`, `cache_write_tokens`, `total_tokens`, `estimated_cost_usd`, `session_count`, `success`, `cached`, `data_quality`, `created_at`) SELECT `id`, `tedi_id`, `org_id`, `gateway_log_id`, `gateway_id`, `snapshot_at`, `model`, `provider`, `provider_resource`, `provider_base_url`, `deployment`, `run_id`, `work_item_id`, `billing_reservation_id`, `session_key_hash`, `session_type`, `source`, `usage_kind`, `usage_unit`, `usage_quantity`, `input_tokens`, `output_tokens`, `cache_read_tokens`, `cache_write_tokens`, `total_tokens`, `estimated_cost_usd`, `session_count`, `success`, `cached`, `data_quality`, `created_at` FROM `tedi_call_costs`;--> statement-breakpoint
DROP TABLE `tedi_call_costs`;--> statement-breakpoint
ALTER TABLE `__new_tedi_call_costs` RENAME TO `tedi_call_costs`;--> statement-breakpoint
CREATE INDEX `idx_call_costs_org` ON `tedi_call_costs` (`org_id`,`snapshot_at`);--> statement-breakpoint
CREATE INDEX `idx_call_costs_window` ON `tedi_call_costs` (`tedi_id`,`snapshot_at`);--> statement-breakpoint
CREATE INDEX `idx_call_costs_model` ON `tedi_call_costs` (`tedi_id`,`model`,`snapshot_at`);--> statement-breakpoint
CREATE INDEX `idx_call_costs_source` ON `tedi_call_costs` (`tedi_id`,`source`,`snapshot_at`);--> statement-breakpoint
CREATE INDEX `idx_call_costs_run` ON `tedi_call_costs` (`run_id`,`snapshot_at`);--> statement-breakpoint
CREATE INDEX `idx_call_costs_work_item` ON `tedi_call_costs` (`work_item_id`,`snapshot_at`);--> statement-breakpoint
CREATE INDEX `idx_call_costs_billing_reservation` ON `tedi_call_costs` (`billing_reservation_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_call_costs_gateway_log_id` ON `tedi_call_costs` (`gateway_log_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_provider_execution_admission` ON `provider_execution_attempts` (`organization_id`,`idempotency_key`);--> statement-breakpoint
CREATE INDEX `idx_provider_execution_run` ON `provider_execution_attempts` (`organization_id`,`run_id`);
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS require_org_id_for_attributed_calls BEFORE INSERT ON tedi_call_costs WHEN NEW.session_type IN ('tedi', 'tedi_observer', 'kernel') AND NEW.org_id IS NULL BEGIN SELECT RAISE(ABORT, 'tedi_call_costs: org_id is required when session_type is tedi/tedi_observer/kernel'); END;
