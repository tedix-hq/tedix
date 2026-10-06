CREATE TABLE `__new_provider_execution_attempts` (
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
	`gateway_account_id` text,
	`gateway_id` text,
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
	CONSTRAINT "chk_provider_execution_provider" CHECK(("provider" = 'azure-openai' AND "provider_resource" IS NOT NULL AND "provider_origin" IS NOT NULL AND "deployment" IS NOT NULL AND "deployment" = "request_model" AND "api_kind" IN ('azure-chat','azure-responses') AND "transport_kind" IN ('gateway-https','gateway-binding')) OR ("provider" = 'workers-ai' AND "provider_resource" IS NULL AND "provider_origin" IS NULL AND "deployment" IS NULL AND "api_kind" = 'workers-ai-chat' AND "transport_kind" IN ('gateway-https','gateway-binding','workers-ai-binding')) OR ("provider" = 'typesafe' AND "provider_resource" IS NULL AND "deployment" IS NULL AND "api_kind" = 'typesafe-systemone' AND (("request_model" = 'typesafe/jev' AND "transport_kind" = 'cloudflare-ai-https' AND "provider_origin" IS NULL) OR ("request_model" = 'jev-1.13.0' AND "transport_kind" = 'direct-https' AND "provider_origin" IS NOT NULL AND "provider_origin" = 'https://api.typesafe.ai' AND "gateway_account_id" IS NULL AND "gateway_id" IS NULL)))),
	CONSTRAINT "chk_provider_execution_identity" CHECK(("transport_kind" = 'direct-https' OR ("gateway_account_id" IS NOT NULL AND "gateway_id" IS NOT NULL AND length(trim("gateway_account_id")) > 0 AND length(trim("gateway_id")) > 0)) AND length(trim("request_model")) > 0 AND length(trim("deployment_scope")) > 0 AND length(trim("organization_id")) > 0)
);
--> statement-breakpoint
INSERT INTO `__new_provider_execution_attempts`(`id`, `organization_id`, `tedi_id`, `source`, `run_id`, `work_item_id`, `trace_id`, `idempotency_key`, `settlement_mode`, `billing_reservation_id`, `provider`, `request_model`, `gateway_account_id`, `gateway_id`, `transport_kind`, `api_kind`, `provider_resource`, `provider_origin`, `deployment`, `deployment_scope`, `authorized_at`, `send_before`) SELECT `id`, `organization_id`, `tedi_id`, `source`, `run_id`, `work_item_id`, `trace_id`, `idempotency_key`, `settlement_mode`, `billing_reservation_id`, `provider`, `request_model`, `gateway_account_id`, `gateway_id`, `transport_kind`, `api_kind`, `provider_resource`, `provider_origin`, `deployment`, `deployment_scope`, `authorized_at`, `send_before` FROM `provider_execution_attempts`;--> statement-breakpoint
DROP TABLE `provider_execution_attempts`;--> statement-breakpoint
ALTER TABLE `__new_provider_execution_attempts` RENAME TO `provider_execution_attempts`;--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_provider_execution_admission` ON `provider_execution_attempts` (`organization_id`,`idempotency_key`);--> statement-breakpoint
CREATE INDEX `idx_provider_execution_run` ON `provider_execution_attempts` (`organization_id`,`run_id`);