-- Logs database schema, rendered by scripts/logs-db-schema.ts.
-- Log tables without foreign keys, plus logs-local metadata.
CREATE TABLE "tedi_call_costs" (
	"id" text PRIMARY KEY,
	"tedi_id" text,
	"org_id" text,
	"gateway_log_id" text NOT NULL,
	"gateway_id" text NOT NULL,
	"snapshot_at" text NOT NULL,
	"model" text NOT NULL,
	"provider" text,
	"provider_resource" text,
	"provider_base_url" text,
	"deployment" text,
	"run_id" text,
	"work_item_id" text,
	"billing_reservation_id" text,
	"session_key_hash" text,
	"session_type" text NOT NULL DEFAULT 'unattributed',
	"source" text NOT NULL DEFAULT 'ai-gateway-log',
	"usage_kind" text,
	"usage_unit" text,
	"usage_quantity" integer,
	"input_tokens" integer NOT NULL DEFAULT 0,
	"output_tokens" integer NOT NULL DEFAULT 0,
	"cache_read_tokens" integer NOT NULL DEFAULT 0,
	"cache_write_tokens" integer NOT NULL DEFAULT 0,
	"total_tokens" integer NOT NULL DEFAULT 0,
	"estimated_cost_usd" real,
	"provider_execution_id" text,
	"call_duration_ms" real,
	"raw_reported_cost_usd" real,
	"provider_rate_version_id" text,
	"cost_basis" text NOT NULL DEFAULT 'legacy_estimate',
	"cost_reason" text,
	"session_count" integer NOT NULL DEFAULT 0,
	"success" integer NOT NULL DEFAULT 1,
	"cached" integer NOT NULL DEFAULT 0,
	"data_quality" text NOT NULL DEFAULT 'ok',
	"created_at" text
);
CREATE INDEX "idx_call_costs_org" ON "tedi_call_costs" ("org_id", "snapshot_at");
CREATE INDEX "idx_call_costs_window" ON "tedi_call_costs" ("tedi_id", "snapshot_at");
CREATE INDEX "idx_call_costs_model" ON "tedi_call_costs" ("tedi_id", "model", "snapshot_at");
CREATE INDEX "idx_call_costs_source" ON "tedi_call_costs" ("tedi_id", "source", "snapshot_at");
CREATE INDEX "idx_call_costs_run" ON "tedi_call_costs" ("run_id", "snapshot_at");
CREATE INDEX "idx_call_costs_work_item" ON "tedi_call_costs" ("work_item_id", "snapshot_at");
CREATE INDEX "idx_call_costs_billing_reservation" ON "tedi_call_costs" ("billing_reservation_id");
CREATE UNIQUE INDEX "idx_call_costs_gateway_log_id" ON "tedi_call_costs" ("gateway_log_id");
CREATE INDEX "idx_call_costs_provider_units_queue" ON "tedi_call_costs" ("snapshot_at", "gateway_log_id") WHERE "usage_kind" IS NOT NULL;
