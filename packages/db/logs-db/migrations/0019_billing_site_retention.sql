-- Logs database schema, rendered by scripts/logs-db-schema.ts.
-- Log tables without foreign keys, plus logs-local metadata.
CREATE TABLE "provider_execution_attempts" (
	"id" text PRIMARY KEY,
	"organization_id" text NOT NULL,
	"tedi_id" text,
	"source" text NOT NULL,
	"run_id" text,
	"work_item_id" text,
	"trace_id" text,
	"idempotency_key" text NOT NULL,
	"settlement_mode" text NOT NULL,
	"billing_reservation_id" text,
	"provider" text NOT NULL,
	"request_model" text NOT NULL,
	"gateway_account_id" text,
	"gateway_id" text,
	"transport_kind" text NOT NULL,
	"api_kind" text NOT NULL,
	"provider_resource" text,
	"provider_origin" text,
	"deployment" text,
	"deployment_scope" text NOT NULL,
	"authorized_at" text NOT NULL,
	"send_before" text NOT NULL,
	"origin" text,
	"origin_hash" text,
	"policy" text,
	"policy_hash" text
);
CREATE UNIQUE INDEX "uniq_provider_execution_admission" ON "provider_execution_attempts" ("organization_id", "idempotency_key");
CREATE INDEX "idx_provider_execution_authorized" ON "provider_execution_attempts" ("authorized_at");

-- Logs database schema, rendered by scripts/logs-db-schema.ts.
-- Log tables without foreign keys, plus logs-local metadata.
CREATE TABLE "billing_usage_quarantines" (
	"id" text PRIMARY KEY,
	"gateway_log_id" text NOT NULL,
	"organization_id" text,
	"reason" text NOT NULL,
	"source_snapshot_at" text NOT NULL,
	"metadata" text NOT NULL DEFAULT '{}',
	"created_at" text NOT NULL
);
CREATE UNIQUE INDEX "uniq_billing_usage_quarantine_gateway_log" ON "billing_usage_quarantines" ("gateway_log_id");
CREATE INDEX "idx_billing_usage_quarantine_reason_created" ON "billing_usage_quarantines" ("reason", "created_at");
CREATE INDEX "idx_billing_usage_quarantine_created" ON "billing_usage_quarantines" ("created_at");

-- Logs database schema, rendered by scripts/logs-db-schema.ts.
-- Log tables without foreign keys, plus logs-local metadata.
CREATE TABLE "site_reconciliation_runs" (
	"id" text PRIMARY KEY,
	"organization_id" text NOT NULL,
	"source" text NOT NULL,
	"started_at" text NOT NULL,
	"completed_at" text NOT NULL,
	"sites_checked" integer NOT NULL,
	"issue_count" integer NOT NULL,
	"created_at" text NOT NULL
);
CREATE INDEX "idx_site_reconciliation_runs_org_completed" ON "site_reconciliation_runs" ("organization_id", "completed_at");
CREATE INDEX "idx_site_reconciliation_runs_completed" ON "site_reconciliation_runs" ("completed_at");
CREATE INDEX `idx_call_costs_execution` ON `tedi_call_costs` (`provider_execution_id`);
