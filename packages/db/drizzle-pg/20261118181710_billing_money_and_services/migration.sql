CREATE TABLE "billing_capacity_allocations" (
	"id" text PRIMARY KEY,
	"organization_id" text NOT NULL,
	"pack_version_id" text,
	"budget_day" text NOT NULL,
	"token_amount" bigint DEFAULT 0 NOT NULL,
	"spend_amount_micros" bigint DEFAULT 0 NOT NULL,
	"source_type" text NOT NULL,
	"source_ref" text,
	"idempotency_key" text NOT NULL,
	"stripe_environment" text NOT NULL,
	"expires_at" text NOT NULL,
	"metadata" jsonb DEFAULT '{}' NOT NULL,
	"created_at" text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	CONSTRAINT "chk_billing_capacity_allocation_direction" CHECK (("token_amount" > 0 OR "spend_amount_micros" > 0) OR ("token_amount" < 0 OR "spend_amount_micros" < 0)),
	CONSTRAINT "chk_billing_capacity_allocation_same_direction" CHECK (("token_amount" >= 0 AND "spend_amount_micros" >= 0) OR ("token_amount" <= 0 AND "spend_amount_micros" <= 0))
);
--> statement-breakpoint
CREATE TABLE "billing_inference_capacity_pack_versions" (
	"id" text PRIMARY KEY,
	"pack_key" text NOT NULL,
	"version" integer NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"name" text NOT NULL,
	"currency" text DEFAULT 'usd' NOT NULL,
	"price_micros" bigint NOT NULL,
	"token_amount" bigint NOT NULL,
	"spend_amount_micros" bigint NOT NULL,
	"stripe_environment" text NOT NULL,
	"stripe_lookup_key" text NOT NULL,
	"metadata" jsonb DEFAULT '{}' NOT NULL,
	"effective_at" text NOT NULL,
	"created_at" text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	CONSTRAINT "chk_inference_capacity_pack_positive" CHECK ("price_micros" > 0 AND "token_amount" > 0 AND "spend_amount_micros" > 0)
);
--> statement-breakpoint
CREATE TABLE "billing_plan_service_allowances" (
	"id" text PRIMARY KEY,
	"plan_version_id" text NOT NULL,
	"service_key" text NOT NULL,
	"included_credits" bigint NOT NULL,
	"per_tedi_monthly_limit" bigint,
	"monthly_provider_cost_limit_micros" bigint,
	"created_at" text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE "billing_provider_usage" (
	"id" text PRIMARY KEY,
	"organization_id" text,
	"tedi_id" text,
	"reservation_id" text,
	"gateway_log_id" text,
	"provider_usage_id" text,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"usage_kind" text NOT NULL,
	"unit" text NOT NULL,
	"quantity" bigint NOT NULL,
	"provider_cost_micros" bigint DEFAULT 0 NOT NULL,
	"provider_cost_quality" text DEFAULT 'estimated' NOT NULL,
	"customer_metering_ready" boolean DEFAULT false NOT NULL,
	"occurred_at" text NOT NULL,
	"metadata" jsonb DEFAULT '{}' NOT NULL,
	"created_at" text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE "billing_service_credit_controls" (
	"organization_id" text NOT NULL,
	"service_key" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"monthly_credit_limit" bigint,
	"per_tedi_monthly_limit" bigint,
	"monthly_provider_cost_limit_micros" bigint,
	"updated_by" text,
	"metadata" jsonb DEFAULT '{}' NOT NULL,
	"created_at" text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"updated_at" text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE "billing_service_credit_entries" (
	"id" text PRIMARY KEY,
	"organization_id" text NOT NULL,
	"service_key" text NOT NULL,
	"kind" text NOT NULL,
	"amount_credits" bigint NOT NULL,
	"source_type" text NOT NULL,
	"source_ref" text,
	"reservation_id" text,
	"idempotency_key" text NOT NULL,
	"expires_at" text,
	"description" text,
	"metadata" jsonb DEFAULT '{}' NOT NULL,
	"created_at" text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	CONSTRAINT "chk_service_credit_nonzero" CHECK ("amount_credits" <> 0),
	CONSTRAINT "chk_service_credit_direction" CHECK (("kind" IN ('grant','refund') AND "amount_credits" > 0) OR ("kind" = 'debit' AND "amount_credits" < 0) OR "kind" = 'adjustment')
);
--> statement-breakpoint
CREATE TABLE "billing_service_credit_reservations" (
	"id" text PRIMARY KEY,
	"organization_id" text NOT NULL,
	"plan_version_id" text NOT NULL,
	"rate_card_id" text NOT NULL,
	"tedi_id" text,
	"service_key" text NOT NULL,
	"operation_key" text NOT NULL,
	"status" text DEFAULT 'reserved' NOT NULL,
	"credits_reserved" bigint NOT NULL,
	"customer_value_micros" bigint NOT NULL,
	"provider_cost_ceiling_micros" bigint NOT NULL,
	"actual_provider_cost_micros" bigint,
	"provider_usage_id" text,
	"period_start" text NOT NULL,
	"period_end" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"rejection_code" text,
	"expires_at" text NOT NULL,
	"settled_at" text,
	"released_at" text,
	"metadata" jsonb DEFAULT '{}' NOT NULL,
	"created_at" text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"updated_at" text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE "billing_service_rate_cards" (
	"id" text PRIMARY KEY,
	"service_key" text NOT NULL,
	"operation_key" text NOT NULL,
	"version" integer NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"provider" text NOT NULL,
	"provider_endpoint" text NOT NULL,
	"credit_cost" bigint NOT NULL,
	"customer_value_micros" bigint NOT NULL,
	"provider_cost_ceiling_micros" bigint NOT NULL,
	"effective_at" text NOT NULL,
	"metadata" jsonb DEFAULT '{}' NOT NULL,
	"created_at" text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE "billing_usage_charges" (
	"id" text PRIMARY KEY,
	"organization_id" text NOT NULL,
	"tedi_id" text,
	"reservation_id" text,
	"usage_period_id" text NOT NULL,
	"gateway_log_id" text,
	"provider_usage_id" text,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"source" text NOT NULL,
	"input_tokens" bigint DEFAULT 0 NOT NULL,
	"output_tokens" bigint DEFAULT 0 NOT NULL,
	"included_tokens_applied" bigint DEFAULT 0 NOT NULL,
	"metered_overage_tokens" bigint DEFAULT 0 NOT NULL,
	"provider_cost_micros" bigint DEFAULT 0 NOT NULL,
	"customer_charge_micros" bigint DEFAULT 0 NOT NULL,
	"credit_applied_micros" bigint DEFAULT 0 NOT NULL,
	"usage_quality" text DEFAULT 'gateway_reported' NOT NULL,
	"provider_cost_quality" text DEFAULT 'estimated' NOT NULL,
	"metering_ready" boolean DEFAULT false NOT NULL,
	"provider_reconciled_at" text,
	"rate_card_version" text,
	"occurred_at" text NOT NULL,
	"metadata" jsonb DEFAULT '{}' NOT NULL,
	"created_at" text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE "billing_usage_periods" (
	"id" text PRIMARY KEY,
	"organization_id" text NOT NULL,
	"plan_version_id" text NOT NULL,
	"period_start" text NOT NULL,
	"period_end" text NOT NULL,
	"included_tokens" bigint NOT NULL,
	"used_input_tokens" bigint DEFAULT 0 NOT NULL,
	"used_output_tokens" bigint DEFAULT 0 NOT NULL,
	"metered_overage_tokens" bigint DEFAULT 0 NOT NULL,
	"provider_cost_micros" bigint DEFAULT 0 NOT NULL,
	"customer_charge_micros" bigint DEFAULT 0 NOT NULL,
	"credit_applied_micros" bigint DEFAULT 0 NOT NULL,
	"settlement_version" integer DEFAULT 0 NOT NULL,
	"last_settlement_id" text,
	"created_at" text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"updated_at" text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE "stripe_meter_outbox" (
	"id" text PRIMARY KEY,
	"organization_id" text NOT NULL,
	"usage_charge_id" text NOT NULL,
	"stripe_customer_id" text NOT NULL,
	"stripe_environment" text DEFAULT 'live' NOT NULL,
	"event_name" text NOT NULL,
	"quantity" bigint NOT NULL,
	"idempotency_key" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" text NOT NULL,
	"lease_expires_at" text,
	"stripe_event_id" text,
	"last_error" text,
	"sent_at" text,
	"created_at" text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"updated_at" text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE "stripe_webhook_events" (
	"event_id" text PRIMARY KEY,
	"event_type" text NOT NULL,
	"entity_key" text NOT NULL,
	"event_created_at" integer NOT NULL,
	"status" text DEFAULT 'processing' NOT NULL,
	"attempt_count" integer DEFAULT 1 NOT NULL,
	"lease_expires_at" text,
	"outcome" text,
	"last_error" text,
	"processed_at" text,
	"created_at" text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"updated_at" text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE "provider_model_rate_versions" (
	"id" text PRIMARY KEY,
	"provider" text NOT NULL,
	"model_id" text NOT NULL,
	"deployment_scope" text NOT NULL,
	"input_token_min" bigint DEFAULT 0 NOT NULL,
	"input_token_max" bigint,
	"effective_from" text NOT NULL,
	"input_microusd_per_million" bigint NOT NULL,
	"output_microusd_per_million" bigint NOT NULL,
	"cache_read_microusd_per_million" bigint NOT NULL,
	"cache_write_microusd_per_million" bigint NOT NULL,
	"currency" text NOT NULL,
	"evidence_uri" text NOT NULL,
	"evidence_digest" text NOT NULL,
	"verified_at" text NOT NULL,
	"published_at" text NOT NULL,
	"published_by" text NOT NULL,
	"change_reason" text NOT NULL,
	"supersedes_rate_version_id" text,
	CONSTRAINT "chk_provider_model_rate_scope" CHECK (length(trim("deployment_scope", E'\t\n\r ')) > 0),
	CONSTRAINT "chk_provider_model_rate_interval" CHECK (("effective_from"::timestamptz) IS NOT NULL),
	CONSTRAINT "chk_provider_model_rate_currency" CHECK ("currency" = 'USD'),
	CONSTRAINT "chk_provider_model_rate_amounts" CHECK ("input_microusd_per_million" BETWEEN 0 AND 9007199254740991 AND "output_microusd_per_million" BETWEEN 0 AND 9007199254740991 AND "cache_read_microusd_per_million" BETWEEN 0 AND 9007199254740991 AND "cache_write_microusd_per_million" BETWEEN 0 AND 9007199254740991)
);
--> statement-breakpoint
ALTER TABLE "billing_plan_versions" ALTER COLUMN "overage_unit_tokens" SET DATA TYPE bigint USING "overage_unit_tokens"::bigint;--> statement-breakpoint
ALTER TABLE "billing_plan_versions" ALTER COLUMN "default_daily_token_limit" SET DATA TYPE bigint USING "default_daily_token_limit"::bigint;--> statement-breakpoint
ALTER TABLE "billing_usage_reservations" ALTER COLUMN "estimated_input_tokens" SET DATA TYPE bigint USING "estimated_input_tokens"::bigint;--> statement-breakpoint
ALTER TABLE "billing_usage_reservations" ALTER COLUMN "estimated_output_tokens" SET DATA TYPE bigint USING "estimated_output_tokens"::bigint;--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_billing_capacity_allocation_idempotency" ON "billing_capacity_allocations" ("idempotency_key");--> statement-breakpoint
CREATE INDEX "idx_billing_capacity_allocation_active" ON "billing_capacity_allocations" ("organization_id","stripe_environment","budget_day","expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_inference_capacity_pack_version" ON "billing_inference_capacity_pack_versions" ("pack_key","version","stripe_environment");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_inference_capacity_pack_lookup" ON "billing_inference_capacity_pack_versions" ("stripe_environment","stripe_lookup_key");--> statement-breakpoint
CREATE INDEX "idx_inference_capacity_pack_active" ON "billing_inference_capacity_pack_versions" ("stripe_environment","status","effective_at");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_billing_plan_service_allowance" ON "billing_plan_service_allowances" ("plan_version_id","service_key");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_billing_provider_usage_gateway_log" ON "billing_provider_usage" ("gateway_log_id") WHERE "gateway_log_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_billing_provider_usage_provider_id" ON "billing_provider_usage" ("provider_usage_id") WHERE "provider_usage_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_billing_provider_usage_org_occurred" ON "billing_provider_usage" ("organization_id","occurred_at");--> statement-breakpoint
CREATE INDEX "idx_billing_provider_usage_kind_occurred" ON "billing_provider_usage" ("usage_kind","occurred_at");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_billing_service_credit_control" ON "billing_service_credit_controls" ("organization_id","service_key");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_billing_service_credit_idempotency" ON "billing_service_credit_entries" ("idempotency_key");--> statement-breakpoint
CREATE INDEX "idx_billing_service_credit_org_service_created" ON "billing_service_credit_entries" ("organization_id","service_key","created_at");--> statement-breakpoint
CREATE INDEX "idx_billing_service_credit_expiry" ON "billing_service_credit_entries" ("organization_id","service_key","expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_billing_service_reservation_idempotency" ON "billing_service_credit_reservations" ("idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_billing_service_reservation_provider_usage" ON "billing_service_credit_reservations" ("provider_usage_id") WHERE "provider_usage_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_billing_service_reservation_org_status" ON "billing_service_credit_reservations" ("organization_id","service_key","status","expires_at");--> statement-breakpoint
CREATE INDEX "idx_billing_service_reservation_tedi_period" ON "billing_service_credit_reservations" ("tedi_id","service_key","period_start");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_billing_service_rate_card_version" ON "billing_service_rate_cards" ("service_key","operation_key","version");--> statement-breakpoint
CREATE INDEX "idx_billing_service_rate_card_active" ON "billing_service_rate_cards" ("service_key","operation_key","status","effective_at");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_billing_charge_gateway_log" ON "billing_usage_charges" ("gateway_log_id") WHERE "gateway_log_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_billing_charge_provider_usage" ON "billing_usage_charges" ("provider_usage_id") WHERE "provider_usage_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_billing_charge_org_occurred" ON "billing_usage_charges" ("organization_id","occurred_at");--> statement-breakpoint
CREATE INDEX "idx_billing_charge_monetary_eur" ON "billing_usage_charges" ("organization_id","occurred_at") WHERE metadata #> '{monetaryQuote,schemaVersion}' IN ('1'::jsonb, 'true'::jsonb) AND metadata #>> '{monetaryQuote,rateSnapshot,customerCurrency}' = 'EUR';--> statement-breakpoint
CREATE INDEX "idx_billing_charge_reservation" ON "billing_usage_charges" ("reservation_id");--> statement-breakpoint
CREATE INDEX "idx_billing_charge_metering" ON "billing_usage_charges" ("metering_ready","usage_quality","occurred_at");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_billing_usage_period" ON "billing_usage_periods" ("organization_id","period_start","period_end");--> statement-breakpoint
CREATE INDEX "idx_billing_usage_period_end" ON "billing_usage_periods" ("period_end");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_stripe_meter_outbox_idempotency" ON "stripe_meter_outbox" ("idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_stripe_meter_outbox_charge" ON "stripe_meter_outbox" ("usage_charge_id");--> statement-breakpoint
CREATE INDEX "idx_stripe_meter_outbox_retry" ON "stripe_meter_outbox" ("stripe_environment","status","next_attempt_at","lease_expires_at");--> statement-breakpoint
CREATE INDEX "idx_stripe_webhook_entity_created" ON "stripe_webhook_events" ("entity_key","event_created_at");--> statement-breakpoint
CREATE INDEX "idx_stripe_webhook_status_lease" ON "stripe_webhook_events" ("status","lease_expires_at");--> statement-breakpoint
CREATE INDEX "idx_provider_model_rate_lookup" ON "provider_model_rate_versions" ("provider","model_id","deployment_scope","effective_from");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_provider_model_rate_correction" ON "provider_model_rate_versions" ("supersedes_rate_version_id");--> statement-breakpoint
ALTER TABLE "billing_capacity_allocations" ADD CONSTRAINT "billing_capacity_allocations_N5kePr036EKP_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "billing_capacity_allocations" ADD CONSTRAINT "billing_capacity_allocations_YQSz7vgtOs3C_fkey" FOREIGN KEY ("pack_version_id") REFERENCES "billing_inference_capacity_pack_versions"("id");--> statement-breakpoint
ALTER TABLE "billing_plan_service_allowances" ADD CONSTRAINT "billing_plan_service_allowances_uXBC5wBVfnBQ_fkey" FOREIGN KEY ("plan_version_id") REFERENCES "billing_plan_versions"("id");--> statement-breakpoint
ALTER TABLE "billing_service_credit_controls" ADD CONSTRAINT "billing_service_credit_controls_KHMnfZjd1j2b_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "billing_service_credit_entries" ADD CONSTRAINT "billing_service_credit_entries_d9My7QhRPaQd_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "billing_service_credit_reservations" ADD CONSTRAINT "billing_service_credit_reservations_OpjBVL4KeXZ2_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "billing_service_credit_reservations" ADD CONSTRAINT "billing_service_credit_reservations_WWdnPuZxr2Vc_fkey" FOREIGN KEY ("plan_version_id") REFERENCES "billing_plan_versions"("id");--> statement-breakpoint
ALTER TABLE "billing_service_credit_reservations" ADD CONSTRAINT "billing_service_credit_reservations_1J16uazKux3y_fkey" FOREIGN KEY ("rate_card_id") REFERENCES "billing_service_rate_cards"("id");--> statement-breakpoint
ALTER TABLE "billing_usage_charges" ADD CONSTRAINT "billing_usage_charges_organization_id_organizations_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "billing_usage_charges" ADD CONSTRAINT "billing_usage_charges_8s0iptD8FAiM_fkey" FOREIGN KEY ("reservation_id") REFERENCES "billing_usage_reservations"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "billing_usage_charges" ADD CONSTRAINT "billing_usage_charges_cFWBKDzZ1Emu_fkey" FOREIGN KEY ("usage_period_id") REFERENCES "billing_usage_periods"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "billing_usage_periods" ADD CONSTRAINT "billing_usage_periods_organization_id_organizations_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "billing_usage_periods" ADD CONSTRAINT "billing_usage_periods_0IQCiT3At0RX_fkey" FOREIGN KEY ("plan_version_id") REFERENCES "billing_plan_versions"("id");--> statement-breakpoint
ALTER TABLE "stripe_meter_outbox" ADD CONSTRAINT "stripe_meter_outbox_organization_id_organizations_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "stripe_meter_outbox" ADD CONSTRAINT "stripe_meter_outbox_abM2v6p4NdQG_fkey" FOREIGN KEY ("usage_charge_id") REFERENCES "billing_usage_charges"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "provider_model_rate_versions" ADD CONSTRAINT "provider_model_rate_versions_kJJxR17OwTjV_fkey" FOREIGN KEY ("supersedes_rate_version_id") REFERENCES "provider_model_rate_versions"("id") ON DELETE RESTRICT;