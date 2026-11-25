CREATE TABLE "agent_session_events" (
	"id" text PRIMARY KEY,
	"organization_id" text NOT NULL,
	"user_id" text NOT NULL,
	"harness" text NOT NULL,
	"session_key" text NOT NULL,
	"repository" text,
	"kind" text NOT NULL,
	"body" text NOT NULL,
	"body_r2_key" text,
	"has_activity" boolean DEFAULT false NOT NULL,
	"body_archived_at" text,
	"activity" text,
	"source_at" text NOT NULL,
	"source_key" text NOT NULL,
	"status" text NOT NULL,
	"attempts" bigint DEFAULT 0 NOT NULL,
	"claimed_at" text,
	"processed_at" text,
	"lesson_reflection" jsonb,
	"created_at" text DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_session_requests" (
	"id" text PRIMARY KEY,
	"organization_id" text NOT NULL,
	"user_id" text NOT NULL,
	"harness" text NOT NULL,
	"session_key" text NOT NULL,
	"repository" text,
	"project_id" text,
	"kind" text NOT NULL,
	"text" text NOT NULL,
	"status" text NOT NULL,
	"evidence" text,
	"turns_unaddressed" bigint DEFAULT 0 NOT NULL,
	"lane_running" boolean DEFAULT false NOT NULL,
	"last_reflected_at" text,
	"source_at" text NOT NULL,
	"source_key" text NOT NULL,
	"status_changed_at" text NOT NULL,
	"created_at" text DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') NOT NULL,
	"updated_at" text DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') NOT NULL
);
--> statement-breakpoint
CREATE TABLE "api_keys" (
	"id" text PRIMARY KEY,
	"organization_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"purpose" text DEFAULT 'general' NOT NULL,
	"key_hash" text NOT NULL UNIQUE,
	"key_preview" text NOT NULL,
	"scopes" jsonb,
	"environment" text DEFAULT 'test',
	"last_used_at" text,
	"requests_this_month" bigint DEFAULT 0,
	"total_requests" bigint DEFAULT 0,
	"ip_allowlist" jsonb,
	"expires_at" text,
	"rate_limit" bigint,
	"status" text DEFAULT 'active',
	"rotated_at" text,
	"rotation_schedule_days" bigint,
	"previous_key_hash" text,
	"previous_key_expires_at" text,
	"revoked_at" text,
	"revoked_by" text,
	"revoke_reason" text,
	"metadata" jsonb,
	"created_by" text,
	"created_at" text DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
	"updated_at" text DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
);
--> statement-breakpoint
CREATE TABLE "app_adapter_secret_bindings" (
	"id" text PRIMARY KEY,
	"adapter_id" text NOT NULL,
	"app_id" text NOT NULL,
	"config_path" text NOT NULL,
	"secret_id" text NOT NULL,
	"secret_scope" text NOT NULL,
	"created_at" text DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') NOT NULL,
	"updated_at" text DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app_adapters" (
	"id" text PRIMARY KEY,
	"app_id" text NOT NULL,
	"name" text NOT NULL,
	"display_name" text,
	"adapter_type" text NOT NULL,
	"config" jsonb,
	"field_mappings" jsonb,
	"verticals" jsonb,
	"enabled" boolean DEFAULT true,
	"priority" bigint DEFAULT 0,
	"created_at" text DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
	"updated_at" text DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
);
--> statement-breakpoint
CREATE TABLE "app_catalog" (
	"id" text PRIMARY KEY,
	"slug" text UNIQUE,
	"name" text NOT NULL,
	"description" text,
	"model_description" text,
	"base_url" text,
	"mcp_endpoint_normalized" text,
	"mcp_endpoint_hash" text,
	"connector_type" text NOT NULL,
	"distribution_channel" text,
	"developer_type" text,
	"status" text DEFAULT 'ENABLED',
	"category" text,
	"developer" text,
	"website" text,
	"privacy_policy" text,
	"terms_of_service" text,
	"is_discoverable" boolean DEFAULT true,
	"explore_shadowed" boolean DEFAULT false NOT NULL,
	"service" text,
	"logo_url" text,
	"logo_url_dark" text,
	"keywords_for_discovery" jsonb,
	"keywords_for_triggering" jsonb,
	"version" text,
	"version_id" text,
	"version_notes" text,
	"review_status" text,
	"seo_description" text,
	"screenshots" jsonb,
	"categories" jsonb,
	"sub_categories" jsonb,
	"has_writes" boolean DEFAULT false,
	"has_interactive" boolean DEFAULT false,
	"has_file_search" boolean DEFAULT false,
	"has_deep_research" boolean DEFAULT false,
	"has_sync" boolean DEFAULT false,
	"auth_types" jsonb,
	"supports_full_actions" boolean,
	"mcp_tool_count" bigint DEFAULT 0,
	"mcp_resource_count" bigint DEFAULT 0,
	"mcp_prompt_count" bigint DEFAULT 0,
	"protocol_version" text,
	"supports_resources" boolean DEFAULT false,
	"supports_prompts" boolean DEFAULT false,
	"supports_sampling" boolean DEFAULT false,
	"supports_roots" boolean DEFAULT false,
	"health_status" text DEFAULT 'unknown',
	"safety_status" text,
	"mcp_metadata" jsonb,
	"health_data" jsonb,
	"scores" jsonb,
	"system_hints" jsonb,
	"first_seen" jsonb,
	"rich_content" jsonb,
	"documentation_url" text,
	"support_url" text,
	"scan_auth_headers" text,
	"scan_connection_id" text,
	"scan_connection_header" text,
	"scan_connection_template" text,
	"scan_organization_id" text,
	"scan_client_credentials_token_url" text,
	"raw_data" jsonb,
	"source_created_at" text,
	"last_synced_at" text NOT NULL,
	"sync_source" text DEFAULT 'api',
	"tool_source" text DEFAULT 'upstream_mcp' NOT NULL,
	"created_at" text DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
	"updated_at" text DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
	"vendor_key" text
);
--> statement-breakpoint
CREATE TABLE "app_catalog_browse_totals" (
	"id" text PRIMARY KEY,
	"total" bigint NOT NULL,
	"explore_total" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app_catalog_category_totals" (
	"category" text PRIMARY KEY,
	"total" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app_catalog_changes" (
	"id" text PRIMARY KEY,
	"catalog_app_id" text NOT NULL,
	"change_type" text NOT NULL,
	"field_name" text,
	"old_value" text,
	"new_value" text,
	"version_before" text,
	"version_after" text,
	"detected_at" text DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') NOT NULL,
	"sync_log_id" text
);
--> statement-breakpoint
CREATE TABLE "app_catalog_health_history" (
	"id" text PRIMARY KEY,
	"catalog_app_id" text NOT NULL,
	"checked_at" text NOT NULL,
	"status" text NOT NULL,
	"connect_time_ms" bigint,
	"total_time_ms" bigint,
	"transport_used" text,
	"auth_state" text,
	"server_version" text,
	"tool_count" bigint,
	"resource_count" bigint,
	"prompt_count" bigint,
	"error_message" text,
	"error_class" text
);
--> statement-breakpoint
CREATE TABLE "app_catalog_mcp_prompts" (
	"id" text PRIMARY KEY,
	"catalog_app_id" text NOT NULL,
	"prompt_name" text NOT NULL,
	"title" text,
	"description" text,
	"arguments" jsonb,
	"icons" jsonb,
	"annotations" jsonb,
	"meta" jsonb,
	"detected_at" text NOT NULL,
	"removed_at" text,
	"last_seen_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app_catalog_mcp_resource_templates" (
	"id" text PRIMARY KEY,
	"catalog_app_id" text NOT NULL,
	"name" text NOT NULL,
	"title" text,
	"uri_template" text NOT NULL,
	"description" text,
	"mime_type" text,
	"icons" jsonb,
	"annotations" jsonb,
	"meta" jsonb,
	"detected_at" text NOT NULL,
	"removed_at" text,
	"last_seen_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app_catalog_mcp_resources" (
	"id" text PRIMARY KEY,
	"catalog_app_id" text NOT NULL,
	"uri" text NOT NULL,
	"name" text,
	"title" text,
	"description" text,
	"mime_type" text,
	"icons" jsonb,
	"annotations" jsonb,
	"meta" jsonb,
	"detected_at" text NOT NULL,
	"removed_at" text,
	"last_seen_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app_catalog_mcp_skills" (
	"id" text PRIMARY KEY,
	"catalog_app_id" text NOT NULL,
	"skill_uri" text NOT NULL,
	"frontmatter" jsonb NOT NULL,
	"resources" jsonb NOT NULL,
	"detected_at" text NOT NULL,
	"last_seen_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app_catalog_mcp_tools" (
	"id" text PRIMARY KEY,
	"catalog_app_id" text NOT NULL,
	"tool_name" text NOT NULL,
	"title" text,
	"description" text,
	"input_schema" jsonb DEFAULT '{"type":"object","properties":{},"additionalProperties":false}' NOT NULL,
	"output_schema" jsonb,
	"icons" jsonb,
	"execution_task_support" text,
	"annotations" jsonb,
	"meta" jsonb,
	"schema_dialect" text,
	"schema_source" text,
	"schema_source_ref" text,
	"schema_source_hash" text,
	"schema_synced_at" text,
	"detected_at" text NOT NULL,
	"removed_at" text,
	"last_seen_at" text NOT NULL,
	"last_tested_at" text,
	"last_test_success" boolean,
	"test_success_rate" double precision,
	"avg_latency_ms" bigint,
	"test_count" bigint DEFAULT 0,
	"example_input" jsonb,
	"example_output" jsonb,
	"ai_clarity_score" double precision
);
--> statement-breakpoint
CREATE TABLE "app_catalog_store_listings" (
	"id" text PRIMARY KEY,
	"catalog_app_id" text NOT NULL,
	"source" text NOT NULL,
	"source_app_id" text NOT NULL,
	"regions" jsonb,
	"store_url" text,
	"review_status" text,
	"auth_required" boolean DEFAULT false,
	"store_logo_url" text,
	"store_description" text,
	"popularity_score" bigint,
	"trending_score" bigint,
	"rank" bigint,
	"works_with" jsonb,
	"last_synced_at" text NOT NULL,
	"raw_data" jsonb,
	"created_at" text DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
);
--> statement-breakpoint
CREATE TABLE "app_catalog_sync_logs" (
	"id" text PRIMARY KEY,
	"sync_type" text NOT NULL,
	"source" text,
	"started_at" text NOT NULL,
	"completed_at" text,
	"apps_discovered" bigint DEFAULT 0,
	"apps_updated" bigint DEFAULT 0,
	"apps_removed" bigint DEFAULT 0,
	"apps_failed" bigint DEFAULT 0,
	"status" text DEFAULT 'running',
	"error" text,
	"details" jsonb
);
--> statement-breakpoint
CREATE TABLE "app_catalog_tool_tests" (
	"id" text PRIMARY KEY,
	"catalog_app_id" text NOT NULL,
	"tool_name" text NOT NULL,
	"tested_at" text NOT NULL,
	"test_type" text NOT NULL,
	"input_source" text NOT NULL,
	"success" boolean NOT NULL,
	"latency_ms" bigint,
	"error_message" text,
	"error_class" text,
	"input_used" jsonb,
	"output_received" jsonb,
	"output_valid" boolean,
	"ai_model" text,
	"ai_prompt_used" text,
	"ai_tool_selection_correct" boolean,
	"ai_output_quality_score" double precision,
	"ai_tokens_used" bigint
);
--> statement-breakpoint
CREATE TABLE "app_config_versions" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid(),
	"app_id" text NOT NULL,
	"version" bigint NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"config" jsonb NOT NULL,
	"change_summary" text,
	"published_at" text,
	"published_by" text,
	"activated_at" text,
	"activated_by" text,
	"created_by" text,
	"created_at" text DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
	"updated_at" text DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
);
--> statement-breakpoint
CREATE TABLE "app_secrets" (
	"id" text PRIMARY KEY,
	"app_id" text NOT NULL,
	"name" text NOT NULL,
	"encrypted_value" text NOT NULL,
	"hint" text,
	"key_version" bigint DEFAULT 1 NOT NULL,
	"created_by" text,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app_templates" (
	"id" text PRIMARY KEY,
	"version" bigint DEFAULT 1 NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL UNIQUE,
	"description" text,
	"vertical" text NOT NULL,
	"capabilities" jsonb,
	"adapters" jsonb,
	"tools" jsonb,
	"field_mappings" jsonb,
	"extraction_config" jsonb,
	"required_fields" jsonb,
	"optional_fields" jsonb,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" text DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
	"updated_at" text DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
);
--> statement-breakpoint
CREATE TABLE "app_tool_csp_domains" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid(),
	"app_tool_id" text NOT NULL,
	"domain_type" text NOT NULL,
	"domain_url" text NOT NULL,
	"active" boolean DEFAULT true,
	"created_at" text DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
);
--> statement-breakpoint
CREATE TABLE "app_tools" (
	"id" text PRIMARY KEY,
	"app_id" text NOT NULL,
	"tool_type_id" text NOT NULL,
	"tool_id" text NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"input_schema" jsonb DEFAULT '{"type":"object","properties":{},"additionalProperties":false}' NOT NULL,
	"output_schema" jsonb,
	"adapter_scope" text DEFAULT 'primary',
	"result_strategy" text DEFAULT 'merge',
	"output_template" text,
	"widget_route" text,
	"widget_key" text,
	"widget_accessible" boolean DEFAULT true,
	"auth_required" boolean DEFAULT false,
	"visibility" text DEFAULT 'public',
	"icons" jsonb,
	"execution_task_support" text,
	"annotations" jsonb,
	"write_capability" text,
	"action_type" text,
	"sensitive_data" boolean DEFAULT false NOT NULL,
	"public_egress" boolean DEFAULT false NOT NULL,
	"meta" jsonb,
	"invocation_status" jsonb,
	"file_params" jsonb,
	"widget_description" text,
	"widget_prefers_border" boolean DEFAULT true,
	"widget_domain" text,
	"config" jsonb,
	"schema_dialect" text,
	"schema_source" text,
	"schema_source_ref" text,
	"schema_source_hash" text,
	"schema_synced_at" text,
	"contract_hash" text,
	"enabled" boolean DEFAULT true,
	"review_state" text DEFAULT 'live' NOT NULL,
	"review_diff" jsonb,
	"review_batch_id" text,
	"review_pending" jsonb,
	"sort_order" bigint DEFAULT 0,
	"created_at" text DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
	"updated_at" text DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
);
--> statement-breakpoint
CREATE TABLE "apps" (
	"id" text PRIMARY KEY,
	"organization_id" text NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"description" text,
	"custom_mcp_domain" text UNIQUE,
	"openai_challenge_token" text,
	"openai_app_id" text,
	"app_store_status" text DEFAULT 'draft',
	"discovery_status" text DEFAULT 'pending',
	"primary_domain" text,
	"visibility" text DEFAULT 'private',
	"logo_url" text,
	"metadata" jsonb,
	"gating_metadata" jsonb,
	"source_app_id" text,
	"catalog_app_id" text,
	"active_config_version_id" text,
	"latest_config_version" bigint DEFAULT 0 NOT NULL,
	"extracted_at" text,
	"ai_search_synced_at" text,
	"created_at" text DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
	"updated_at" text DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
);
--> statement-breakpoint
CREATE TABLE "artifact_redaction_candidates" (
	"id" text PRIMARY KEY,
	"organization_id" text NOT NULL,
	"tedi_id" text NOT NULL,
	"parent_artifact_id" text NOT NULL,
	"parent_content_digest" text NOT NULL,
	"child_artifact_id" text NOT NULL,
	"child_content_digest" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"created_by_member_id" text NOT NULL,
	"created_by_user_id" text NOT NULL,
	"created_at" text DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') NOT NULL
);
--> statement-breakpoint
CREATE TABLE "artifact_release_reviews" (
	"id" text PRIMARY KEY,
	"organization_id" text NOT NULL,
	"tedi_id" text NOT NULL,
	"candidate_id" text NOT NULL,
	"event_type" text NOT NULL,
	"previous_review_id" text NOT NULL,
	"target_approval_id" text,
	"child_content_digest" text NOT NULL,
	"reviewer_member_id" text NOT NULL,
	"reviewer_user_id" text NOT NULL,
	"reviewer_descope_user_id" text NOT NULL,
	"attestation" text NOT NULL,
	"created_at" text DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_events" (
	"id" text PRIMARY KEY,
	"organization_id" text NOT NULL,
	"actor_id" text NOT NULL,
	"actor_type" text NOT NULL,
	"action" text NOT NULL,
	"resource_type" text NOT NULL,
	"resource_id" text,
	"metadata" jsonb,
	"ip_address" text,
	"user_agent" text,
	"timestamp" timestamp with time zone NOT NULL,
	"trace_id" text
);
--> statement-breakpoint
CREATE TABLE "audit_metadata_refs" (
	"organization_id" text,
	"ref" text,
	"kind" text NOT NULL,
	"value" text NOT NULL,
	CONSTRAINT "audit_metadata_refs_pkey" PRIMARY KEY("organization_id","ref")
);
--> statement-breakpoint
CREATE TABLE "auth_context_cache_state" (
	"id" bigint PRIMARY KEY,
	"version" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "billing_accounts" (
	"organization_id" text PRIMARY KEY,
	"plan_version_id" text NOT NULL,
	"status" text DEFAULT 'trial' NOT NULL,
	"billing_mode" text DEFAULT 'trial' NOT NULL,
	"stripe_environment" text,
	"stripe_customer_id" text,
	"stripe_subscription_id" text,
	"stripe_cancel_at_period_end" boolean,
	"stripe_webhook_customer_key" text,
	"stripe_webhook_event_created_at" bigint,
	"period_start" text NOT NULL,
	"period_end" text NOT NULL,
	"overage_enabled" boolean DEFAULT false NOT NULL,
	"hard_spend_limit_micros" bigint,
	"included_credits_override" bigint,
	"grace_ends_at" text,
	"entitlement_version" bigint DEFAULT 1 NOT NULL,
	"metadata" jsonb DEFAULT '{}' NOT NULL,
	"created_at" text DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') NOT NULL,
	"updated_at" text DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') NOT NULL
);
--> statement-breakpoint
CREATE TABLE "billing_cloudflare_daily_costs" (
	"account_id" text,
	"service" text,
	"day" text,
	"cost_micros" bigint NOT NULL,
	"consumed_quantity" double precision,
	"consumed_unit" text,
	"fetched_at" text NOT NULL,
	CONSTRAINT "billing_cloudflare_daily_costs_pkey" PRIMARY KEY("account_id","service","day")
);
--> statement-breakpoint
CREATE TABLE "billing_cost_rollups" (
	"id" bigint PRIMARY KEY,
	"organization_id" text NOT NULL,
	"day" text NOT NULL,
	"tedi_id" text,
	"session_type" text NOT NULL,
	"source" text NOT NULL,
	"model" text NOT NULL,
	"provider" text,
	"provider_resource" text,
	"provider_base_url" text,
	"deployment" text,
	"cost_basis" text NOT NULL,
	"success" boolean NOT NULL,
	"input_tokens" bigint NOT NULL,
	"output_tokens" bigint NOT NULL,
	"cache_read_tokens" bigint NOT NULL,
	"cache_write_tokens" bigint NOT NULL,
	"total_tokens" bigint NOT NULL,
	"estimated_cost_usd" double precision NOT NULL,
	"call_count" bigint NOT NULL,
	"priced_call_count" bigint NOT NULL,
	"unpriced_tokens" bigint NOT NULL,
	"reviewed_call_count" bigint NOT NULL,
	"reviewed_tokens" bigint NOT NULL,
	"reviewed_cost_micros" bigint NOT NULL,
	"retired_call_count" bigint NOT NULL,
	"latest_snapshot_at" text NOT NULL,
	"latest_call_id" text NOT NULL,
	"stale" boolean DEFAULT false NOT NULL,
	"computed_at" text DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') NOT NULL
);
--> statement-breakpoint
CREATE TABLE "billing_credit_caps" (
	"organization_id" text,
	"subject_kind" text,
	"subject_key" text,
	"monthly_cap_credits" bigint NOT NULL,
	"updated_by" text,
	"created_at" text DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') NOT NULL,
	"updated_at" text DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') NOT NULL,
	CONSTRAINT "billing_credit_caps_pkey" PRIMARY KEY("organization_id","subject_kind","subject_key")
);
--> statement-breakpoint
CREATE TABLE "billing_credit_consumptions" (
	"id" text PRIMARY KEY,
	"organization_id" text NOT NULL,
	"tedi_id" text,
	"user_id" text,
	"kind" text NOT NULL,
	"source_ref" text NOT NULL,
	"period_start" text NOT NULL,
	"period_end" text NOT NULL,
	"credits" bigint NOT NULL,
	"included_credits" bigint NOT NULL,
	"top_up_credits" bigint NOT NULL,
	"payg_credits" bigint NOT NULL,
	"payg_charge_micros" bigint NOT NULL,
	"created_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "billing_credit_meter_outbox" (
	"id" text PRIMARY KEY,
	"organization_id" text NOT NULL,
	"consumption_id" text NOT NULL,
	"stripe_customer_id" text NOT NULL,
	"stripe_environment" text NOT NULL,
	"event_name" text NOT NULL,
	"quantity" bigint NOT NULL,
	"idempotency_key" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempt_count" bigint DEFAULT 0 NOT NULL,
	"next_attempt_at" text NOT NULL,
	"lease_expires_at" text,
	"stripe_event_id" text,
	"last_error" text,
	"sent_at" text,
	"created_at" text DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') NOT NULL,
	"updated_at" text DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') NOT NULL
);
--> statement-breakpoint
CREATE TABLE "billing_credit_notice_deliveries" (
	"id" text PRIMARY KEY,
	"organization_id" text NOT NULL,
	"period_start" text NOT NULL,
	"threshold" bigint NOT NULL,
	"channel" text NOT NULL,
	"recipient_user_id" text NOT NULL,
	"recipient_email" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempt_count" bigint DEFAULT 0 NOT NULL,
	"next_attempt_at" text NOT NULL,
	"lease_expires_at" text,
	"delivery_ref" text,
	"last_error" text,
	"sent_at" text,
	"created_at" text DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') NOT NULL,
	"updated_at" text DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') NOT NULL
);
--> statement-breakpoint
CREATE TABLE "billing_credit_notices" (
	"organization_id" text,
	"period_start" text,
	"threshold" bigint,
	"reached_at" text NOT NULL,
	"deliveries_planned_at" text,
	CONSTRAINT "billing_credit_notices_pkey" PRIMARY KEY("organization_id","period_start","threshold")
);
--> statement-breakpoint
CREATE TABLE "billing_credit_top_ups" (
	"id" text PRIMARY KEY,
	"organization_id" text NOT NULL,
	"credits" bigint NOT NULL,
	"consumed_credits" bigint DEFAULT 0 NOT NULL,
	"source_type" text NOT NULL,
	"source_ref" text,
	"pack_version_id" text,
	"idempotency_key" text NOT NULL,
	"expires_at" text NOT NULL,
	"metadata" jsonb DEFAULT '{}' NOT NULL,
	"created_at" text DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') NOT NULL,
	"updated_at" text DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') NOT NULL
);
--> statement-breakpoint
CREATE TABLE "billing_credit_usage_totals" (
	"organization_id" text,
	"period_start" text,
	"period_end" text NOT NULL,
	"subject_kind" text,
	"subject_key" text,
	"ai_credits" bigint DEFAULT 0 NOT NULL,
	"code_run_credits" bigint DEFAULT 0 NOT NULL,
	"service_credits" bigint DEFAULT 0 NOT NULL,
	"included_credits" bigint DEFAULT 0 NOT NULL,
	"top_up_credits" bigint DEFAULT 0 NOT NULL,
	"payg_credits" bigint DEFAULT 0 NOT NULL,
	"payg_charge_micros" bigint DEFAULT 0 NOT NULL,
	"updated_at" text NOT NULL,
	CONSTRAINT "billing_credit_usage_totals_pkey" PRIMARY KEY("organization_id","period_start","subject_kind","subject_key")
);
--> statement-breakpoint
CREATE TABLE "billing_gateway_reconciliations" (
	"id" text PRIMARY KEY,
	"day" text NOT NULL,
	"gateway_id" text NOT NULL,
	"provider" text NOT NULL,
	"model" text DEFAULT '' NOT NULL,
	"ledger_cost_micros" bigint NOT NULL,
	"gateway_cost_micros" bigint NOT NULL,
	"difference_micros" bigint NOT NULL,
	"ledger_row_count" bigint DEFAULT 0 NOT NULL,
	"gateway_request_count" bigint DEFAULT 0 NOT NULL,
	"coverage" jsonb,
	"status" text NOT NULL,
	"computed_at" text DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') NOT NULL
);
--> statement-breakpoint
CREATE TABLE "billing_historical_decisions" (
	"id" text PRIMARY KEY,
	"organization_id" text NOT NULL,
	"tedi_id" text NOT NULL,
	"revision" bigint NOT NULL,
	"kind" text NOT NULL,
	"decision_id" text,
	"operation_id" text NOT NULL,
	"request_hash" text NOT NULL,
	"payload" jsonb NOT NULL,
	"recorded_by" text NOT NULL,
	"recorded_user_id" text NOT NULL,
	"recorded_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "billing_historical_exposures" (
	"id" text PRIMARY KEY,
	"organization_id" text NOT NULL,
	"tedi_id" text NOT NULL,
	"object_id" text NOT NULL,
	"object_name" text NOT NULL,
	"generation" bigint NOT NULL,
	"snapshot_id" text NOT NULL,
	"source_hash" text NOT NULL,
	"operation_id" text NOT NULL,
	"request_hash" text NOT NULL,
	"exposure" text NOT NULL,
	"payload" jsonb NOT NULL,
	"observed_by" text NOT NULL,
	"observed_user_id" text NOT NULL,
	"observed_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "billing_inference_policies" (
	"id" text PRIMARY KEY,
	"organization_id" text NOT NULL,
	"scope" text NOT NULL,
	"subject_key" text NOT NULL,
	"tedi_id" text,
	"allowed_model_tiers" jsonb,
	"created_at" text DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') NOT NULL,
	"updated_at" text DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') NOT NULL
);
--> statement-breakpoint
CREATE TABLE "billing_plan_versions" (
	"id" text PRIMARY KEY,
	"plan_key" text NOT NULL,
	"version" bigint NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"name" text NOT NULL,
	"currency" text DEFAULT 'usd' NOT NULL,
	"monthly_price_micros" bigint DEFAULT 0 NOT NULL,
	"annual_price_micros" bigint DEFAULT 0 NOT NULL,
	"included_monthly_credits" bigint DEFAULT 0 NOT NULL,
	"credit_fx" jsonb,
	"max_tedis" bigint NOT NULL,
	"max_cron_jobs_per_tedi" bigint NOT NULL,
	"max_iterations_per_task" bigint NOT NULL,
	"allow_overage" boolean DEFAULT false NOT NULL,
	"metadata" jsonb DEFAULT '{}' NOT NULL,
	"effective_at" text NOT NULL,
	"created_at" text DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') NOT NULL
);
--> statement-breakpoint
CREATE TABLE "billing_provider_cost_evidence_versions" (
	"id" text PRIMARY KEY,
	"original_org_id" text NOT NULL,
	"source_gateway_id" text NOT NULL,
	"gateway_log_id" text NOT NULL,
	"source_call_id" text NOT NULL,
	"scope_digest" text NOT NULL,
	"original_source_digest" text NOT NULL,
	"occurred_at" text NOT NULL,
	"recorded_at" text NOT NULL,
	"provider" text NOT NULL,
	"native_model" text NOT NULL,
	"native_facts_receipt_digest" text NOT NULL,
	"basis_facts_digest" text NOT NULL,
	"financial_manifest_digest" text NOT NULL,
	"financial_work_id" text NOT NULL,
	"financial_spec_revision" text NOT NULL,
	"approval_proposal_id" text NOT NULL,
	"approval_decision_id" text NOT NULL,
	"attempt_id" text NOT NULL,
	"admission_id" text NOT NULL,
	"created_by_actor_type" text NOT NULL,
	"created_by_actor_id" text NOT NULL,
	"created_by_session_id" text NOT NULL,
	"idempotency_digest" text NOT NULL,
	"payload_digest" text NOT NULL,
	"original_tedi_id" text,
	"original_run_id" text,
	"original_work_id" text,
	"original_execution_id" text,
	"original_reservation_id" text,
	"rate_certificate_digest" text,
	"reported_cost_decimal" text,
	"reported_reporter" text,
	"supersedes_evidence_version_id" text,
	"original_source_snapshot" jsonb NOT NULL,
	"deployment_scope" jsonb NOT NULL,
	"rate_certificate_snapshot" jsonb,
	"reported_estimate_snapshot" jsonb,
	"financial_manifest_snapshot" jsonb NOT NULL,
	"approval_decision_snapshot" jsonb NOT NULL,
	"original_source_version" bigint NOT NULL,
	"input_tokens" bigint NOT NULL,
	"output_tokens" bigint NOT NULL,
	"cache_read_tokens" bigint NOT NULL,
	"cache_write_tokens" bigint NOT NULL,
	"provider_estimated_cost_micros" bigint NOT NULL,
	"financial_work_version" bigint NOT NULL,
	"input_price_micros_per_million" bigint,
	"output_price_micros_per_million" bigint,
	"cache_read_price_micros_per_million" bigint,
	"cache_write_price_micros_per_million" bigint,
	"native_usage_known" boolean NOT NULL,
	"kind" text NOT NULL,
	"currency" text NOT NULL,
	"pricing_basis" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "billing_provider_reconciliations" (
	"id" text PRIMARY KEY,
	"provider" text NOT NULL,
	"provider_resource" text DEFAULT '' NOT NULL,
	"period_start" text NOT NULL,
	"period_end" text NOT NULL,
	"ledger_cost_micros" bigint NOT NULL,
	"provider_cost_micros" bigint NOT NULL,
	"variance_micros" bigint NOT NULL,
	"usage_row_count" bigint DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"evidence_ref" text,
	"reconciled_by" text,
	"reconciled_at" text,
	"metadata" jsonb DEFAULT '{}' NOT NULL,
	"created_at" text DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') NOT NULL,
	"updated_at" text DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') NOT NULL
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
	"created_at" text DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') NOT NULL
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
	"created_at" text DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') NOT NULL,
	"updated_at" text DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') NOT NULL
);
--> statement-breakpoint
CREATE TABLE "billing_service_credit_reservations" (
	"id" text PRIMARY KEY,
	"organization_id" text NOT NULL,
	"plan_version_id" text NOT NULL,
	"rate_card_id" text NOT NULL,
	"tedi_id" text,
	"user_id" text,
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
	"created_at" text DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') NOT NULL,
	"updated_at" text DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') NOT NULL
);
--> statement-breakpoint
CREATE TABLE "billing_service_rate_cards" (
	"id" text PRIMARY KEY,
	"service_key" text NOT NULL,
	"operation_key" text NOT NULL,
	"version" bigint NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"provider" text NOT NULL,
	"provider_endpoint" text NOT NULL,
	"credit_cost" bigint NOT NULL,
	"customer_value_micros" bigint NOT NULL,
	"provider_cost_ceiling_micros" bigint NOT NULL,
	"effective_at" text NOT NULL,
	"metadata" jsonb DEFAULT '{}' NOT NULL,
	"created_at" text DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') NOT NULL
);
--> statement-breakpoint
CREATE TABLE "billing_settlement_cursors" (
	"name" text PRIMARY KEY,
	"after_rowid" bigint NOT NULL,
	"full_sweep_at" text NOT NULL,
	"updated_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "billing_top_up_pack_versions" (
	"id" text PRIMARY KEY,
	"pack_key" text NOT NULL,
	"version" bigint NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"name" text NOT NULL,
	"currency" text DEFAULT 'eur' NOT NULL,
	"price_micros" bigint NOT NULL,
	"credits" bigint NOT NULL,
	"valid_months" bigint NOT NULL,
	"stripe_environment" text NOT NULL,
	"stripe_lookup_key" text NOT NULL,
	"effective_at" text NOT NULL,
	"created_at" text DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') NOT NULL
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
	"credits" bigint DEFAULT 0 NOT NULL,
	"usage_quality" text DEFAULT 'gateway_reported' NOT NULL,
	"provider_cost_quality" text DEFAULT 'estimated' NOT NULL,
	"metering_ready" boolean DEFAULT false NOT NULL,
	"provider_reconciled_at" text,
	"rate_card_version" text,
	"occurred_at" text NOT NULL,
	"metadata" jsonb DEFAULT '{}' NOT NULL,
	"created_at" text DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') NOT NULL
);
--> statement-breakpoint
CREATE TABLE "billing_usage_periods" (
	"id" text PRIMARY KEY,
	"organization_id" text NOT NULL,
	"plan_version_id" text NOT NULL,
	"period_start" text NOT NULL,
	"period_end" text NOT NULL,
	"used_input_tokens" bigint DEFAULT 0 NOT NULL,
	"used_output_tokens" bigint DEFAULT 0 NOT NULL,
	"provider_cost_micros" bigint DEFAULT 0 NOT NULL,
	"settlement_version" bigint DEFAULT 0 NOT NULL,
	"last_settlement_id" text,
	"created_at" text DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') NOT NULL,
	"updated_at" text DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') NOT NULL
);
--> statement-breakpoint
CREATE TABLE "billing_usage_quarantines" (
	"id" text PRIMARY KEY,
	"gateway_log_id" text NOT NULL,
	"organization_id" text,
	"reason" text NOT NULL,
	"source_snapshot_at" text NOT NULL,
	"metadata" jsonb DEFAULT '{}' NOT NULL,
	"created_at" text DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') NOT NULL
);
--> statement-breakpoint
CREATE TABLE "billing_usage_reservations" (
	"id" text PRIMARY KEY,
	"organization_id" text NOT NULL,
	"plan_version_id" text NOT NULL,
	"tedi_id" text,
	"status" text DEFAULT 'reserved' NOT NULL,
	"source" text NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"estimated_input_tokens" bigint DEFAULT 0 NOT NULL,
	"estimated_output_tokens" bigint DEFAULT 0 NOT NULL,
	"estimated_charge_micros" bigint DEFAULT 0 NOT NULL,
	"credits" bigint DEFAULT 0 NOT NULL,
	"user_id" text,
	"period_start" text NOT NULL,
	"period_end" text NOT NULL,
	"run_id" text,
	"trace_id" text,
	"idempotency_key" text NOT NULL,
	"rejection_code" text,
	"expires_at" text NOT NULL,
	"settled_at" text,
	"released_at" text,
	"metadata" jsonb DEFAULT '{}' NOT NULL,
	"created_at" text DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') NOT NULL,
	"updated_at" text DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') NOT NULL
);
--> statement-breakpoint
CREATE TABLE "calendar_coordinator_configurations" (
	"id" text PRIMARY KEY,
	"organization_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"owner_user_id" text NOT NULL,
	"revision" bigint NOT NULL,
	"mode" text NOT NULL,
	"configuration" text NOT NULL,
	"ownership_seed" text NOT NULL,
	"lease_id" text,
	"lease_until" bigint DEFAULT 0 NOT NULL,
	"fence" bigint DEFAULT 0 NOT NULL,
	"last_receipt" text,
	"last_successful_reconcile_at" text,
	"updated_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "calendar_coordinator_mirrors" (
	"id" text PRIMARY KEY,
	"organization_id" text NOT NULL,
	"configuration_id" text NOT NULL,
	"source_key" text NOT NULL,
	"destination_key" text NOT NULL,
	"mirror" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "calendar_coordinator_mutations" (
	"id" text PRIMARY KEY,
	"organization_id" text NOT NULL,
	"configuration_id" text NOT NULL,
	"plan_id" text NOT NULL,
	"action_id" text NOT NULL,
	"state" text NOT NULL,
	"mutation" text NOT NULL,
	"updated_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "calendar_coordinator_plans" (
	"id" text PRIMARY KEY,
	"organization_id" text NOT NULL,
	"configuration_id" text NOT NULL,
	"configuration_revision" bigint NOT NULL,
	"plan" text NOT NULL,
	"created_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "capability_links" (
	"id" text PRIMARY KEY,
	"capability_id" text NOT NULL,
	"organization_id" text NOT NULL,
	"entity_kind" text NOT NULL,
	"entity_id" text NOT NULL,
	"created_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "chat_dispatch_idempotency" (
	"idempotency_key" text PRIMARY KEY,
	"tedi_id" text NOT NULL,
	"organization_id" text,
	"conversation_id" text NOT NULL,
	"run_id" text,
	"status" text DEFAULT 'queued' NOT NULL,
	"created_at" text DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') NOT NULL,
	"mapped_at" text
);
--> statement-breakpoint
CREATE TABLE "cms_capture_cron_pauses" (
	"site_id" text PRIMARY KEY,
	"slug" text NOT NULL,
	"capture_id" text NOT NULL,
	"expires_at_unix" bigint NOT NULL,
	"drained_at_unix" bigint
);
--> statement-breakpoint
CREATE TABLE "cms_deprovision_operations" (
	"id" text PRIMARY KEY,
	"organization_id" text NOT NULL,
	"slug" text NOT NULL,
	"authoring_app_id" text,
	"status" text DEFAULT 'queued' NOT NULL,
	"stage" text DEFAULT 'queued' NOT NULL,
	"deleted" jsonb DEFAULT '[]' NOT NULL,
	"errors" jsonb DEFAULT '[]' NOT NULL,
	"created_at" text DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') NOT NULL,
	"updated_at" text DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cms_domain_claims" (
	"id" text PRIMARY KEY,
	"organization_id" text NOT NULL,
	"site_id" text,
	"hostname" text NOT NULL,
	"kind" text DEFAULT 'primary' NOT NULL,
	"verification_token" text NOT NULL,
	"provider_hostname_id" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"expires_at" text NOT NULL,
	"created_at" text DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') NOT NULL,
	"updated_at" text DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cms_restore_fences" (
	"site_id" text PRIMARY KEY,
	"slug" text NOT NULL,
	"generation" text NOT NULL,
	"capture_id" text NOT NULL,
	"restore_epoch" bigint,
	"closed_at" text DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cms_restore_permits" (
	"id" text PRIMARY KEY,
	"site_id" text NOT NULL,
	"slug" text NOT NULL,
	"restore_epoch" bigint DEFAULT 0 NOT NULL,
	"kind" text NOT NULL,
	"entered_at" text DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cms_sites" (
	"id" text PRIMARY KEY,
	"organization_id" text NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"status" text DEFAULT 'active' NOT NULL,
	"restore_epoch" bigint DEFAULT 0 NOT NULL,
	"canonical_url" text NOT NULL,
	"custom_domain" text UNIQUE,
	"public_path_prefix" text,
	"template_slug" text DEFAULT 'tedix' NOT NULL,
	"config" jsonb,
	"mcp_app_id" text,
	"authoring_app_id" text,
	"created_at" text DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') NOT NULL,
	"updated_at" text DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') NOT NULL
);
--> statement-breakpoint
CREATE TABLE "commitment_wake_outbox" (
	"id" text PRIMARY KEY,
	"kind" text NOT NULL,
	"org_id" text NOT NULL,
	"source_kind" text NOT NULL,
	"source_id" text NOT NULL,
	"change_key" text,
	"due_at" text NOT NULL,
	"next_send_at" text NOT NULL,
	"cursor" jsonb,
	"completed_at" text
);
--> statement-breakpoint
CREATE TABLE "competency_observation_attestations" (
	"id" text PRIMARY KEY,
	"organization_id" text NOT NULL,
	"observation_id" text NOT NULL,
	"principal_type" text NOT NULL,
	"principal_id" text NOT NULL,
	"verdict" text NOT NULL,
	"verification_method" text NOT NULL,
	"independence_verified" boolean NOT NULL,
	"authenticated_at" text NOT NULL,
	"created_at" text DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') NOT NULL
);
--> statement-breakpoint
CREATE TABLE "competency_observations" (
	"id" text PRIMARY KEY,
	"organization_id" text NOT NULL,
	"tedi_id" text NOT NULL,
	"executor_type" text NOT NULL,
	"executor_id" text NOT NULL,
	"activity_id" text NOT NULL,
	"client_observation_id" text NOT NULL,
	"input_hash" text NOT NULL,
	"execution_opportunity_id" text NOT NULL,
	"work_item_id" text,
	"source_kind" text NOT NULL,
	"source_id" text NOT NULL,
	"trace_bundle_id" text,
	"rationale_id" text,
	"task_family" text NOT NULL,
	"risk_level" text NOT NULL,
	"environment" text NOT NULL,
	"rubric_version" bigint NOT NULL,
	"harness" text NOT NULL,
	"harness_version" text NOT NULL,
	"model_provider" text NOT NULL,
	"model_id" text NOT NULL,
	"model_version" text NOT NULL,
	"outcome" text NOT NULL,
	"complexity" double precision NOT NULL,
	"non_trivial" boolean NOT NULL,
	"held_out" boolean NOT NULL,
	"calibration_score" double precision NOT NULL,
	"escalation_quality" double precision NOT NULL,
	"learning_transfer" boolean NOT NULL,
	"evidence_refs" jsonb NOT NULL,
	"eligibility_status" text DEFAULT 'pending' NOT NULL,
	"evaluator_type" text,
	"evaluator_id" text,
	"classification_method" text NOT NULL,
	"evaluation_run_id" text,
	"proof_verified_at" text,
	"cost_minor_units" bigint,
	"cost_currency" text,
	"duration_ms" bigint,
	"owner_review_minutes" double precision,
	"policy_violation_severity" bigint DEFAULT 0 NOT NULL,
	"confidence" double precision NOT NULL,
	"metadata" jsonb,
	"occurred_at" text NOT NULL,
	"created_at" text DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') NOT NULL
);
--> statement-breakpoint
CREATE TABLE "connection_connect_tickets" (
	"id" text PRIMARY KEY,
	"organization_id" text NOT NULL,
	"user_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"scope" text NOT NULL,
	"connection_instance_id" text,
	"ticket_hash" text NOT NULL,
	"status" text DEFAULT 'staged' NOT NULL,
	"expires_at" text NOT NULL,
	"created_at" text NOT NULL,
	"redeemed_at" text
);
--> statement-breakpoint
CREATE TABLE "connection_instances" (
	"id" text PRIMARY KEY,
	"owner_user_id" text NOT NULL,
	"organization_id" text,
	"provider_id" text NOT NULL,
	"label" text NOT NULL,
	"owner_team" text,
	"justification" text,
	"data_sensitivity" text,
	"token_ids" jsonb NOT NULL,
	"token_sub" text,
	"allowed_resources" jsonb,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "connection_provider_ownership" (
	"app_id" text PRIMARY KEY,
	"organization_id" text NOT NULL,
	"created_at" text DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') NOT NULL
);
--> statement-breakpoint
CREATE TABLE "connection_provider_settings" (
	"organization_id" text,
	"provider_id" text,
	"account_mode" text NOT NULL,
	"created_at" text DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') NOT NULL,
	"updated_at" text DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') NOT NULL,
	CONSTRAINT "connection_provider_settings_pkey" PRIMARY KEY("organization_id","provider_id")
);
--> statement-breakpoint
CREATE TABLE "connection_providers" (
	"id" text PRIMARY KEY,
	"default_data_sensitivity" text DEFAULT 'confidential' NOT NULL,
	"name" text NOT NULL,
	"description" text NOT NULL,
	"icon" text NOT NULL,
	"category" text NOT NULL,
	"type" text NOT NULL,
	"descope_app_id" text,
	"descope_app_aliases" jsonb,
	"sort_order" bigint DEFAULT 0 NOT NULL,
	"recommended_scope" text NOT NULL,
	"supported_scopes" jsonb NOT NULL,
	"required_scopes" jsonb NOT NULL,
	"credential_profile" jsonb,
	"oauth_config" jsonb,
	"pinned_issuer" text,
	"authorization_response_iss_supported" boolean,
	"registration_provenance" text,
	"dcr_exception" jsonb,
	"created_at" text DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
	"updated_at" text DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
);
--> statement-breakpoint
CREATE TABLE "content_source_documents" (
	"id" text PRIMARY KEY,
	"app_id" text NOT NULL,
	"source_id" text,
	"canonical_url" text NOT NULL,
	"source_revision" text NOT NULL,
	"visibility" text NOT NULL,
	"object_key" text NOT NULL,
	"digest" text NOT NULL,
	"title" text NOT NULL,
	"content_type" text NOT NULL,
	"ai_search_item_id" text,
	"ai_search_status" text DEFAULT 'pending' NOT NULL,
	"ai_search_error" text,
	"created_at" text DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') NOT NULL,
	"updated_at" text DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') NOT NULL
);
--> statement-breakpoint
CREATE TABLE "content_sources" (
	"id" text PRIMARY KEY,
	"app_id" text NOT NULL,
	"source_type" text NOT NULL,
	"source_url" text NOT NULL,
	"title" text,
	"last_ingested_at" text,
	"last_ingest_status" text DEFAULT 'pending',
	"document_count" bigint DEFAULT 0,
	"config" jsonb,
	"last_error" text,
	"created_at" text DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
	"updated_at" text DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
);
--> statement-breakpoint
CREATE TABLE "d1_retention_policies" (
	"table_name" text PRIMARY KEY,
	"mode" text DEFAULT 'off' NOT NULL,
	"keep_days" bigint NOT NULL,
	"max_rows_per_run" bigint DEFAULT 2000 NOT NULL,
	"last_run_at" text,
	"last_report" jsonb,
	"archived_rows_total" bigint DEFAULT 0 NOT NULL,
	"deleted_rows_total" bigint DEFAULT 0 NOT NULL,
	"updated_at" text DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') NOT NULL
);
--> statement-breakpoint
CREATE TABLE "decision_edges" (
	"id" text PRIMARY KEY,
	"org_id" text NOT NULL,
	"from_kind" text NOT NULL,
	"from_id" text NOT NULL,
	"kind" text NOT NULL,
	"to_kind" text NOT NULL,
	"to_id" text NOT NULL,
	"source" text NOT NULL,
	"confidence" double precision DEFAULT 1 NOT NULL,
	"evidence_ref" text,
	"note" text,
	"occurred_at" text NOT NULL,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "decision_exposures" (
	"id" text PRIMARY KEY,
	"organization_id" text NOT NULL,
	"actor_id" text NOT NULL,
	"card_id" text NOT NULL,
	"session_id" text NOT NULL,
	"class_id" text NOT NULL,
	"snapshot" jsonb NOT NULL,
	"context" jsonb NOT NULL,
	"occurred_at" text NOT NULL,
	"expires_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "decision_outcome_labels" (
	"id" text PRIMARY KEY,
	"organization_id" text NOT NULL,
	"actor_id" text NOT NULL,
	"card_id" text NOT NULL,
	"class_id" text NOT NULL,
	"window" text NOT NULL,
	"outcome" jsonb NOT NULL,
	"delayed" jsonb,
	"observed_at" text NOT NULL,
	"due_at" text NOT NULL,
	"expires_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "delegation_value_claims" (
	"id" text PRIMARY KEY,
	"organization_id" text NOT NULL,
	"tedi_id" text NOT NULL,
	"observation_id" text NOT NULL,
	"work_item_id" text NOT NULL,
	"evaluation_run_id" text NOT NULL,
	"executor_type" text DEFAULT 'tedi' NOT NULL,
	"executor_id" text NOT NULL,
	"value_event_id" text NOT NULL,
	"value_evidence_ref" text NOT NULL,
	"value_minor_units" bigint NOT NULL,
	"currency" text NOT NULL,
	"created_at" text DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') NOT NULL
);
--> statement-breakpoint
CREATE TABLE "dispatcher_health_reports" (
	"org_id" text,
	"reporter_id" text,
	"executor" text,
	"lane" text,
	"running" boolean NOT NULL,
	"observed_at" text NOT NULL,
	"reported_at" text NOT NULL,
	"last_admission_at" text,
	"top_reason" text,
	"top_reason_count" bigint,
	"duty" jsonb,
	"machine_name" text,
	"cli_version" text,
	"machine_tools" jsonb,
	"reported_by" text,
	"rules_skill_id" text,
	CONSTRAINT "dispatcher_health_reports_pkey" PRIMARY KEY("org_id","reporter_id","executor","lane")
);
--> statement-breakpoint
CREATE TABLE "docs_builds" (
	"id" text PRIMARY KEY,
	"site_id" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"phase" text DEFAULT 'queued' NOT NULL,
	"source_branch" text,
	"source_revision" text,
	"proposal_id" text,
	"manifest_key" text,
	"error" text,
	"requested_by_type" text,
	"requested_by_id" text,
	"requested_by_session_id" text,
	"created_at" text DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') NOT NULL,
	"started_at" text,
	"finished_at" text
);
--> statement-breakpoint
CREATE TABLE "docs_changes" (
	"id" text PRIMARY KEY,
	"site_id" text NOT NULL,
	"status" text DEFAULT 'proposed' NOT NULL,
	"path" text NOT NULL,
	"message" text NOT NULL,
	"base_revision" text NOT NULL,
	"proposal_branch" text NOT NULL,
	"proposal_revision" text NOT NULL,
	"content_sha256" text NOT NULL,
	"preview_build_id" text,
	"committed_revision" text,
	"proposed_by_type" text NOT NULL,
	"proposed_by_id" text NOT NULL,
	"proposed_by_session_id" text,
	"committed_by_type" text,
	"committed_by_id" text,
	"committed_by_session_id" text,
	"created_at" text DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') NOT NULL,
	"updated_at" text DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') NOT NULL,
	"committed_at" text
);
--> statement-breakpoint
CREATE TABLE "docs_releases" (
	"id" text PRIMARY KEY,
	"site_id" text NOT NULL,
	"build_id" text NOT NULL,
	"previous_build_id" text,
	"action" text NOT NULL,
	"actor_type" text NOT NULL,
	"actor_id" text NOT NULL,
	"actor_session_id" text,
	"created_at" text DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') NOT NULL
);
--> statement-breakpoint
CREATE TABLE "docs_sites" (
	"id" text PRIMARY KEY,
	"org_slug" text NOT NULL,
	"slug" text NOT NULL,
	"title" text NOT NULL,
	"description" text NOT NULL,
	"locale" text DEFAULT 'en' NOT NULL,
	"canonical_url" text NOT NULL,
	"source_provider" text NOT NULL,
	"source_auth_mode" text DEFAULT 'public' NOT NULL,
	"repository_url" text,
	"artifacts_repository" text,
	"branch" text DEFAULT 'main' NOT NULL,
	"content_root" text DEFAULT 'docs' NOT NULL,
	"access_mode" text DEFAULT 'public' NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"active_build_id" text,
	"latest_build_id" text,
	"created_at" text DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') NOT NULL,
	"updated_at" text DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') NOT NULL
);
--> statement-breakpoint
CREATE TABLE "earned_delegation_evidence_revisions" (
	"organization_id" text,
	"tedi_id" text,
	"revision" bigint DEFAULT 1 NOT NULL,
	"updated_at" text DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') NOT NULL,
	CONSTRAINT "earned_delegation_evidence_revisions_pkey" PRIMARY KEY("organization_id","tedi_id")
);
--> statement-breakpoint
CREATE TABLE "embedded_contact_users" (
	"installation_id" text,
	"host_user_id" text,
	"name" text,
	"email" text,
	"role" text,
	"custom_attributes" jsonb DEFAULT '{}' NOT NULL,
	"first_seen_at" text NOT NULL,
	"last_seen_at" text NOT NULL,
	"revision" bigint DEFAULT 1 NOT NULL,
	CONSTRAINT "embedded_contact_users_pkey" PRIMARY KEY("installation_id","host_user_id")
);
--> statement-breakpoint
CREATE TABLE "entrustable_activities" (
	"id" text PRIMARY KEY,
	"organization_id" text,
	"key" text NOT NULL,
	"version" bigint DEFAULT 1 NOT NULL,
	"supersedes_id" text,
	"role_template_id" text,
	"name" text NOT NULL,
	"description" text,
	"status" text DEFAULT 'active' NOT NULL,
	"task_family" text NOT NULL,
	"risk_level" text NOT NULL,
	"maximum_level" text NOT NULL,
	"action_patterns" jsonb NOT NULL,
	"tool_ids" jsonb NOT NULL,
	"rubric" jsonb NOT NULL,
	"rubric_hash" text NOT NULL,
	"evidence_policy" jsonb NOT NULL,
	"evidence_policy_hash" text NOT NULL,
	"created_at" text DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') NOT NULL,
	"updated_at" text DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') NOT NULL
);
--> statement-breakpoint
CREATE TABLE "external_agent_attributions" (
	"id" text PRIMARY KEY,
	"organization_id" text NOT NULL,
	"principal_id" text NOT NULL,
	"session_id" text NOT NULL,
	"target_type" text NOT NULL,
	"target_id" text NOT NULL,
	"role" text NOT NULL,
	"work_item_id" text,
	"metadata" jsonb DEFAULT '{}' NOT NULL,
	"occurred_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "external_agent_exchange_limits" (
	"organization_id" text,
	"principal_id" text,
	"window_start" bigint NOT NULL,
	"request_count" bigint NOT NULL,
	CONSTRAINT "external_agent_exchange_limits_pkey" PRIMARY KEY("organization_id","principal_id")
);
--> statement-breakpoint
CREATE TABLE "external_agent_mcp_credentials" (
	"id" text PRIMARY KEY,
	"organization_id" text NOT NULL,
	"principal_id" text NOT NULL,
	"session_id" text NOT NULL,
	"client_record_id" text NOT NULL,
	"mcp_server_id" text NOT NULL,
	"mcp_server_url" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"issued_at" text NOT NULL,
	"expires_at" text NOT NULL,
	"revoked_at" text,
	"provider_cleanup_at" text,
	"client_id" text,
	"provider_cleanup_attempted_at" text
);
--> statement-breakpoint
CREATE TABLE "external_agent_mcp_issuance_leases" (
	"id" text PRIMARY KEY,
	"organization_id" text NOT NULL,
	"principal_id" text NOT NULL,
	"session_id" text NOT NULL,
	"mcp_server_id" text NOT NULL,
	"owner_token" text NOT NULL,
	"expires_at" text NOT NULL,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "external_agent_principals" (
	"id" text PRIMARY KEY,
	"organization_id" text NOT NULL,
	"key" text NOT NULL,
	"display_name" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"credential_binding_type" text NOT NULL,
	"credential_binding_id" text NOT NULL,
	"created_by_type" text NOT NULL,
	"created_by_id" text NOT NULL,
	"metadata" jsonb DEFAULT '{}' NOT NULL,
	"created_at" text DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') NOT NULL,
	"updated_at" text DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') NOT NULL
);
--> statement-breakpoint
CREATE TABLE "external_agent_review_evidence" (
	"id" text PRIMARY KEY,
	"organization_id" text NOT NULL,
	"execution_attribution_id" text NOT NULL,
	"subject_principal_id" text NOT NULL,
	"subject_session_id" text NOT NULL,
	"reviewer_principal_type" text NOT NULL,
	"reviewer_principal_id" text NOT NULL,
	"reviewer_session_id" text,
	"target_type" text NOT NULL,
	"target_id" text NOT NULL,
	"work_item_id" text,
	"task_family" text NOT NULL,
	"repository_key" text NOT NULL,
	"repository_version" text NOT NULL,
	"risk_level" text NOT NULL,
	"environment" text NOT NULL,
	"outcome" text NOT NULL,
	"score" double precision NOT NULL,
	"policy_violation_severity" bigint DEFAULT 0 NOT NULL,
	"review_method" text NOT NULL,
	"evidence_refs" jsonb NOT NULL,
	"context_hash" text NOT NULL,
	"resolution_status" text DEFAULT 'open' NOT NULL,
	"resolution_evidence_ref" text,
	"resolved_by_type" text,
	"resolved_by_id" text,
	"resolved_at" text,
	"occurred_at" text NOT NULL,
	"created_at" text DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') NOT NULL
);
--> statement-breakpoint
CREATE TABLE "external_agent_sessions" (
	"id" text PRIMARY KEY,
	"organization_id" text NOT NULL,
	"principal_id" text NOT NULL,
	"external_session_key" text NOT NULL,
	"harness" text NOT NULL,
	"harness_version" text NOT NULL,
	"model_provider" text NOT NULL,
	"model_id" text NOT NULL,
	"model_version" text NOT NULL,
	"identity_source" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"credit_eligible" boolean DEFAULT true NOT NULL,
	"started_at" text NOT NULL,
	"last_seen_at" text NOT NULL,
	"ended_at" text,
	"metadata" jsonb DEFAULT '{}' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "external_agent_workload_token_uses" (
	"id" text PRIMARY KEY,
	"organization_id" text NOT NULL,
	"principal_id" text NOT NULL,
	"issuer" text NOT NULL,
	"subject" text NOT NULL,
	"audience" text NOT NULL,
	"jti" text NOT NULL,
	"external_session_key" text NOT NULL,
	"token_issued_at" text NOT NULL,
	"token_expires_at" text NOT NULL,
	"consumed_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "gateway_log_ingestion_cursors" (
	"gateway_id" text PRIMARY KEY,
	"last_log_created_at" text NOT NULL,
	"last_log_id" text NOT NULL,
	"updated_at" text DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
);
--> statement-breakpoint
CREATE TABLE "git_commit_aliases" (
	"old_sha" text PRIMARY KEY,
	"new_sha" text NOT NULL UNIQUE,
	"repository" text NOT NULL,
	"created_at" text DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') NOT NULL
);
--> statement-breakpoint
CREATE TABLE "graph_projection_consumers" (
	"organization_id" text PRIMARY KEY,
	"last_projected_sequence" bigint DEFAULT 0 NOT NULL,
	"lease_token" text,
	"lease_until" text,
	"last_success_at" text,
	"last_error" text,
	"updated_at" text DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') NOT NULL
);
--> statement-breakpoint
CREATE TABLE "graph_projection_maintenance_runs" (
	"id" text PRIMARY KEY,
	"runtime_environment" text NOT NULL,
	"organization_id" text NOT NULL,
	"operation" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"request_fingerprint" text NOT NULL,
	"workflow_id" text NOT NULL UNIQUE,
	"status" text DEFAULT 'queued' NOT NULL,
	"result" jsonb,
	"error" text,
	"cancel_reason" text,
	"cancel_requested_at" text,
	"created_at" text DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') NOT NULL,
	"started_at" text,
	"completed_at" text,
	"updated_at" text DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') NOT NULL
);
--> statement-breakpoint
CREATE TABLE "graph_projection_outbox" (
	"sequence" bigint PRIMARY KEY GENERATED BY DEFAULT AS IDENTITY (sequence name "graph_projection_outbox_sequence_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"event_id" text NOT NULL UNIQUE,
	"organization_id" text NOT NULL,
	"entity_kind" text NOT NULL,
	"entity_id" text NOT NULL,
	"operation" text NOT NULL,
	"payload" jsonb,
	"schema_version" bigint DEFAULT 1 NOT NULL,
	"attempt_count" bigint DEFAULT 0 NOT NULL,
	"next_attempt_at" text,
	"last_error" text,
	"poisoned_at" text,
	"created_at" text DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') NOT NULL
);
--> statement-breakpoint
CREATE TABLE "graph_projection_readiness" (
	"organization_id" text PRIMARY KEY,
	"state" text DEFAULT 'disabled' NOT NULL,
	"reason" text,
	"projection_epoch" text,
	"persisted_watermark" bigint DEFAULT 0 NOT NULL,
	"gds_watermark" bigint DEFAULT 0 NOT NULL,
	"gds_epoch" text,
	"node_mismatch_count" bigint,
	"edge_mismatch_count" bigint,
	"lifecycle_mismatch_count" bigint,
	"repair_id" text,
	"repair_phase" text,
	"repair_cursor" text,
	"repair_high_water" bigint,
	"repair_started_at" text,
	"last_certified_at" text,
	"updated_at" text DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') NOT NULL
);
--> statement-breakpoint
CREATE TABLE "graph_retrieval_benchmark_cases" (
	"id" text PRIMARY KEY,
	"organization_id" text NOT NULL,
	"suite_id" text NOT NULL,
	"suite_revision" bigint NOT NULL,
	"case_key" text NOT NULL,
	"query" text NOT NULL,
	"anchor_fact_ids" jsonb DEFAULT '[]' NOT NULL,
	"expected_fact_ids" jsonb NOT NULL,
	"expected_edges" jsonb DEFAULT '[]' NOT NULL,
	"expected_paths" jsonb DEFAULT '[]' NOT NULL,
	"forbidden_fact_ids" jsonb DEFAULT '[]' NOT NULL,
	"valid_at" text NOT NULL,
	"answer_rubric" jsonb DEFAULT '{}' NOT NULL,
	"artifact_uri" text,
	"tags" jsonb DEFAULT '[]' NOT NULL,
	"difficulty" text DEFAULT 'intermediate' NOT NULL,
	"checksum" text NOT NULL,
	"created_at" text DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') NOT NULL
);
--> statement-breakpoint
CREATE TABLE "graph_retrieval_benchmark_results" (
	"id" text PRIMARY KEY,
	"organization_id" text NOT NULL,
	"run_id" text NOT NULL,
	"case_id" text NOT NULL,
	"origin" text DEFAULT 'manual' NOT NULL,
	"retrieved_fact_ids" jsonb NOT NULL,
	"returned_edges" jsonb DEFAULT '[]' NOT NULL,
	"returned_paths" jsonb DEFAULT '[]' NOT NULL,
	"answer" text,
	"cited_fact_ids" jsonb DEFAULT '[]' NOT NULL,
	"claim_support" jsonb DEFAULT '[]' NOT NULL,
	"metrics" jsonb NOT NULL,
	"input_tokens" bigint NOT NULL,
	"output_tokens" bigint NOT NULL,
	"latency_ms" bigint NOT NULL,
	"cost_usd" double precision NOT NULL,
	"passed" boolean NOT NULL,
	"failure_reasons" jsonb DEFAULT '[]' NOT NULL,
	"trace_artifact_uri" text,
	"created_at" text DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') NOT NULL
);
--> statement-breakpoint
CREATE TABLE "graph_retrieval_benchmark_runs" (
	"id" text PRIMARY KEY,
	"organization_id" text NOT NULL,
	"suite_id" text NOT NULL,
	"suite_checksum" text NOT NULL,
	"paired_run_key" text NOT NULL,
	"variant" text NOT NULL,
	"retrieval_policy_version" text NOT NULL,
	"harness_version_id" text,
	"model_provider" text NOT NULL,
	"model_id" text NOT NULL,
	"model_version" text NOT NULL,
	"projection_snapshot" jsonb NOT NULL,
	"seed" bigint NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"case_count" bigint DEFAULT 0 NOT NULL,
	"aggregate_metrics" jsonb,
	"total_input_tokens" bigint DEFAULT 0 NOT NULL,
	"total_output_tokens" bigint DEFAULT 0 NOT NULL,
	"total_latency_ms" bigint DEFAULT 0 NOT NULL,
	"total_cost_usd" double precision DEFAULT 0 NOT NULL,
	"eligible" boolean DEFAULT false NOT NULL,
	"trace_artifact_uri" text,
	"failure_reason" text,
	"started_at" text NOT NULL,
	"completed_at" text
);
--> statement-breakpoint
CREATE TABLE "graph_retrieval_benchmark_suites" (
	"id" text PRIMARY KEY,
	"organization_id" text NOT NULL,
	"name" text NOT NULL,
	"version" bigint NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"split" text NOT NULL,
	"revision" bigint DEFAULT 0 NOT NULL,
	"case_count" bigint DEFAULT 0 NOT NULL,
	"definition_checksum" text,
	"source_commit" text,
	"artifact_uri" text,
	"created_by_type" text NOT NULL,
	"created_by_id" text NOT NULL,
	"locked_at" text,
	"retired_at" text,
	"created_at" text DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') NOT NULL,
	"updated_at" text DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') NOT NULL
);
--> statement-breakpoint
CREATE TABLE "graph_retrieval_graduation_evaluations" (
	"id" text PRIMARY KEY,
	"organization_id" text NOT NULL,
	"suite_id" text NOT NULL,
	"baseline_run_id" text NOT NULL,
	"graph_run_id" text NOT NULL,
	"evaluator_version" text NOT NULL,
	"passed" boolean NOT NULL,
	"gates" jsonb NOT NULL,
	"paired_metrics" jsonb NOT NULL,
	"projection_snapshot" jsonb NOT NULL,
	"reasons" jsonb NOT NULL,
	"evaluated_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "harness_eval_results" (
	"id" text PRIMARY KEY,
	"harness_version_id" text NOT NULL,
	"tedi_id" text NOT NULL,
	"org_id" text,
	"score" double precision NOT NULL,
	"gates" jsonb DEFAULT '{}' NOT NULL,
	"passed" boolean DEFAULT false NOT NULL,
	"lane" text,
	"task_set_id" text,
	"metadata" jsonb,
	"created_at" text DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') NOT NULL
);
--> statement-breakpoint
CREATE TABLE "harness_eval_runs" (
	"id" text PRIMARY KEY,
	"harness_version_id" text NOT NULL,
	"tedi_id" text NOT NULL,
	"org_id" text,
	"lane" text NOT NULL,
	"task_set_id" text NOT NULL,
	"total" bigint DEFAULT 0 NOT NULL,
	"passed" bigint DEFAULT 0 NOT NULL,
	"failed" bigint DEFAULT 0 NOT NULL,
	"mean_score" double precision DEFAULT 0 NOT NULL,
	"eligible" boolean DEFAULT false NOT NULL,
	"report" jsonb,
	"metadata" jsonb,
	"created_at" text DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') NOT NULL
);
--> statement-breakpoint
CREATE TABLE "harness_subject_eval_results" (
	"id" text PRIMARY KEY,
	"subject_kind" text NOT NULL,
	"subject_id" text NOT NULL,
	"tedi_id" text,
	"org_id" text,
	"harness_version_id" text NOT NULL,
	"score" double precision NOT NULL,
	"gates" jsonb DEFAULT '{}' NOT NULL,
	"passed" boolean DEFAULT false NOT NULL,
	"lane" text,
	"task_set_id" text,
	"metadata" jsonb,
	"created_at" text DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') NOT NULL
);
--> statement-breakpoint
CREATE TABLE "harness_subject_eval_runs" (
	"id" text PRIMARY KEY,
	"subject_kind" text NOT NULL,
	"subject_id" text NOT NULL,
	"tedi_id" text,
	"org_id" text,
	"harness_version_id" text NOT NULL,
	"lane" text NOT NULL,
	"task_set_id" text NOT NULL,
	"total" bigint DEFAULT 0 NOT NULL,
	"passed" bigint DEFAULT 0 NOT NULL,
	"failed" bigint DEFAULT 0 NOT NULL,
	"mean_score" double precision DEFAULT 0 NOT NULL,
	"eligible" boolean DEFAULT false NOT NULL,
	"report" jsonb,
	"metadata" jsonb,
	"created_at" text DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') NOT NULL
);
--> statement-breakpoint
CREATE TABLE "harness_subject_trace_bundles" (
	"id" text PRIMARY KEY,
	"subject_kind" text NOT NULL,
	"subject_id" text NOT NULL,
	"tedi_id" text,
	"org_id" text,
	"conversation_id" text,
	"run_id" text NOT NULL,
	"harness_version_id" text NOT NULL,
	"event_ids" jsonb DEFAULT '[]' NOT NULL,
	"rationale_record_ids" jsonb DEFAULT '[]' NOT NULL,
	"artifact_ids" jsonb DEFAULT '[]' NOT NULL,
	"eval_result_id" text,
	"bundle_uri" text,
	"summary" text,
	"outcome" text,
	"metadata" jsonb,
	"created_at" text DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') NOT NULL
);
--> statement-breakpoint
CREATE TABLE "harness_subject_versions" (
	"id" text PRIMARY KEY,
	"subject_kind" text NOT NULL,
	"subject_id" text NOT NULL,
	"tedi_id" text,
	"org_id" text,
	"version" text NOT NULL,
	"runtime_kind" text,
	"components" jsonb DEFAULT '{}' NOT NULL,
	"parent_version_id" text,
	"reason" text,
	"artifact_commit_sha" text,
	"trace_safety_policy_id" text,
	"promotion_status" text DEFAULT 'proposed' NOT NULL,
	"metadata" jsonb,
	"created_at" text DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') NOT NULL
);
--> statement-breakpoint
CREATE TABLE "harness_versions" (
	"id" text PRIMARY KEY,
	"tedi_id" text NOT NULL,
	"org_id" text,
	"version" text NOT NULL,
	"runtime_kind" text,
	"components" jsonb DEFAULT '{}' NOT NULL,
	"parent_version_id" text,
	"reason" text,
	"artifact_commit_sha" text,
	"trace_safety_policy_id" text,
	"promotion_status" text DEFAULT 'proposed' NOT NULL,
	"metadata" jsonb,
	"created_at" text DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') NOT NULL
);
--> statement-breakpoint
CREATE TABLE "items" (
	"id" text PRIMARY KEY,
	"app_id" text NOT NULL,
	"external_id" text,
	"vertical" text NOT NULL,
	"title" text NOT NULL,
	"subtitle" text,
	"description" text,
	"image" text,
	"images" jsonb,
	"price_amount" double precision,
	"price_currency" text DEFAULT 'EUR',
	"price_original" double precision,
	"price_formatted" text,
	"rating_value" double precision,
	"rating_count" text,
	"rating_max" double precision,
	"badge_text" text,
	"badge_variant" text,
	"location_lat" double precision,
	"location_lng" double precision,
	"location_address" text,
	"location_city" text,
	"location_country" text,
	"seller_id" text,
	"seller_name" text,
	"seller_avatar" text,
	"seller_verified" text,
	"seller_rating" double precision,
	"features" jsonb,
	"actions" jsonb,
	"url" text,
	"metadata" jsonb,
	"created_at" text DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
	"updated_at" text DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
);
--> statement-breakpoint
CREATE TABLE "jobs" (
	"id" text PRIMARY KEY,
	"type" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"app_id" text NOT NULL,
	"payload" jsonb,
	"result" jsonb,
	"error" text,
	"progress" jsonb,
	"created_at" text DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
	"started_at" text,
	"completed_at" text,
	"updated_at" text DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
);
--> statement-breakpoint
CREATE TABLE "kernel_conversation_artifact_pins" (
	"id" text PRIMARY KEY,
	"organization_id" text NOT NULL,
	"conversation_id" text NOT NULL,
	"artifact_id" text NOT NULL,
	"replay_name" text NOT NULL,
	"revision_digest" text NOT NULL,
	"artifact_uri" text NOT NULL,
	"artifact_name" text NOT NULL,
	"artifact_kind" text NOT NULL,
	"mime_type" text,
	"attached_by_type" text NOT NULL,
	"attached_by_id" text NOT NULL,
	"created_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "kernel_conversation_capabilities" (
	"id" text PRIMARY KEY,
	"organization_id" text NOT NULL,
	"conversation_id" text NOT NULL,
	"capability_id" text NOT NULL,
	"replay_name" text NOT NULL,
	"attached_by_type" text NOT NULL,
	"attached_by_id" text NOT NULL,
	"created_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "kernel_conversation_grants" (
	"id" text PRIMARY KEY,
	"organization_id" text NOT NULL,
	"conversation_id" text NOT NULL,
	"grantee_descope_user_id" text NOT NULL,
	"access" text NOT NULL,
	"created_by_descope_user_id" text,
	"created_at" text DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') NOT NULL,
	"updated_at" text DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') NOT NULL
);
--> statement-breakpoint
CREATE TABLE "kernel_conversation_session_policies" (
	"id" text PRIMARY KEY,
	"organization_id" text NOT NULL,
	"conversation_id" text NOT NULL,
	"scope_key" text NOT NULL,
	"effect" text NOT NULL,
	"granted_by_type" text NOT NULL,
	"granted_by_id" text NOT NULL,
	"reason" text,
	"created_at" text NOT NULL,
	"expires_at" text
);
--> statement-breakpoint
CREATE TABLE "kernel_conversations" (
	"id" text PRIMARY KEY,
	"organization_id" text NOT NULL,
	"conversation_id" text NOT NULL,
	"title" text,
	"title_source" text,
	"channel" text,
	"origin" text,
	"workspace_id" text,
	"workpiece_kind" text,
	"workpiece_id" text,
	"last_message_at" text NOT NULL,
	"message_count" bigint DEFAULT 0 NOT NULL,
	"deleted_at" text,
	"archived_at" text,
	"pinned_at" text,
	"created_at" text DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') NOT NULL,
	"updated_at" text DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') NOT NULL
);
--> statement-breakpoint
CREATE TABLE "kernel_home_approval_mirrors" (
	"id" text PRIMARY KEY,
	"organization_id" text NOT NULL,
	"parent_conversation_id" text NOT NULL,
	"child_run_id" text NOT NULL,
	"approval_request_id" text NOT NULL,
	"delegated_tedi_id" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"blocked_at" text NOT NULL,
	"escalate_at" bigint NOT NULL,
	"escalated_at" text,
	"cleared_at" text,
	"created_at" text DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') NOT NULL,
	"updated_at" text DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') NOT NULL
);
--> statement-breakpoint
CREATE TABLE "kernel_request_events" (
	"id" text PRIMARY KEY,
	"organization_id" text NOT NULL,
	"owner_user_id" text NOT NULL,
	"request_id" text NOT NULL,
	"version" bigint NOT NULL,
	"snapshot" jsonb NOT NULL,
	"created_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "kernel_requests" (
	"id" text PRIMARY KEY,
	"organization_id" text NOT NULL,
	"owner_user_id" text NOT NULL,
	"source_kind" text NOT NULL,
	"source_id" text NOT NULL,
	"conversation_id" text,
	"version" bigint DEFAULT 1 NOT NULL,
	"snapshot" jsonb NOT NULL,
	"next_owner" text NOT NULL,
	"next_action" text NOT NULL,
	"next_due_at" text,
	"last_event_id" text NOT NULL,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "kernel_runtime_events" (
	"id" text PRIMARY KEY,
	"organization_id" text NOT NULL,
	"kind" text NOT NULL,
	"conversation_id" text NOT NULL,
	"run_id" text,
	"message_id" text,
	"cause_event_id" text,
	"delegated_tedi_id" text,
	"child_run_id" text,
	"sequence" bigint,
	"delta" text,
	"payload" jsonb,
	"runtime_backend" text DEFAULT 'custom' NOT NULL,
	"runtime_external_id" text,
	"runtime_external_url" text,
	"runtime_metadata" jsonb,
	"trace_id" text,
	"created_at" text DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') NOT NULL
);
--> statement-breakpoint
CREATE TABLE "kernel_runtime_runs" (
	"id" text PRIMARY KEY,
	"organization_id" text NOT NULL,
	"conversation_id" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"input_message_id" text,
	"output_message_id" text,
	"delegated_tedi_id" text,
	"child_run_id" text,
	"child_conversation_id" text,
	"progress_value" bigint,
	"progress_label" text,
	"progress_detail" text,
	"latest_event_kind" text,
	"latest_event_at" text,
	"preview" text,
	"runtime_backend" text DEFAULT 'custom' NOT NULL,
	"runtime_external_id" text,
	"runtime_external_url" text,
	"runtime_metadata" jsonb,
	"metadata" jsonb,
	"work_item_id" text,
	"target_tedi_id" text,
	"started_at" text,
	"completed_at" text,
	"created_at" text DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') NOT NULL,
	"updated_at" text DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') NOT NULL,
	"output_revision_id" text,
	"sensitive_data_latch" jsonb
);
--> statement-breakpoint
CREATE TABLE "kernel_tool_results" (
	"id" text PRIMARY KEY,
	"organization_id" text NOT NULL,
	"conversation_id" text NOT NULL,
	"run_id" text,
	"source_kind" text NOT NULL,
	"source_id" text NOT NULL,
	"object_key" text NOT NULL,
	"sha256" text NOT NULL,
	"byte_size" bigint NOT NULL,
	"content_type" text DEFAULT 'application/json' NOT NULL,
	"created_at" text NOT NULL,
	"expires_at" text NOT NULL,
	"evicted_at" text,
	"eviction_reason" text
);
--> statement-breakpoint
CREATE TABLE "kernel_wake_queue" (
	"id" text PRIMARY KEY,
	"organization_id" text NOT NULL,
	"parent_conversation_id" text NOT NULL,
	"child_run_id" text NOT NULL,
	"child_status" text NOT NULL,
	"queued_at" text DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') NOT NULL,
	"acked_at" text,
	"wake_kind" text DEFAULT 'child_completed' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "knowledge_entries" (
	"id" text PRIMARY KEY,
	"organization_id" text NOT NULL,
	"tedi_id" text,
	"domain_id" text,
	"title" text NOT NULL,
	"content" text NOT NULL,
	"entry_type" text NOT NULL,
	"source_fact_ids" jsonb,
	"source_count" bigint DEFAULT 0 NOT NULL,
	"confidence" double precision DEFAULT 0.8 NOT NULL,
	"revision" bigint DEFAULT 1 NOT NULL,
	"revision_reasoning" text,
	"supersedes_id" text,
	"visibility" text DEFAULT 'private' NOT NULL,
	"tags" jsonb,
	"last_validated_at" text,
	"created_at" text DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
	"updated_at" text DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
);
--> statement-breakpoint
CREATE TABLE "learning_feedback_attributions" (
	"id" text PRIMARY KEY,
	"organization_id" text NOT NULL,
	"client_attribution_id" text NOT NULL,
	"feedback_event_id" text NOT NULL,
	"subject_kind" text NOT NULL,
	"subject_id" text NOT NULL,
	"change_kind" text NOT NULL,
	"rationale" text,
	"evidence_refs" jsonb NOT NULL,
	"metadata" jsonb,
	"occurred_at" text NOT NULL,
	"created_at" text DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') NOT NULL
);
--> statement-breakpoint
CREATE TABLE "learning_feedback_measurements" (
	"id" text PRIMARY KEY,
	"organization_id" text NOT NULL,
	"client_measurement_id" text NOT NULL,
	"attribution_id" text NOT NULL,
	"window_kind" text NOT NULL,
	"window_start" text NOT NULL,
	"window_end" text NOT NULL,
	"opportunity_count" bigint NOT NULL,
	"recurrence_count" bigint NOT NULL,
	"success_count" bigint DEFAULT 0 NOT NULL,
	"metadata" jsonb,
	"created_at" text DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') NOT NULL
);
--> statement-breakpoint
CREATE TABLE "learning_improvement_proposals" (
	"id" text PRIMARY KEY,
	"organization_id" text NOT NULL,
	"client_proposal_id" text NOT NULL,
	"tedi_id" text,
	"scope_kind" text NOT NULL,
	"scope_id" text NOT NULL,
	"issue_key" text NOT NULL,
	"subject_kind" text NOT NULL,
	"subject_id" text NOT NULL,
	"status" text DEFAULT 'proposed' NOT NULL,
	"promotion_route" text NOT NULL,
	"recommendation" text NOT NULL,
	"evidence_event_ids" jsonb NOT NULL,
	"attribution_id" text,
	"baseline_measurement_id" text,
	"followup_measurement_id" text,
	"certification_evidence_refs" jsonb NOT NULL,
	"evaluation_note" text,
	"review_reason" text,
	"proposed_by_type" text NOT NULL,
	"proposed_by_id" text,
	"reviewed_by_id" text,
	"created_at" text DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') NOT NULL,
	"updated_at" text DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') NOT NULL,
	"reviewed_at" text
);
--> statement-breakpoint
CREATE TABLE "learning_interaction_events" (
	"id" text PRIMARY KEY,
	"organization_id" text NOT NULL,
	"actor_type" text NOT NULL,
	"actor_id" text,
	"tedi_id" text,
	"client_event_id" text NOT NULL,
	"signal_class" text DEFAULT 'quality' NOT NULL,
	"event_kind" text NOT NULL,
	"scope_kind" text NOT NULL,
	"scope_id" text NOT NULL,
	"issue_key" text,
	"surface" text NOT NULL,
	"target_type" text,
	"target_id" text,
	"thread_id" text,
	"run_id" text,
	"metadata" jsonb,
	"occurred_at" text NOT NULL,
	"created_at" text DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') NOT NULL
);
--> statement-breakpoint
CREATE TABLE "machine_provider_probe_authorizations" (
	"id" text PRIMARY KEY,
	"organization_id" text NOT NULL,
	"principal_id" text NOT NULL,
	"session_id" text NOT NULL,
	"client_record_id" text NOT NULL,
	"client_id" text NOT NULL,
	"mcp_server_id" text NOT NULL,
	"profile_id" text NOT NULL,
	"profile_digest" text NOT NULL,
	"args_digest" text NOT NULL,
	"expires_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "machine_provider_probe_results" (
	"id" text PRIMARY KEY,
	"organization_id" text NOT NULL,
	"principal_id" text NOT NULL,
	"session_id" text NOT NULL,
	"client_record_id" text NOT NULL,
	"client_id" text NOT NULL,
	"mcp_server_id" text NOT NULL,
	"profile_id" text NOT NULL,
	"profile_digest" text NOT NULL,
	"args_digest" text NOT NULL,
	"account_revision_digest" text NOT NULL,
	"expires_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "machine_tool_calls" (
	"id" text PRIMARY KEY,
	"org_id" text NOT NULL,
	"machine_name" text NOT NULL,
	"tool" text NOT NULL,
	"input" text NOT NULL,
	"requested_by_type" text NOT NULL,
	"requested_by_id" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"result" text,
	"error" text,
	"claimed_by_reporter_id" text,
	"created_at" text NOT NULL,
	"claimed_at" text,
	"finished_at" text,
	"expires_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "machine_tool_polls" (
	"org_id" text,
	"machine_name" text,
	"last_polled_at" text NOT NULL,
	CONSTRAINT "machine_tool_polls_pkey" PRIMARY KEY("org_id","machine_name")
);
--> statement-breakpoint
CREATE TABLE "mcp_consent_grants" (
	"descope_user_id" text,
	"mcp_server_id" text,
	"client_id" text,
	"revision" text,
	"app_id" text NOT NULL,
	"selected_tenant_ids" jsonb NOT NULL,
	"approved_scopes" jsonb NOT NULL,
	"created_at" text DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') NOT NULL,
	CONSTRAINT "mcp_consent_grants_pkey" PRIMARY KEY("descope_user_id","mcp_server_id","client_id","revision")
);
--> statement-breakpoint
CREATE TABLE "mcp_consent_pending" (
	"descope_user_id" text,
	"mcp_server_id" text,
	"client_id" text,
	"app_id" text NOT NULL,
	"revision" text,
	"expected_active_revision" text,
	"selected_tenant_ids" jsonb NOT NULL,
	"approved_scopes" jsonb NOT NULL,
	"expires_at" text NOT NULL,
	"created_at" text DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') NOT NULL,
	CONSTRAINT "mcp_consent_pending_pkey" PRIMARY KEY("descope_user_id","mcp_server_id","client_id","revision")
);
--> statement-breakpoint
CREATE TABLE "mcp_consent_selections" (
	"descope_user_id" text,
	"mcp_server_id" text,
	"client_id" text,
	"app_id" text NOT NULL,
	"revision" text NOT NULL,
	"status" text NOT NULL,
	"selected_tenant_ids" jsonb NOT NULL,
	"approved_scopes" jsonb NOT NULL,
	"created_at" text DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') NOT NULL,
	"updated_at" text DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') NOT NULL,
	CONSTRAINT "mcp_consent_selections_pkey" PRIMARY KEY("descope_user_id","mcp_server_id","client_id")
);
--> statement-breakpoint
CREATE TABLE "mcp_event_subscriptions" (
	"id" text PRIMARY KEY,
	"organization_id" text NOT NULL,
	"owner_subject" text NOT NULL,
	"mcp_url" text NOT NULL,
	"event_name" text NOT NULL,
	"arguments" jsonb NOT NULL,
	"callback_url" text NOT NULL,
	"sealed_credential" text NOT NULL,
	"cursor" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"consecutive_failures" bigint DEFAULT 0 NOT NULL,
	"next_attempt_at" text NOT NULL,
	"claim_token" text,
	"rate_window_started_at" text,
	"rate_window_count" bigint DEFAULT 0 NOT NULL,
	"last_delivered_at" text,
	"last_status" bigint,
	"expires_at" text NOT NULL,
	"created_at" text DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') NOT NULL,
	"updated_at" text DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mcp_inbound_client_attempts" (
	"organization_id" text,
	"mcp_server_id" text,
	"client_id" text,
	"client_name" text,
	"last_stage" text NOT NULL,
	"last_mode" text NOT NULL,
	"last_listed" boolean NOT NULL,
	"last_allowed" boolean NOT NULL,
	"attempt_count" bigint DEFAULT 1 NOT NULL,
	"denied_count" bigint DEFAULT 0 NOT NULL,
	"first_seen_at" text NOT NULL,
	"last_seen_at" text NOT NULL,
	CONSTRAINT "mcp_inbound_client_attempts_pkey" PRIMARY KEY("organization_id","mcp_server_id","client_id")
);
--> statement-breakpoint
CREATE TABLE "mcp_payment_accounts" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid(),
	"organization_id" text NOT NULL,
	"tedi_id" text,
	"app_slug" text,
	"label" text NOT NULL,
	"network" text DEFAULT 'solana-devnet' NOT NULL,
	"asset" text DEFAULT 'USDC' NOT NULL,
	"public_address" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"custody_mode" text DEFAULT 'mock' NOT NULL,
	"signer_provider" text DEFAULT 'mock' NOT NULL,
	"metadata" jsonb,
	"created_by" text,
	"updated_by" text,
	"created_at" text DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') NOT NULL,
	"updated_at" text DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mcp_payment_events" (
	"id" text PRIMARY KEY,
	"requirement_id" text NOT NULL,
	"event_type" text NOT NULL,
	"status" text NOT NULL,
	"protocol" text DEFAULT 'x402' NOT NULL,
	"mode" text DEFAULT 'mock' NOT NULL,
	"network" text NOT NULL,
	"asset" text,
	"currency" text,
	"amount" text NOT NULL,
	"recipient" text NOT NULL,
	"resource" text,
	"app_id" text,
	"app_slug" text NOT NULL,
	"organization_id" text,
	"tool_row_id" text,
	"tool_id" text NOT NULL,
	"tedi_id" text,
	"user_id" text,
	"client_id" text,
	"auth_type" text,
	"trace_id" text,
	"tool_args_hash" text,
	"settled" boolean DEFAULT false NOT NULL,
	"requirements" jsonb,
	"payment_proof" jsonb,
	"payment_response" jsonb,
	"budget_policy" jsonb,
	"budget_decision" jsonb,
	"decision_rationale" text,
	"audit_event_id" text,
	"rationale_record_id" text,
	"created_at" text DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mcp_payment_policies" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid(),
	"organization_id" text NOT NULL,
	"tedi_id" text,
	"app_slug" text,
	"tool_id" text,
	"currency" text DEFAULT 'USDC' NOT NULL,
	"network" text DEFAULT 'solana-devnet' NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"max_amount" text NOT NULL,
	"max_transaction_amount" text,
	"allowed_recipients" jsonb,
	"allowed_tools" jsonb,
	"window_seconds" bigint DEFAULT 86400 NOT NULL,
	"mode" text DEFAULT 'enforce' NOT NULL,
	"created_by" text,
	"updated_by" text,
	"created_at" text DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') NOT NULL,
	"updated_at" text DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mcp_payment_reservations" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid(),
	"requirement_id" text NOT NULL,
	"organization_id" text NOT NULL,
	"tedi_id" text,
	"app_slug" text NOT NULL,
	"tool_id" text NOT NULL,
	"account_id" text,
	"policy_id" text,
	"status" text DEFAULT 'reserved' NOT NULL,
	"protocol" text DEFAULT 'x402' NOT NULL,
	"mode" text DEFAULT 'mock' NOT NULL,
	"network" text NOT NULL,
	"asset" text,
	"currency" text,
	"amount" text NOT NULL,
	"recipient" text NOT NULL,
	"resource" text,
	"expires_at" text NOT NULL,
	"settled_event_id" text,
	"metadata" jsonb,
	"created_at" text DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') NOT NULL,
	"updated_at" text DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mcp_tasks" (
	"id" text PRIMARY KEY,
	"task_id" text NOT NULL UNIQUE,
	"org_id" text NOT NULL,
	"subject_user_id" text,
	"app_id" text NOT NULL,
	"tool_id" text,
	"tool_name" text NOT NULL,
	"request_id" text,
	"method" text DEFAULT 'tools/call' NOT NULL,
	"status" text DEFAULT 'working' NOT NULL,
	"ttl_ms" bigint,
	"poll_interval_ms" bigint,
	"input_requests" jsonb,
	"input_responses" jsonb,
	"result" jsonb,
	"error" jsonb,
	"workflow_id" text,
	"cancel_requested_at" text,
	"created_at" text DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') NOT NULL,
	"updated_at" text DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') NOT NULL,
	"expires_at" text
);
--> statement-breakpoint
CREATE TABLE "mcp_tool_approval_grants" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid(),
	"organization_id" text NOT NULL,
	"subject_id" text NOT NULL,
	"tool_id" text NOT NULL,
	"grant_kind" text NOT NULL,
	"consumed_at" text,
	"expires_at" text,
	"reason" text,
	"created_at" text DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') NOT NULL
);
--> statement-breakpoint
CREATE TABLE "memory_domains" (
	"id" text PRIMARY KEY,
	"organization_id" text NOT NULL,
	"name" text NOT NULL,
	"parent_id" text,
	"description" text,
	"created_at" text DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
);
--> statement-breakpoint
CREATE TABLE "memory_edge_org_counts" (
	"organization_id" text PRIMARY KEY,
	"total" bigint DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "memory_edges" (
	"id" text PRIMARY KEY,
	"source_fact_id" text NOT NULL,
	"target_fact_id" text NOT NULL,
	"relation_type" text NOT NULL,
	"strength" double precision DEFAULT 0.5 NOT NULL,
	"context" text,
	"created_at" text DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
);
--> statement-breakpoint
CREATE TABLE "memory_entities" (
	"id" text PRIMARY KEY,
	"organization_id" text NOT NULL,
	"entity_type" text NOT NULL,
	"display_name" text NOT NULL,
	"normalized_name" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"merged_into_entity_id" text,
	"version" bigint DEFAULT 0 NOT NULL,
	"created_at" text DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') NOT NULL,
	"updated_at" text DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') NOT NULL
);
--> statement-breakpoint
CREATE TABLE "memory_entity_aliases" (
	"id" text PRIMARY KEY,
	"organization_id" text NOT NULL,
	"entity_id" text NOT NULL,
	"surface_form" text NOT NULL,
	"normalized_form" text NOT NULL,
	"alias_kind" text NOT NULL,
	"locale" text DEFAULT 'und' NOT NULL,
	"confidence" double precision NOT NULL,
	"review_status" text DEFAULT 'pending' NOT NULL,
	"source_mention_id" text,
	"valid_from" text DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') NOT NULL,
	"valid_to" text,
	"created_at" text DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') NOT NULL
);
--> statement-breakpoint
CREATE TABLE "memory_entity_mentions" (
	"id" text PRIMARY KEY,
	"organization_id" text NOT NULL,
	"occurrence_key" text NOT NULL,
	"source_fact_id" text,
	"source_uri" text,
	"source_content_hash" text,
	"source_session_id" text,
	"source_run_id" text,
	"surface_form" text NOT NULL,
	"normalized_form" text NOT NULL,
	"proposed_type" text NOT NULL,
	"char_start" bigint,
	"char_end" bigint,
	"extractor" text NOT NULL,
	"extractor_version" text NOT NULL,
	"model_id" text,
	"harness_version_id" text,
	"confidence" double precision NOT NULL,
	"evidence" jsonb DEFAULT '{}' NOT NULL,
	"created_at" text DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') NOT NULL
);
--> statement-breakpoint
CREATE TABLE "memory_entity_resolution_decisions" (
	"id" text PRIMARY KEY,
	"organization_id" text NOT NULL,
	"client_proposal_key" text NOT NULL,
	"operation" text NOT NULL,
	"mention_id" text,
	"alias_id" text,
	"source_entity_id" text,
	"target_entity_id" text,
	"status" text DEFAULT 'proposed' NOT NULL,
	"confidence" double precision NOT NULL,
	"rationale" text NOT NULL,
	"evidence" jsonb DEFAULT '{}' NOT NULL,
	"proposed_by_type" text NOT NULL,
	"proposed_by_id" text NOT NULL,
	"reviewed_by_type" text,
	"reviewed_by_id" text,
	"review_rationale" text,
	"source_run_id" text,
	"expected_mention_version" bigint NOT NULL,
	"expected_head_decision_id" text,
	"expected_entity_version" bigint,
	"version" bigint DEFAULT 0 NOT NULL,
	"supersedes_decision_id" text,
	"rollback_of_decision_id" text,
	"inverse" jsonb NOT NULL,
	"proposed_at" text DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') NOT NULL,
	"reviewed_at" text,
	"applied_at" text
);
--> statement-breakpoint
CREATE TABLE "memory_entity_resolution_heads" (
	"mention_id" text PRIMARY KEY,
	"organization_id" text NOT NULL,
	"version" bigint DEFAULT 0 NOT NULL,
	"current_resolution_id" text,
	"current_entity_id" text,
	"last_decision_id" text,
	"updated_at" text DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') NOT NULL
);
--> statement-breakpoint
CREATE TABLE "memory_entity_resolutions" (
	"id" text PRIMARY KEY,
	"organization_id" text NOT NULL,
	"mention_id" text NOT NULL,
	"entity_id" text,
	"decision_id" text NOT NULL,
	"resolution_kind" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"confidence" double precision NOT NULL,
	"valid_from" text NOT NULL,
	"valid_to" text,
	"created_at" text DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') NOT NULL
);
--> statement-breakpoint
CREATE TABLE "memory_fact_citation_backfills" (
	"organization_id" text PRIMARY KEY,
	"source" text NOT NULL,
	"fact_id" text NOT NULL,
	"done" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "memory_fact_citations" (
	"organization_id" text NOT NULL,
	"cited_fact_id" text,
	"consolidated_fact_id" text,
	"created_at" text DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') NOT NULL,
	CONSTRAINT "memory_fact_citations_pkey" PRIMARY KEY("consolidated_fact_id","cited_fact_id")
);
--> statement-breakpoint
CREATE TABLE "memory_fact_org_counts" (
	"organization_id" text PRIMARY KEY,
	"total" bigint DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "memory_facts" (
	"id" text PRIMARY KEY,
	"organization_id" text NOT NULL,
	"tedi_id" text,
	"domain_id" text,
	"content" text NOT NULL,
	"summary" text,
	"fact_type" text NOT NULL,
	"confidence" double precision DEFAULT 0.8 NOT NULL,
	"valid_from" text DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
	"valid_to" text,
	"status" text DEFAULT 'active',
	"source" text,
	"source_session_id" text,
	"source_url" text,
	"source_hash" text,
	"embedding_id" text,
	"topic_key" text,
	"memory_scope" text DEFAULT 'tedi',
	"use_policy" text DEFAULT 'can_use_as_evidence',
	"review_status" text DEFAULT 'pending',
	"metadata" jsonb,
	"priority" text DEFAULT 'active',
	"visibility" text DEFAULT 'private',
	"promoted_from" text,
	"promoted_at" text,
	"last_verified_at" text,
	"last_accessed_at" text,
	"access_count" bigint DEFAULT 0 NOT NULL,
	"usage_count" bigint DEFAULT 0 NOT NULL,
	"archived_at" text,
	"created_at" text DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
	"updated_at" text DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
);
--> statement-breakpoint
CREATE TABLE "oidc_sessions" (
	"id" text PRIMARY KEY,
	"organization_id" text NOT NULL,
	"kind" text NOT NULL,
	"config_digest" text NOT NULL,
	"verifier" text,
	"nonce" text,
	"subject" text,
	"scopes" jsonb DEFAULT '[]' NOT NULL,
	"expires_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ops_alert_state" (
	"condition_key" text PRIMARY KEY,
	"severity" text NOT NULL,
	"metric_bucket" text DEFAULT '0' NOT NULL,
	"detail" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"first_seen_at" text NOT NULL,
	"last_seen_at" text NOT NULL,
	"last_notified_at" text,
	"notify_count" bigint DEFAULT 0 NOT NULL,
	"created_at" text DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') NOT NULL,
	"updated_at" text DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') NOT NULL
);
--> statement-breakpoint
CREATE TABLE "org_capabilities" (
	"id" text PRIMARY KEY,
	"organization_id" text NOT NULL,
	"parent_id" text,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"description" text,
	"value_stream" text,
	"pace_layer" text NOT NULL,
	"maturity_score" double precision,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" text NOT NULL,
	"updated_at" text,
	"archived_at" text
);
--> statement-breakpoint
CREATE TABLE "organization_members" (
	"id" text PRIMARY KEY,
	"organization_id" text NOT NULL,
	"user_id" text,
	"descope_user_id" text NOT NULL,
	"email" text NOT NULL,
	"name" text,
	"avatar_url" text,
	"kind" text DEFAULT 'human' NOT NULL,
	"represented_user_id" text,
	"role" text DEFAULT 'member' NOT NULL,
	"custom_permissions" jsonb,
	"status" text DEFAULT 'active',
	"invited_at" text,
	"invite_accepted_at" text,
	"invited_by" text,
	"last_active_at" text,
	"created_at" text DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
	"updated_at" text DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
);
--> statement-breakpoint
CREATE TABLE "organization_purpose_charters" (
	"id" text PRIMARY KEY,
	"org_id" text NOT NULL,
	"version" bigint NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"purpose" text NOT NULL,
	"principles" jsonb DEFAULT '[]' NOT NULL,
	"strategic_theses" jsonb DEFAULT '[]' NOT NULL,
	"non_goals" jsonb DEFAULT '[]' NOT NULL,
	"evidence_refs" jsonb DEFAULT '[]' NOT NULL,
	"review_cadence_days" bigint DEFAULT 30 NOT NULL,
	"revision_reason" text NOT NULL,
	"created_by_user_id" text,
	"created_at" text NOT NULL,
	"activated_at" text NOT NULL,
	"superseded_at" text
);
--> statement-breakpoint
CREATE TABLE "organization_residency_policies" (
	"organization_id" text PRIMARY KEY,
	"mode" text NOT NULL,
	"revision" bigint NOT NULL,
	"updated_at" text NOT NULL,
	"updated_by" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "organization_secrets" (
	"id" text PRIMARY KEY,
	"organization_id" text NOT NULL,
	"name" text NOT NULL,
	"encrypted_value" text NOT NULL,
	"hint" text,
	"key_version" bigint DEFAULT 1 NOT NULL,
	"created_by" text,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "organizations" (
	"id" text PRIMARY KEY,
	"name" text NOT NULL,
	"slug" text NOT NULL UNIQUE,
	"type" text DEFAULT 'organization' NOT NULL,
	"descope_tenant_id" text UNIQUE,
	"logo_url" text,
	"description" text,
	"apps_count" bigint DEFAULT 0,
	"features" jsonb,
	"metadata" jsonb,
	"created_at" text DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
	"updated_at" text DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
);
--> statement-breakpoint
CREATE TABLE "os_approval_rules" (
	"id" text PRIMARY KEY,
	"organization_id" text NOT NULL,
	"action_kind" text NOT NULL,
	"tool_slug" text,
	"verb" text,
	"decision" text DEFAULT 'approve' NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_by_kind" text NOT NULL,
	"created_by_id" text NOT NULL,
	"created_at" text DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') NOT NULL,
	"disabled_at" text
);
--> statement-breakpoint
CREATE TABLE "os_blueprint_revisions" (
	"id" text PRIMARY KEY,
	"organization_id" text NOT NULL,
	"blueprint_id" text NOT NULL,
	"revision" bigint NOT NULL,
	"definition" text NOT NULL,
	"created_by_kind" text NOT NULL,
	"created_by_id" text NOT NULL,
	"created_at" text DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') NOT NULL,
	"published_at" text
);
--> statement-breakpoint
CREATE TABLE "os_blueprints" (
	"id" text PRIMARY KEY,
	"organization_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"status" text DEFAULT 'draft' NOT NULL,
	"visibility" text DEFAULT 'org' NOT NULL,
	"archived_from" jsonb,
	"current_revision_id" text,
	"lineage" text,
	"featured_at" text,
	"created_by_kind" text NOT NULL,
	"created_by_id" text NOT NULL,
	"created_at" text DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') NOT NULL,
	"updated_at" text DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') NOT NULL
);
--> statement-breakpoint
CREATE TABLE "os_collaboration_proposals" (
	"id" text PRIMARY KEY,
	"organization_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"document_type" text NOT NULL,
	"document_id" text NOT NULL,
	"base_revision_id" text NOT NULL,
	"base_revision" bigint NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"source_kind" text NOT NULL,
	"source_id" text NOT NULL,
	"source_attestation_version" bigint,
	"content" text NOT NULL,
	"sequence" bigint DEFAULT 0 NOT NULL,
	"created_by_kind" text NOT NULL,
	"created_by_id" text NOT NULL,
	"created_at" text DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') NOT NULL,
	"updated_at" text DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') NOT NULL,
	"decision_rationale" text,
	"decision_evidence_refs" text DEFAULT '[]' NOT NULL,
	"decided_by_kind" text,
	"decided_by_id" text,
	"decided_at" text,
	"merge_rationale" text,
	"merge_evidence_refs" text DEFAULT '[]' NOT NULL,
	"merged_by_kind" text,
	"merged_by_id" text,
	"merged_at" text,
	"result_revision_id" text,
	"result_revision" bigint
);
--> statement-breakpoint
CREATE TABLE "os_gadget_code" (
	"revision_id" text PRIMARY KEY,
	"organization_id" text NOT NULL,
	"gadget_id" text NOT NULL,
	"files" text NOT NULL,
	"code_length" bigint NOT NULL,
	"created_at" text DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') NOT NULL,
	"files_sha256" text
);
--> statement-breakpoint
CREATE TABLE "os_gadget_code_blobs" (
	"organization_id" text,
	"sha256" text,
	"files" text NOT NULL,
	"code_length" bigint NOT NULL,
	"created_at" text DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') NOT NULL,
	CONSTRAINT "os_gadget_code_blobs_pkey" PRIMARY KEY("organization_id","sha256")
);
--> statement-breakpoint
CREATE TABLE "os_gadget_executions" (
	"id" text PRIMARY KEY,
	"organization_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"gadget_id" text NOT NULL,
	"revision_id" text,
	"revision" bigint,
	"status" text NOT NULL,
	"granted_capabilities" text NOT NULL,
	"policy_decision" text NOT NULL,
	"input" text,
	"output" text,
	"body_r2_key" text,
	"body_bytes" bigint,
	"trace_metadata" text,
	"workspace_output_sha256" text,
	"error" text,
	"costs" text,
	"evidence_refs" text,
	"run_id" text,
	"workflow_instance_id" text,
	"tedi_id" text,
	"work_item_id" text,
	"trace_bundle_id" text,
	"billing_reservation_id" text,
	"approval_request_id" text,
	"runtime_environment" text,
	"agent_session_id" text,
	"resource_access_envelope" text,
	"execution_epoch" bigint DEFAULT 0 NOT NULL,
	"created_by_kind" text NOT NULL,
	"created_by_id" text NOT NULL,
	"created_at" text DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') NOT NULL,
	"completed_at" text
);
--> statement-breakpoint
CREATE TABLE "os_gadget_revisions" (
	"id" text PRIMARY KEY,
	"organization_id" text NOT NULL,
	"gadget_id" text NOT NULL,
	"revision" bigint NOT NULL,
	"manifest" text NOT NULL,
	"source_artifact_ref" text,
	"created_by_kind" text NOT NULL,
	"created_by_id" text NOT NULL,
	"created_at" text DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') NOT NULL
);
--> statement-breakpoint
CREATE TABLE "os_gadget_state" (
	"organization_id" text,
	"workspace_id" text NOT NULL,
	"gadget_id" text,
	"key" text,
	"revision" bigint NOT NULL,
	"value" text,
	"deleted" boolean NOT NULL,
	"access_envelope" text NOT NULL,
	"execution_id" text NOT NULL,
	"last_mutation_id" text NOT NULL,
	"updated_at" text NOT NULL,
	CONSTRAINT "os_gadget_state_pkey" PRIMARY KEY("organization_id","gadget_id","key")
);
--> statement-breakpoint
CREATE TABLE "os_gadget_state_mutations" (
	"organization_id" text,
	"gadget_id" text,
	"idempotency_key" text,
	"digest" text NOT NULL,
	"status" text NOT NULL,
	"result" text,
	"created_at" text NOT NULL,
	CONSTRAINT "os_gadget_state_mutations_pkey" PRIMARY KEY("organization_id","gadget_id","idempotency_key")
);
--> statement-breakpoint
CREATE TABLE "os_gadgets" (
	"id" text PRIMARY KEY,
	"organization_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"status" text DEFAULT 'active' NOT NULL,
	"current_revision_id" text,
	"has_runtime_triggers" boolean DEFAULT false NOT NULL,
	"has_work_navigation" boolean DEFAULT false NOT NULL,
	"trigger_enabled" jsonb DEFAULT '{}' NOT NULL,
	"source_blueprint_revision_id" text,
	"created_by_kind" text NOT NULL,
	"created_by_id" text NOT NULL,
	"created_at" text DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') NOT NULL,
	"updated_at" text DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') NOT NULL
);
--> statement-breakpoint
CREATE TABLE "os_review_batches" (
	"id" text PRIMARY KEY,
	"organization_id" text NOT NULL,
	"share_link_id" text NOT NULL,
	"source_output_id" text NOT NULL,
	"source_revision_id" text NOT NULL,
	"title" text NOT NULL,
	"cards" text NOT NULL,
	"access_envelope" text NOT NULL,
	"created_by_id" text NOT NULL,
	"created_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "os_review_feedback" (
	"id" text PRIMARY KEY,
	"organization_id" text NOT NULL,
	"batch_id" text NOT NULL,
	"card_id" text NOT NULL,
	"reviewer_id" text NOT NULL,
	"revision" bigint NOT NULL,
	"decision" text NOT NULL,
	"edited_reply" text NOT NULL,
	"reason" text NOT NULL,
	"updated_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "os_share_email_codes" (
	"id" text PRIMARY KEY,
	"share_link_id" text NOT NULL,
	"email" text NOT NULL,
	"code_hash" text NOT NULL,
	"ip_hash" text NOT NULL,
	"created_at" text NOT NULL,
	"expires_at" text NOT NULL,
	"attempts" bigint DEFAULT 0 NOT NULL,
	"consumed_at" text
);
--> statement-breakpoint
CREATE TABLE "os_share_link_invitees" (
	"id" text PRIMARY KEY,
	"organization_id" text NOT NULL,
	"share_link_id" text NOT NULL,
	"email" text,
	"user_id" text,
	"name" text,
	"added_by_kind" text NOT NULL,
	"added_by_id" text NOT NULL,
	"added_at" text DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') NOT NULL
);
--> statement-breakpoint
CREATE TABLE "os_share_links" (
	"id" text PRIMARY KEY,
	"organization_id" text NOT NULL,
	"resource_type" text NOT NULL,
	"resource_id" text NOT NULL,
	"public_id" text,
	"token_hash" text NOT NULL,
	"access" text DEFAULT 'anyone_with_link' NOT NULL,
	"role" text DEFAULT 'viewer' NOT NULL,
	"revision_mode" text DEFAULT 'living' NOT NULL,
	"pinned_revision_id" text,
	"pinned_snapshot" text,
	"note" text,
	"policy_max_role" text,
	"policy_reason" text,
	"policy_restricted_at" text,
	"created_by_kind" text NOT NULL,
	"created_by_id" text NOT NULL,
	"created_at" text DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') NOT NULL,
	"expires_at" text,
	"revoked_at" text,
	"disabled_at" text,
	"standalone" boolean
);
--> statement-breakpoint
CREATE TABLE "os_share_sessions" (
	"id" text PRIMARY KEY,
	"share_link_id" text NOT NULL,
	"session_token_hash" text NOT NULL,
	"verified_email" text,
	"created_at" text DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') NOT NULL,
	"last_seen_at" text DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') NOT NULL,
	"expires_at" text NOT NULL,
	"revoked_at" text
);
--> statement-breakpoint
CREATE TABLE "os_share_skill_read_grants" (
	"id" text PRIMARY KEY,
	"organization_id" text NOT NULL,
	"share_link_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"gadget_id" text NOT NULL,
	"revision_id" text NOT NULL,
	"resource_id" text NOT NULL,
	"provider_resource_id" text NOT NULL,
	"slot" text NOT NULL,
	"approved_by_user_id" text NOT NULL,
	"approved_at" text NOT NULL,
	"revoked_at" text
);
--> statement-breakpoint
CREATE TABLE "os_workspace_access_edges" (
	"id" text PRIMARY KEY,
	"organization_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"target_user_id" text NOT NULL,
	"kind" text NOT NULL,
	"edge_key" text NOT NULL,
	"sharer_user_id" text,
	"link_id" text,
	"role" text,
	"note" text,
	"created_at" text DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') NOT NULL
);
--> statement-breakpoint
CREATE TABLE "os_workspace_collaborators" (
	"id" text PRIMARY KEY,
	"organization_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"user_id" text NOT NULL,
	"principal_kind" text DEFAULT 'user' NOT NULL,
	"email" text,
	"name" text,
	"created_at" text DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') NOT NULL,
	"first_opened_at" text,
	"last_opened_at" text,
	"cached_title" text,
	"cached_owner_name" text,
	"dismissed_at" text
);
--> statement-breakpoint
CREATE TABLE "os_workspace_events" (
	"seq" bigint PRIMARY KEY GENERATED BY DEFAULT AS IDENTITY (sequence name "os_workspace_events_seq_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"workspace_id" text NOT NULL,
	"kind" text NOT NULL,
	"created_at" text DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') NOT NULL
);
--> statement-breakpoint
CREATE TABLE "os_workspace_projects" (
	"id" text PRIMARY KEY,
	"organization_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"project_id" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_by_kind" text NOT NULL,
	"created_by_id" text NOT NULL,
	"created_at" text DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') NOT NULL,
	"updated_at" text DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') NOT NULL,
	"removed_at" text
);
--> statement-breakpoint
CREATE TABLE "os_workspace_resources" (
	"id" text PRIMARY KEY,
	"organization_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"slot" text,
	"provider_id" text NOT NULL,
	"connection_scope" text NOT NULL,
	"personal_owner_user_id" text,
	"connection_instance_id" text,
	"provider_access" jsonb,
	"required_scopes" text DEFAULT '[]' NOT NULL,
	"resource_type" text NOT NULL,
	"provider_resource_id" text NOT NULL,
	"name" text NOT NULL,
	"metadata" text DEFAULT '{}' NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_by_kind" text NOT NULL,
	"created_by_id" text NOT NULL,
	"created_at" text DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') NOT NULL,
	"updated_at" text DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') NOT NULL,
	"removed_at" text
);
--> statement-breakpoint
CREATE TABLE "os_workspace_share_keys" (
	"key_hash" text PRIMARY KEY,
	"link_id" text NOT NULL,
	"created_at" text DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') NOT NULL
);
--> statement-breakpoint
CREATE TABLE "os_workspace_share_links" (
	"id" text PRIMARY KEY,
	"organization_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"creator_user_id" text NOT NULL,
	"role" text NOT NULL,
	"label" text,
	"created_at" text DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') NOT NULL,
	"revoked_at" text
);
--> statement-breakpoint
CREATE TABLE "os_workspace_skill_draft_grants" (
	"organization_id" text,
	"member_id" text,
	"workspace_id" text,
	"resource_id" text,
	"skill_id" text NOT NULL,
	"enabled" boolean NOT NULL,
	"expires_at" text NOT NULL,
	"granted_by" text NOT NULL,
	"updated_at" text NOT NULL,
	CONSTRAINT "os_workspace_skill_draft_grants_pkey" PRIMARY KEY("organization_id","member_id","workspace_id","resource_id")
);
--> statement-breakpoint
CREATE TABLE "os_workspace_skill_draft_proposals" (
	"id" text PRIMARY KEY,
	"organization_id" text NOT NULL,
	"member_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"resource_id" text NOT NULL,
	"skill_id" text NOT NULL,
	"source_revision" bigint NOT NULL,
	"base_content" text NOT NULL,
	"base_files" jsonb,
	"content" text NOT NULL,
	"files" jsonb,
	"reason" text NOT NULL,
	"payload_digest" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"withdrawn_at" text,
	"created_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "os_workspace_summaries" (
	"workspace_id" text PRIMARY KEY,
	"organization_id" text NOT NULL,
	"revision" bigint NOT NULL,
	"usage" text DEFAULT '{}' NOT NULL,
	"run_status" text DEFAULT '{}' NOT NULL,
	"work_links" text DEFAULT '[]' NOT NULL,
	"published_at" text NOT NULL,
	"applied_at" text NOT NULL,
	"created_at" text DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') NOT NULL,
	"updated_at" text DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') NOT NULL
);
--> statement-breakpoint
CREATE TABLE "os_workspaces" (
	"id" text PRIMARY KEY,
	"organization_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"status" text DEFAULT 'active' NOT NULL,
	"source_blueprint_id" text,
	"source_blueprint_revision_id" text,
	"source_blueprint_revision_number" bigint,
	"instantiation_preflight" text,
	"previous_blueprint_revision_id" text,
	"previous_blueprint_revision_number" bigint,
	"previous_instantiation_preflight" text,
	"blueprint_decision" text,
	"created_by_kind" text NOT NULL,
	"created_by_id" text NOT NULL,
	"created_at" text DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') NOT NULL,
	"updated_at" text DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') NOT NULL,
	"visibility" text DEFAULT 'org' NOT NULL,
	"owner_user_id" text,
	"icon_url" text,
	"default_tedi_id" text,
	"machine_access" boolean,
	"highest_approval_mode" text
);
--> statement-breakpoint
CREATE TABLE "personal_agent_client_rates" (
	"organization_id" text,
	"client_id" text,
	"window_start" bigint NOT NULL,
	"requests" bigint NOT NULL,
	CONSTRAINT "personal_agent_client_rates_pkey" PRIMARY KEY("organization_id","client_id")
);
--> statement-breakpoint
CREATE TABLE "personal_agent_sessions" (
	"organization_id" text,
	"client_id" text,
	"session_id" text,
	"user_id" text,
	"agent_id" text,
	"version" text NOT NULL,
	"created_at" bigint NOT NULL,
	"ended_at" bigint,
	CONSTRAINT "personal_agent_sessions_pkey" PRIMARY KEY("organization_id","client_id","session_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "personal_resource_delegations" (
	"id" text PRIMARY KEY,
	"organization_id" text NOT NULL,
	"owner_user_id" text NOT NULL,
	"tedi_id" text NOT NULL,
	"skill_id" text NOT NULL,
	"skill_revision" bigint NOT NULL,
	"workspace_id" text NOT NULL,
	"resource_id" text NOT NULL,
	"connection_instance_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"resource_type" text NOT NULL,
	"provider_resource_id" text NOT NULL,
	"account_subject" text NOT NULL,
	"grant_fingerprint" text NOT NULL,
	"required_scopes" jsonb NOT NULL,
	"operations" jsonb NOT NULL,
	"tool_ids" jsonb NOT NULL,
	"created_at" text NOT NULL,
	"expires_at" text NOT NULL,
	"revoked_at" text
);
--> statement-breakpoint
CREATE TABLE "platform_cron_checkpoints" (
	"schedule_id" text PRIMARY KEY,
	"through" text NOT NULL,
	"cursor" jsonb
);
--> statement-breakpoint
CREATE TABLE "platform_cron_executions" (
	"id" text PRIMARY KEY,
	"schedule_id" text NOT NULL,
	"cron" text NOT NULL,
	"scheduled_at" text NOT NULL,
	"started_at" text NOT NULL,
	"finished_at" text,
	"status" text DEFAULT 'running' NOT NULL,
	"duration_ms" bigint,
	"affected_row_counts" jsonb DEFAULT '{}' NOT NULL,
	"error" text,
	"created_at" text DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') NOT NULL
);
--> statement-breakpoint
CREATE TABLE "policy_packs" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid(),
	"organization_id" text,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"description" text,
	"scope" text DEFAULT 'organization' NOT NULL,
	"target" text DEFAULT 'shared' NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"version" bigint DEFAULT 1 NOT NULL,
	"supersedes_revision_id" text,
	"rollback_of_revision_id" text,
	"change_summary" text,
	"published_at" text,
	"published_by" text,
	"definition" jsonb NOT NULL,
	"created_at" text DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
	"updated_at" text DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
);
--> statement-breakpoint
CREATE TABLE "principal_identities" (
	"id" text PRIMARY KEY,
	"organization_id" text,
	"principal_type" text NOT NULL,
	"principal_id" text NOT NULL,
	"provider" text NOT NULL,
	"issuer" text NOT NULL,
	"subject" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"metadata" jsonb DEFAULT '{}' NOT NULL,
	"last_verified_at" text,
	"created_at" text DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') NOT NULL,
	"updated_at" text DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') NOT NULL
);
--> statement-breakpoint
CREATE TABLE "projects" (
	"id" text PRIMARY KEY,
	"org_id" text NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"status" text DEFAULT 'active' NOT NULL,
	"lead_tedi_id" text,
	"owner_user_id" text,
	"objective_id" text,
	"target_date" text,
	"metadata" jsonb DEFAULT '{}',
	"created_at" text NOT NULL,
	"updated_at" text,
	"archived_at" text,
	"archived_from_status" text
);
--> statement-breakpoint
CREATE TABLE "promotion_decision_observations" (
	"id" text PRIMARY KEY,
	"organization_id" text NOT NULL,
	"decision_id" text NOT NULL,
	"observation_id" text NOT NULL,
	"created_at" text DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') NOT NULL
);
--> statement-breakpoint
CREATE TABLE "promotion_decisions" (
	"id" text PRIMARY KEY,
	"organization_id" text NOT NULL,
	"client_proposal_id" text NOT NULL,
	"input_hash" text NOT NULL,
	"tedi_id" text NOT NULL,
	"role_assignment_id" text,
	"activity_id" text,
	"kind" text NOT NULL,
	"status" text DEFAULT 'proposed' NOT NULL,
	"from_career_stage" text,
	"to_career_stage" text,
	"from_entrustment_level" text,
	"from_entrustment_status" text,
	"to_entrustment_level" text,
	"target_role_template_id" text,
	"target_role_key" text,
	"target_role_name" text,
	"target_scope" jsonb,
	"target_expires_at" text,
	"target_next_review_at" text,
	"expected_role_revision" bigint,
	"expected_entrustment_revision" bigint,
	"evidence_observation_ids" jsonb NOT NULL,
	"evidence_refs" jsonb NOT NULL,
	"evidence_snapshot" jsonb NOT NULL,
	"proposed_by_type" text NOT NULL,
	"proposed_by_id" text NOT NULL,
	"decided_by_type" text,
	"decided_by_id" text,
	"reason" text,
	"created_at" text DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') NOT NULL,
	"updated_at" text DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') NOT NULL,
	"proposal_expires_at" text NOT NULL,
	"decided_at" text,
	"applied_at" text
);
--> statement-breakpoint
CREATE TABLE "provider_event_channels" (
	"id" text PRIMARY KEY,
	"subscription_id" text NOT NULL,
	"organization_id" text NOT NULL,
	"token_hash" text NOT NULL,
	"signing_secret_ciphertext" text,
	"provider_channel_id" text,
	"resource_id" text,
	"status" text NOT NULL,
	"expires_at" text NOT NULL,
	"created_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "provider_event_deliveries" (
	"id" text PRIMARY KEY,
	"organization_id" text NOT NULL,
	"subscription_id" text NOT NULL,
	"status" text NOT NULL,
	"attempts" bigint DEFAULT 0 NOT NULL,
	"payload" jsonb,
	"lease_until" text,
	"created_at" text NOT NULL,
	"sent_at" text
);
--> statement-breakpoint
CREATE TABLE "provider_event_subscriptions" (
	"id" text PRIMARY KEY,
	"organization_id" text NOT NULL,
	"adapter" text NOT NULL,
	"provider_id" text NOT NULL,
	"connection_instance_id" text,
	"resource_key" text NOT NULL,
	"mcp_app_id" text,
	"event_arguments" jsonb,
	"event_cursor" text,
	"max_wakes_per_hour" bigint,
	"wake_window_started_at" text,
	"wake_window_count" bigint DEFAULT 0 NOT NULL,
	"connection_scope" text DEFAULT 'tenant' NOT NULL,
	"personal_owner_user_id" text,
	"workspace_id" text,
	"workspace_resource_id" text,
	"delegation_id" text,
	"execution_tool_id" text,
	"resource_delegation_ids" jsonb DEFAULT '[]' NOT NULL,
	"tedi_id" text NOT NULL,
	"skill_id" text NOT NULL,
	"skill_revision" bigint NOT NULL,
	"delivery_mode" text NOT NULL,
	"status" text NOT NULL,
	"expires_at" text,
	"next_reconcile_at" text NOT NULL,
	"last_notification_at" text,
	"last_dispatch_at" text,
	"last_error" text,
	"lease_until" text,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL
);
--> statement-breakpoint
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
	"origin" jsonb,
	"origin_hash" text,
	"policy" jsonb,
	"policy_hash" text
);
--> statement-breakpoint
CREATE TABLE "provider_installations" (
	"id" text PRIMARY KEY,
	"provider_organization_id" text NOT NULL,
	"provider_app_id" text NOT NULL,
	"provider_api_key_id" text NOT NULL,
	"external_tenant_id" text NOT NULL,
	"customer_organization_id" text NOT NULL,
	"primary_workspace_id" text NOT NULL,
	"primary_tedi_id" text NOT NULL,
	"allowed_origin" text NOT NULL,
	"host_tenant_argument" text NOT NULL,
	"host_tenant_namespace" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"provisioned_by" text NOT NULL,
	"company_profile" jsonb,
	"provenance" jsonb,
	"created_at" text DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') NOT NULL,
	"updated_at" text DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') NOT NULL,
	"paused_at" text
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
	"supersedes_rate_version_id" text
);
--> statement-breakpoint
CREATE TABLE "provider_probe_receipts" (
	"id" text PRIMARY KEY,
	"organization_id" text NOT NULL,
	"actor_user_id" text NOT NULL,
	"profile_id" text NOT NULL,
	"profile_digest" text NOT NULL,
	"args_digest" text NOT NULL,
	"expires_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "provider_probe_results" (
	"id" text PRIMARY KEY,
	"organization_id" text NOT NULL,
	"actor_user_id" text NOT NULL,
	"profile_id" text NOT NULL,
	"profile_digest" text NOT NULL,
	"args_digest" text NOT NULL,
	"account_revision_digest" text NOT NULL,
	"expires_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rationale_org_counts" (
	"org_id" text PRIMARY KEY,
	"total" bigint DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "release_locks" (
	"surface" text PRIMARY KEY,
	"owner_token" text NOT NULL,
	"target_sha" text NOT NULL,
	"started_at" bigint NOT NULL,
	"github_run_id" text,
	"github_job_id" text
);
--> statement-breakpoint
CREATE TABLE "residency_execution_receipts" (
	"execution_id" text PRIMARY KEY,
	"organization_id" text NOT NULL,
	"policy_revision" bigint NOT NULL,
	"member_key" text NOT NULL,
	"pool_revision" bigint NOT NULL,
	"provider_origin" text NOT NULL,
	"evidence_ref" text NOT NULL,
	"credential_ref" text NOT NULL,
	"created_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "residency_provider_versions" (
	"id" text PRIMARY KEY,
	"member_key" text NOT NULL,
	"revision" bigint NOT NULL,
	"config" jsonb NOT NULL,
	"published_at" text NOT NULL,
	"published_by" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "role_templates" (
	"id" text PRIMARY KEY,
	"org_id" text,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"persona" text NOT NULL,
	"standing_objectives" jsonb DEFAULT '[]' NOT NULL,
	"tags" jsonb DEFAULT '[]' NOT NULL,
	"capability_profile" text DEFAULT 'standard' NOT NULL,
	"cron_template_names" jsonb DEFAULT '[]' NOT NULL,
	"metadata" jsonb DEFAULT '{}' NOT NULL,
	"created_at" text NOT NULL,
	"updated_at" text,
	"archived_at" text
);
--> statement-breakpoint
CREATE TABLE "runtime_profiles" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid(),
	"organization_id" text,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"description" text,
	"scope" text DEFAULT 'organization' NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"version" bigint DEFAULT 1 NOT NULL,
	"supersedes_revision_id" text,
	"rollback_of_revision_id" text,
	"change_summary" text,
	"published_at" text,
	"published_by" text,
	"config" jsonb NOT NULL,
	"created_at" text DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
	"updated_at" text DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
);
--> statement-breakpoint
CREATE TABLE "runtime_submission_attempts" (
	"id" text PRIMARY KEY,
	"submission_id" text NOT NULL,
	"organization_id" text NOT NULL,
	"attempt_no" bigint NOT NULL,
	"status" text DEFAULT 'started' NOT NULL,
	"runtime_backend" text,
	"runtime_external_id" text,
	"error" text,
	"metadata" jsonb,
	"started_at" text DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') NOT NULL,
	"heartbeat_at" text,
	"completed_at" text
);
--> statement-breakpoint
CREATE TABLE "runtime_submissions" (
	"id" text PRIMARY KEY,
	"organization_id" text NOT NULL,
	"subject_kind" text NOT NULL,
	"subject_id" text NOT NULL,
	"tedi_id" text,
	"conversation_id" text,
	"run_id" text,
	"idempotency_key" text,
	"source_kind" text NOT NULL,
	"source_provider" text,
	"source_delivery_id" text,
	"status" text DEFAULT 'admitted' NOT NULL,
	"current_attempt_id" text,
	"attempt_count" bigint DEFAULT 0 NOT NULL,
	"runtime_backend" text,
	"metadata" jsonb,
	"created_at" text DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') NOT NULL,
	"updated_at" text DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') NOT NULL,
	"settled_at" text,
	"timeout_at" text,
	"phase" text,
	"input_applied_at" text,
	"abort_requested_at" text,
	"max_retry" bigint DEFAULT 10 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "site_reconciliation_findings" (
	"id" text PRIMARY KEY,
	"run_id" text NOT NULL,
	"organization_id" text NOT NULL,
	"site_id" text NOT NULL,
	"site_slug" text NOT NULL,
	"site_type" text NOT NULL,
	"code" text NOT NULL,
	"severity" text NOT NULL,
	"detail" text NOT NULL,
	"first_detected_at" text NOT NULL,
	"last_detected_at" text NOT NULL,
	"resolved_at" text,
	"created_at" text DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') NOT NULL
);
--> statement-breakpoint
CREATE TABLE "site_reconciliation_runs" (
	"id" text PRIMARY KEY,
	"organization_id" text NOT NULL,
	"source" text NOT NULL,
	"started_at" text NOT NULL,
	"completed_at" text NOT NULL,
	"sites_checked" bigint NOT NULL,
	"issue_count" bigint NOT NULL,
	"created_at" text DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') NOT NULL
);
--> statement-breakpoint
CREATE TABLE "skill_entries" (
	"id" text PRIMARY KEY,
	"organization_id" text NOT NULL,
	"tedi_id" text,
	"domain_id" text,
	"title" text NOT NULL,
	"slug" text,
	"folder_path" text,
	"description" text,
	"content" text NOT NULL,
	"files" jsonb,
	"input_schema" jsonb,
	"success_count" bigint DEFAULT 0 NOT NULL,
	"failure_count" bigint DEFAULT 0 NOT NULL,
	"last_used_at" text,
	"avg_duration_ms" bigint,
	"revision" bigint DEFAULT 1 NOT NULL,
	"revision_reasoning" text,
	"supersedes_id" text,
	"source_skill_id" text,
	"source_revision" bigint,
	"improvement_adoption" jsonb,
	"visibility" text DEFAULT 'private' NOT NULL,
	"agent_skills_format" text,
	"r2_path" text,
	"app_id" text,
	"tool_ids" jsonb,
	"mcp_app_bindings" jsonb,
	"summary" text,
	"tags" jsonb,
	"audience" jsonb,
	"preconditions" jsonb,
	"lifecycle_state" text DEFAULT 'draft',
	"archived_from" jsonb,
	"review_flagged_at" text,
	"review_flag_reason" text,
	"pace_layer" text DEFAULT 'innovation' NOT NULL,
	"proposed_by_tedi_id" text,
	"created_at" text DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
	"updated_at" text DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
);
--> statement-breakpoint
CREATE TABLE "skill_run_admission_dedup" (
	"fingerprint" text PRIMARY KEY,
	"run_id" text NOT NULL,
	"expires_at" text NOT NULL,
	"created_at" text DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') NOT NULL
);
--> statement-breakpoint
CREATE TABLE "skill_run_artifacts" (
	"id" text PRIMARY KEY,
	"run_id" text NOT NULL,
	"path" text NOT NULL,
	"mime_type" text DEFAULT 'application/json' NOT NULL,
	"size_bytes" bigint DEFAULT 0 NOT NULL,
	"content_inline" text,
	"content_r2_key" text,
	"sha256" text,
	"attempt" bigint DEFAULT 1 NOT NULL,
	"outcome" text DEFAULT 'success' NOT NULL,
	"created_at" text DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
);
--> statement-breakpoint
CREATE TABLE "skill_run_effect_observations" (
	"id" text PRIMARY KEY,
	"organization_id" text NOT NULL,
	"skill_run_id" text NOT NULL,
	"work_item_id" text,
	"source" text DEFAULT 'human_attestation' NOT NULL,
	"observer_user_id" text NOT NULL,
	"observed_state" text NOT NULL,
	"evidence_ref" text NOT NULL,
	"effect_note" text NOT NULL,
	"observed_at" text NOT NULL,
	"created_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "skill_runs" (
	"id" text PRIMARY KEY,
	"organization_id" text NOT NULL,
	"skill_id" text NOT NULL,
	"tedi_id" text NOT NULL,
	"workflow_instance_id" text NOT NULL,
	"execution_epoch" bigint DEFAULT 0 NOT NULL,
	"restart_requested_at" text,
	"restart_command_id" text,
	"workflow_retired_at" text,
	"runtime_environment" text NOT NULL,
	"last_reconciled_at" text,
	"status" text DEFAULT 'queued' NOT NULL,
	"params" jsonb,
	"result" jsonb,
	"error" text,
	"resource_access_envelope" jsonb,
	"capability_manifest" jsonb,
	"cost_summary" jsonb,
	"workflow_source" text,
	"workflow_source_hash" text,
	"skill_doc" text,
	"skill_revision" bigint,
	"skill_slug" text,
	"started_at" text DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
	"completed_at" text,
	"paused_at" text,
	"created_by" text,
	"certification" boolean DEFAULT false,
	"work_item_id" text,
	"origin_tedi_run_id" text,
	"sensitive_data_latch" jsonb
);
--> statement-breakpoint
CREATE TABLE "skill_schedules" (
	"id" text PRIMARY KEY,
	"organization_id" text NOT NULL,
	"skill_id" text NOT NULL,
	"tedi_id" text NOT NULL,
	"cron" text NOT NULL,
	"params" jsonb NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"next_fire_at" text NOT NULL,
	"last_fire_at" text,
	"last_run_id" text,
	"last_error" text,
	"last_budget_blocked_at" text,
	"last_budget_blocked_reason" text,
	"last_budget_reset_at" text,
	"last_budget_admission_class" text,
	"created_at" text DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
	"updated_at" text DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
);
--> statement-breakpoint
CREATE TABLE "skill_usage_events" (
	"id" text PRIMARY KEY,
	"organization_id" text NOT NULL,
	"tedi_id" text,
	"skill_id" text NOT NULL,
	"run_id" text NOT NULL,
	"execution_epoch" bigint DEFAULT 0 NOT NULL,
	"source" text NOT NULL,
	"outcome" text NOT NULL,
	"error" text,
	"started_at" text,
	"finished_at" text,
	"duration_ms" bigint,
	"created_at" text DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
);
--> statement-breakpoint
CREATE TABLE "skill_workflow_sources" (
	"skill_id" text,
	"sha256" text,
	"workflow_source" text NOT NULL,
	CONSTRAINT "skill_workflow_sources_pkey" PRIMARY KEY("skill_id","sha256")
);
--> statement-breakpoint
CREATE TABLE "stripe_webhook_events" (
	"event_id" text PRIMARY KEY,
	"event_type" text NOT NULL,
	"entity_key" text NOT NULL,
	"event_created_at" bigint NOT NULL,
	"status" text DEFAULT 'processing' NOT NULL,
	"attempt_count" bigint DEFAULT 1 NOT NULL,
	"lease_expires_at" text,
	"outcome" text,
	"last_error" text,
	"processed_at" text,
	"created_at" text DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') NOT NULL,
	"updated_at" text DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') NOT NULL
);
--> statement-breakpoint
CREATE TABLE "support_configuration" (
	"id" text PRIMARY KEY,
	"configuration" jsonb NOT NULL,
	"updated_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "support_tickets" (
	"id" text PRIMARY KEY,
	"org_id" text NOT NULL,
	"platform_org_id" text NOT NULL,
	"reporter_key" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"work_item_id" text NOT NULL,
	"mirror_work_item_id" text NOT NULL,
	"project_id" text NOT NULL,
	"report" jsonb NOT NULL,
	"consent_reference" text NOT NULL,
	"payload_digest" text NOT NULL,
	"status" text DEFAULT 'received' NOT NULL,
	"mirror_delivery" text DEFAULT 'pending' NOT NULL,
	"version" bigint DEFAULT 1 NOT NULL,
	"draft" jsonb,
	"public_updates" jsonb DEFAULT '[]' NOT NULL,
	"reporter_verification" text DEFAULT 'unconfirmed' NOT NULL,
	"update_keys" jsonb DEFAULT '[]' NOT NULL,
	"next_update_due" text NOT NULL,
	"escalation_work_item_id" text,
	"interaction_id" text,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tedi_approval_dependency_events" (
	"id" text PRIMARY KEY,
	"organization_id" text NOT NULL,
	"dependent_approval_request_id" text NOT NULL,
	"prerequisite_approval_request_id" text NOT NULL,
	"simulation_id" text NOT NULL,
	"event_type" text NOT NULL,
	"dependency_kind" text NOT NULL,
	"invalidates_event_id" text,
	"reason" text,
	"record_hash" text NOT NULL,
	"created_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tedi_approval_execution_receipts" (
	"id" text PRIMARY KEY,
	"organization_id" text NOT NULL,
	"approval_request_id" text NOT NULL,
	"simulation_id" text,
	"idempotency_key" text NOT NULL,
	"canonical_input_hash" text NOT NULL,
	"record_hash" text NOT NULL,
	"baseline_fence_outcome" text NOT NULL,
	"outcome" text NOT NULL,
	"observed_result" jsonb,
	"observed_error" jsonb,
	"provider_receipt_refs" jsonb NOT NULL,
	"executed_at" text NOT NULL,
	"created_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tedi_approval_requests" (
	"id" text PRIMARY KEY,
	"tedi_id" text NOT NULL,
	"org_id" text NOT NULL,
	"action_type" text NOT NULL,
	"description" text NOT NULL,
	"payload" jsonb NOT NULL,
	"work_item_id" text,
	"execution_status" text,
	"execution_dismissed_at" text,
	"consumed_at" text,
	"delegated_owner_id" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_at" text NOT NULL,
	"expires_at" text NOT NULL,
	"resolved_at" text,
	"resolved_by" text,
	"resolution" text,
	"workflow_id" text
);
--> statement-breakpoint
CREATE TABLE "tedi_approval_simulations" (
	"id" text PRIMARY KEY,
	"organization_id" text NOT NULL,
	"approval_request_id" text NOT NULL,
	"simulator_id" text NOT NULL,
	"simulator_version" text NOT NULL,
	"canonical_input_hash" text NOT NULL,
	"record_hash" text NOT NULL,
	"baseline_evidence_refs" jsonb NOT NULL,
	"predicted_result" jsonb NOT NULL,
	"assumptions" jsonb NOT NULL,
	"confidence" double precision NOT NULL,
	"evidence_kind" text DEFAULT 'simulation' NOT NULL,
	"not_proof" boolean DEFAULT true NOT NULL,
	"created_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tedi_artifact_contribution_receipts" (
	"id" text PRIMARY KEY,
	"organization_id" text NOT NULL,
	"tedi_id" text NOT NULL,
	"artifact_id" text NOT NULL,
	"producer_runtime_event_id" text NOT NULL,
	"conversation_id" text NOT NULL,
	"run_id" text NOT NULL,
	"content_digest" text NOT NULL,
	"observation_digest" text NOT NULL,
	"observations" jsonb NOT NULL,
	"completeness" text NOT NULL,
	"created_at" text DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tedi_artifacts" (
	"id" text PRIMARY KEY,
	"organization_id" text NOT NULL,
	"tedi_id" text NOT NULL,
	"conversation_id" text,
	"run_id" text,
	"message_id" text,
	"kind" text NOT NULL,
	"name" text NOT NULL,
	"mime_type" text,
	"uri" text,
	"size_bytes" bigint,
	"metadata" jsonb,
	"access_classification" text,
	"content_digest" text,
	"producer_execution_id" text,
	"access_envelope" text,
	"publication_state" text,
	"created_at" text DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') NOT NULL
);
--> statement-breakpoint
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
	"session_type" text DEFAULT 'unattributed' NOT NULL,
	"source" text DEFAULT 'ai-gateway-log' NOT NULL,
	"usage_kind" text,
	"usage_unit" text,
	"usage_quantity" bigint,
	"input_tokens" bigint DEFAULT 0 NOT NULL,
	"output_tokens" bigint DEFAULT 0 NOT NULL,
	"cache_read_tokens" bigint DEFAULT 0 NOT NULL,
	"cache_write_tokens" bigint DEFAULT 0 NOT NULL,
	"total_tokens" bigint DEFAULT 0 NOT NULL,
	"estimated_cost_usd" double precision,
	"provider_execution_id" text,
	"call_duration_ms" double precision,
	"raw_reported_cost_usd" double precision,
	"provider_rate_version_id" text,
	"cost_basis" text DEFAULT 'legacy_estimate' NOT NULL,
	"cost_reason" text,
	"session_count" bigint DEFAULT 0 NOT NULL,
	"success" boolean DEFAULT true NOT NULL,
	"cached" boolean DEFAULT false NOT NULL,
	"data_quality" text DEFAULT 'ok' NOT NULL,
	"created_at" text DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
);
--> statement-breakpoint
CREATE TABLE "tedi_console_grants" (
	"organization_id" text,
	"tedi_id" text,
	"enabled" boolean DEFAULT false NOT NULL,
	"workspace_ids" jsonb NOT NULL,
	"revision" text NOT NULL,
	"granted_by" text NOT NULL,
	"updated_at" text NOT NULL,
	CONSTRAINT "tedi_console_grants_pkey" PRIMARY KEY("organization_id","tedi_id")
);
--> statement-breakpoint
CREATE TABLE "tedi_control_plane_binding_history" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid(),
	"organization_id" text NOT NULL,
	"tedi_id" text NOT NULL,
	"kind" text NOT NULL,
	"previous_revision_id" text,
	"revision_id" text NOT NULL,
	"changed_by" text,
	"change_reason" text,
	"effective_at" text DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tedi_cron_executions" (
	"id" text PRIMARY KEY,
	"tedi_id" text NOT NULL,
	"org_id" text NOT NULL,
	"cron_name" text NOT NULL,
	"fire_key" text NOT NULL,
	"run_id" text,
	"status" text DEFAULT 'running' NOT NULL,
	"started_at" text NOT NULL,
	"finished_at" text,
	"transitions" jsonb,
	"error" text,
	"created_at" text DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tedi_curiosity_queue" (
	"id" text PRIMARY KEY,
	"tedi_id" text NOT NULL,
	"organization_id" text NOT NULL,
	"topic" text NOT NULL,
	"domain" text NOT NULL,
	"reason" text NOT NULL,
	"priority" double precision DEFAULT 0.5 NOT NULL,
	"source" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"facts_learned" bigint DEFAULT 0 NOT NULL,
	"gaps_found" bigint DEFAULT 0 NOT NULL,
	"completed_at" text,
	"created_at" text DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
	"updated_at" text DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
);
--> statement-breakpoint
CREATE TABLE "tedi_custom_domains" (
	"id" text PRIMARY KEY,
	"tedi_id" text NOT NULL,
	"hostname" text NOT NULL,
	"status" text DEFAULT 'pending',
	"ssl_status" text DEFAULT 'pending',
	"created_at" text DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
	"updated_at" text DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
);
--> statement-breakpoint
CREATE TABLE "tedi_devices" (
	"id" text PRIMARY KEY,
	"tedi_id" text NOT NULL,
	"device_id" text NOT NULL,
	"display_name" text,
	"platform" text,
	"channel" text,
	"status" text DEFAULT 'pending',
	"paired_at" text,
	"revoked_at" text,
	"created_at" text DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
);
--> statement-breakpoint
CREATE TABLE "tedi_email_addresses" (
	"id" text PRIMARY KEY,
	"organization_id" text NOT NULL,
	"tedi_id" text NOT NULL,
	"address" text NOT NULL,
	"local_part" text NOT NULL,
	"domain" text NOT NULL,
	"kind" text DEFAULT 'primary' NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"routing_policy" jsonb,
	"created_by" text,
	"created_at" text DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
	"updated_at" text DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
);
--> statement-breakpoint
CREATE TABLE "tedi_email_attachments" (
	"id" text PRIMARY KEY,
	"message_id" text NOT NULL,
	"filename" text,
	"content_type" text,
	"size" bigint,
	"r2_key" text,
	"content_id" text,
	"disposition" text,
	"created_at" text DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
);
--> statement-breakpoint
CREATE TABLE "tedi_email_events" (
	"id" text PRIMARY KEY,
	"message_id" text,
	"thread_id" text,
	"organization_id" text NOT NULL,
	"tedi_id" text NOT NULL,
	"event_type" text NOT NULL,
	"provider" text,
	"payload_json" jsonb,
	"created_at" text DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
);
--> statement-breakpoint
CREATE TABLE "tedi_email_messages" (
	"id" text PRIMARY KEY,
	"thread_id" text NOT NULL,
	"organization_id" text NOT NULL,
	"tedi_id" text NOT NULL,
	"direction" text NOT NULL,
	"from_addr" text NOT NULL,
	"from_json" jsonb,
	"to_json" jsonb NOT NULL,
	"cc_json" jsonb,
	"bcc_json" jsonb,
	"reply_to_json" jsonb,
	"subject" text NOT NULL,
	"body_preview" text,
	"text_body" text,
	"html_r2_key" text,
	"raw_r2_key" text,
	"message_id_header" text,
	"in_reply_to" text,
	"references_json" jsonb,
	"provider_message_id" text,
	"received_at" text,
	"sent_at" text,
	"read_at" text,
	"archived_at" text,
	"spam_score" double precision,
	"status" text NOT NULL,
	"created_at" text DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
	"updated_at" text DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
);
--> statement-breakpoint
CREATE TABLE "tedi_email_threads" (
	"id" text PRIMARY KEY,
	"organization_id" text NOT NULL,
	"tedi_id" text NOT NULL,
	"subject_norm" text NOT NULL,
	"participants_json" jsonb,
	"last_message_at" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"labels_json" jsonb,
	"unread_count" bigint DEFAULT 0 NOT NULL,
	"sender_trust" text DEFAULT 'trusted' NOT NULL,
	"created_at" text DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
	"updated_at" text DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
);
--> statement-breakpoint
CREATE TABLE "tedi_email_trusted_recipients" (
	"id" text PRIMARY KEY,
	"organization_id" text NOT NULL,
	"tedi_id" text NOT NULL,
	"address" text NOT NULL,
	"created_by" text NOT NULL,
	"created_at" text DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') NOT NULL,
	"revoked_at" text,
	"revoked_by" text
);
--> statement-breakpoint
CREATE TABLE "tedi_entrustment_grants" (
	"id" text PRIMARY KEY,
	"organization_id" text NOT NULL,
	"tedi_id" text NOT NULL,
	"role_assignment_id" text,
	"activity_id" text NOT NULL,
	"level" text DEFAULT 'observe' NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"scope" jsonb NOT NULL,
	"revision" bigint DEFAULT 1 NOT NULL,
	"last_certified_at" text,
	"expires_at" text,
	"next_review_at" text NOT NULL,
	"restricted_at" text,
	"reason" text,
	"last_decision_id" text NOT NULL,
	"activity_version" bigint NOT NULL,
	"rubric_hash" text NOT NULL,
	"evidence_policy_hash" text NOT NULL,
	"evidence_snapshot_hash" text NOT NULL,
	"granted_by_type" text NOT NULL,
	"granted_by_id" text NOT NULL,
	"created_at" text DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') NOT NULL,
	"updated_at" text DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tedi_expertise" (
	"id" text PRIMARY KEY,
	"tedi_id" text NOT NULL,
	"domain_id" text NOT NULL,
	"fact_count" bigint DEFAULT 0 NOT NULL,
	"avg_confidence" double precision DEFAULT 0 NOT NULL,
	"expertise_level" text DEFAULT 'novice' NOT NULL,
	"last_activity_at" text,
	"created_at" text DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
	"updated_at" text DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
);
--> statement-breakpoint
CREATE TABLE "tedi_growth_snapshots" (
	"id" text PRIMARY KEY,
	"tedi_id" text NOT NULL,
	"org_id" text NOT NULL,
	"snapshot_date" text NOT NULL,
	"metrics" jsonb NOT NULL,
	"created_at" text DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
);
--> statement-breakpoint
CREATE TABLE "tedi_memory_documents" (
	"id" text PRIMARY KEY,
	"organization_id" text NOT NULL,
	"tedi_id" text NOT NULL,
	"kind" text NOT NULL,
	"name" text NOT NULL,
	"version" bigint NOT NULL,
	"revision" jsonb,
	"sections" jsonb,
	"description" text,
	"content" text,
	"removed" boolean DEFAULT false NOT NULL,
	"char_count" bigint NOT NULL,
	"author_type" text NOT NULL,
	"author_id" text NOT NULL,
	"change_summary" text NOT NULL,
	"created_at" text DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tedi_muscle_memory" (
	"id" text PRIMARY KEY,
	"tedi_id" text NOT NULL,
	"organization_id" text NOT NULL,
	"kind" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"r2_path" text,
	"usage_count" bigint DEFAULT 0 NOT NULL,
	"success_count" bigint DEFAULT 0 NOT NULL,
	"failure_count" bigint DEFAULT 0 NOT NULL,
	"last_used_at" text,
	"origin" text NOT NULL,
	"version" bigint DEFAULT 1 NOT NULL,
	"source_skill_id" text,
	"code_module" text,
	"allowed_namespaces" jsonb,
	"created_at" text DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
	"updated_at" text DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
);
--> statement-breakpoint
CREATE TABLE "tedi_objectives" (
	"id" text PRIMARY KEY,
	"tedi_id" text NOT NULL,
	"org_id" text NOT NULL,
	"purpose_charter_id" text,
	"title" text NOT NULL,
	"description" text,
	"approach" text,
	"success_criteria" text,
	"constraints" text,
	"type" text DEFAULT 'standing' NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"risk_level" text DEFAULT 'medium' NOT NULL,
	"priority" bigint DEFAULT 0 NOT NULL,
	"linked_domains" jsonb DEFAULT '[]',
	"gate_config" jsonb DEFAULT '{}',
	"budget_config" jsonb DEFAULT '{}',
	"progress" jsonb DEFAULT '{}',
	"created_at" text NOT NULL,
	"updated_at" text,
	"completed_at" text
);
--> statement-breakpoint
CREATE TABLE "tedi_optimization_signals" (
	"id" text PRIMARY KEY,
	"tedi_id" text NOT NULL,
	"organization_id" text NOT NULL,
	"type" text NOT NULL,
	"source" text NOT NULL,
	"domain" text NOT NULL,
	"evidence" jsonb NOT NULL,
	"suggested_action" text NOT NULL,
	"estimated_impact" double precision DEFAULT 0.5 NOT NULL,
	"estimated_effort" double precision DEFAULT 0.5 NOT NULL,
	"roi" double precision DEFAULT 1 NOT NULL,
	"status" text DEFAULT 'detected' NOT NULL,
	"resolved_at" text,
	"created_at" text DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
	"updated_at" text DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
);
--> statement-breakpoint
CREATE TABLE "tedi_plugin_events" (
	"id" text PRIMARY KEY,
	"org_id" text NOT NULL,
	"plugin_id" text NOT NULL,
	"tedi_id" text,
	"event_type" text NOT NULL,
	"payload" jsonb,
	"status" text DEFAULT 'pending',
	"created_at" text DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
	"processed_at" text
);
--> statement-breakpoint
CREATE TABLE "tedi_plugin_installs" (
	"id" text PRIMARY KEY,
	"org_id" text NOT NULL,
	"plugin_id" text NOT NULL,
	"tedi_id" text,
	"config" jsonb,
	"permissions_granted" jsonb,
	"status" text DEFAULT 'installed',
	"installed_at" text DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
	"updated_at" text DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
);
--> statement-breakpoint
CREATE TABLE "tedi_plugins" (
	"id" text PRIMARY KEY,
	"slug" text NOT NULL UNIQUE,
	"name" text NOT NULL,
	"description" text,
	"type" text NOT NULL,
	"version" text NOT NULL,
	"manifest" jsonb,
	"status" text DEFAULT 'draft',
	"author_org_id" text,
	"created_at" text DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
	"updated_at" text DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
);
--> statement-breakpoint
CREATE TABLE "tedi_provisional_outcomes" (
	"id" text PRIMARY KEY,
	"tedi_id" text NOT NULL,
	"org_id" text NOT NULL,
	"conversation_id" text,
	"run_id" text,
	"kind" text NOT NULL,
	"title" text NOT NULL,
	"payload" jsonb NOT NULL,
	"created_at" text NOT NULL,
	"state" text DEFAULT 'provisional' NOT NULL,
	"promotion_approval_request_id" text,
	"promoted_at" text,
	"promoted_by" text,
	"rolled_back_at" text,
	"rolled_back_by" text,
	"rollback_reason" text
);
--> statement-breakpoint
CREATE TABLE "tedi_rationale_records" (
	"id" text PRIMARY KEY,
	"tedi_id" text NOT NULL,
	"org_id" text NOT NULL,
	"action" text NOT NULL,
	"rationale" text NOT NULL,
	"category" text DEFAULT 'custom' NOT NULL,
	"confidence" double precision DEFAULT 0.5 NOT NULL,
	"evidence" jsonb DEFAULT '{}' NOT NULL,
	"outcome" text,
	"outcome_status" text DEFAULT 'pending' NOT NULL,
	"approval_request_id" text,
	"objective_id" text,
	"run_id" text,
	"work_item_id" text,
	"tool_call_refs" jsonb,
	"proof_ref" jsonb,
	"created_at" text NOT NULL,
	"completed_at" text,
	"blame_chain" jsonb
);
--> statement-breakpoint
CREATE TABLE "tedi_role_assignments" (
	"id" text PRIMARY KEY,
	"organization_id" text NOT NULL,
	"tedi_id" text NOT NULL,
	"role_template_id" text,
	"role_key" text NOT NULL,
	"role_name" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"career_stage" text DEFAULT 'shadow' NOT NULL,
	"assigned_at" text NOT NULL,
	"stage_changed_at" text NOT NULL,
	"ended_at" text,
	"revision" bigint DEFAULT 1 NOT NULL,
	"last_decision_id" text,
	"evidence_snapshot_hash" text,
	"metadata" jsonb,
	"created_at" text DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') NOT NULL,
	"updated_at" text DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tedi_runtime_events" (
	"id" text PRIMARY KEY,
	"organization_id" text NOT NULL,
	"tedi_id" text NOT NULL,
	"kind" text NOT NULL,
	"conversation_id" text,
	"run_id" text,
	"message_id" text,
	"tool_call_id" text,
	"approval_request_id" text,
	"artifact_id" text,
	"sequence" bigint,
	"delta" text,
	"payload" jsonb,
	"runtime_backend" text NOT NULL,
	"runtime_external_id" text,
	"runtime_external_url" text,
	"runtime_metadata" jsonb,
	"trace_id" text,
	"created_at" text DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') NOT NULL,
	"terminal_seen" bigint DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tedi_runtime_leases" (
	"id" text PRIMARY KEY,
	"tedi_id" text NOT NULL,
	"name" text NOT NULL,
	"owner" text NOT NULL,
	"expires_at" bigint NOT NULL,
	"created_at" text DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') NOT NULL,
	"updated_at" text DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tedi_runtime_snapshots" (
	"id" text PRIMARY KEY,
	"tedi_id" text NOT NULL,
	"source" text DEFAULT 'tedi-runtime-admin' NOT NULL,
	"runtime_status" text,
	"runtime_version" text,
	"channel_status" jsonb,
	"device_status" jsonb,
	"observed_at" text NOT NULL,
	"created_at" text DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
);
--> statement-breakpoint
CREATE TABLE "tedi_secrets" (
	"id" text PRIMARY KEY,
	"tedi_id" text NOT NULL,
	"name" text NOT NULL,
	"encrypted_value" text NOT NULL,
	"hint" text,
	"key_version" bigint DEFAULT 1 NOT NULL,
	"created_by" text,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tedi_session_states" (
	"id" text PRIMARY KEY,
	"organization_id" text NOT NULL,
	"tedi_id" text NOT NULL,
	"user_id" text NOT NULL,
	"session_key" text NOT NULL,
	"title" text,
	"pinned_at" text,
	"deleted_at" text,
	"last_seen_at" bigint,
	"created_at" text DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') NOT NULL,
	"updated_at" text DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tedi_tasks" (
	"id" text PRIMARY KEY,
	"objective_id" text,
	"tedi_id" text NOT NULL,
	"org_id" text NOT NULL,
	"title" text NOT NULL,
	"kind" text DEFAULT 'general' NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"blocker" text,
	"evidence" jsonb DEFAULT '[]',
	"tooling_used" jsonb DEFAULT '[]',
	"estimated_cost" jsonb DEFAULT '{}',
	"result" text,
	"actual_cost" jsonb DEFAULT '{}',
	"fail_count" bigint DEFAULT 0 NOT NULL,
	"created_at" text NOT NULL,
	"updated_at" text,
	"completed_at" text
);
--> statement-breakpoint
CREATE TABLE "tedi_usage_events" (
	"id" text PRIMARY KEY,
	"tedi_id" text NOT NULL,
	"event_type" text NOT NULL,
	"started_at" text NOT NULL,
	"ended_at" text,
	"duration_ms" bigint,
	"units" double precision,
	"metadata" jsonb,
	"created_at" text DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
);
--> statement-breakpoint
CREATE TABLE "tedis" (
	"id" text PRIMARY KEY,
	"organization_id" text NOT NULL,
	"owner_user_id" text,
	"owner_team" text,
	"justification" text,
	"data_sensitivity" text,
	"scope" text DEFAULT 'personal',
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"display_name" text,
	"descope_user_id" text,
	"descope_mcp_resource_id" text,
	"external_ref" text,
	"tags" jsonb,
	"personality" text,
	"avatar" text,
	"timezone" text,
	"language" text,
	"installed_skills" jsonb,
	"installed_plugins" jsonb,
	"retired_at" text,
	"retired_slug" text,
	"status" text DEFAULT 'provisioning',
	"billing_state" text DEFAULT 'cold',
	"worker_name" text,
	"r2_bucket_name" text,
	"mcp_capability_profile" text DEFAULT 'standard' NOT NULL,
	"tool_policy" jsonb,
	"self_improvement_policy" jsonb,
	"budgets" jsonb,
	"quiet_hours" jsonb,
	"governance_override" jsonb,
	"runtime_profile_id" text,
	"policy_pack_id" text,
	"workspace_template_set_id" text,
	"runtime_overrides" jsonb,
	"channels" jsonb,
	"cron_jobs" jsonb,
	"repo_config" jsonb,
	"runtime_state" text DEFAULT 'standby' NOT NULL,
	"last_activity_at" text,
	"last_heartbeat_at" text,
	"idle_since" text,
	"runtime_status" text DEFAULT 'unknown',
	"last_seen_at" text,
	"last_sync_at" text,
	"last_sync_result" jsonb,
	"last_backup_handles" jsonb,
	"placement_id" text,
	"body_generation_id" text,
	"body_generation_kind" text,
	"body_generation_status" text,
	"body_generation_token_hash" text,
	"body_generation_token_expires_at" text,
	"body_generation_external_id" text,
	"body_generation_heartbeat_at" text,
	"runtime_kind" text DEFAULT 'agent' NOT NULL,
	"isolate_agent_id" text,
	"created_at" text DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
	"updated_at" text DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
);
--> statement-breakpoint
CREATE TABLE "tenant_behavioral_eval_assertion_results" (
	"id" text PRIMARY KEY,
	"case_run_id" text NOT NULL,
	"assertion_index" bigint NOT NULL,
	"type" text NOT NULL,
	"passed" boolean NOT NULL,
	"severity" text DEFAULT 'gate' NOT NULL,
	"disposition" text,
	"detail" text NOT NULL,
	"created_at" text DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tenant_behavioral_eval_case_attempts" (
	"id" text PRIMARY KEY,
	"case_run_id" text NOT NULL,
	"attempt_number" bigint NOT NULL,
	"home_run_id" text NOT NULL,
	"status" text NOT NULL,
	"disposition" text NOT NULL,
	"error" text,
	"event_cursor" bigint NOT NULL,
	"terminal_status" text,
	"selected_route" text,
	"effects_suppressed" boolean,
	"execution_receipt" jsonb,
	"created_at" text DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tenant_behavioral_eval_case_runs" (
	"id" text PRIMARY KEY,
	"run_id" text NOT NULL,
	"case_id" text NOT NULL,
	"home_run_id" text NOT NULL,
	"attempt_number" bigint DEFAULT 1 NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"event_cursor" bigint DEFAULT 0 NOT NULL,
	"saw_closed" boolean DEFAULT false NOT NULL,
	"drained" boolean DEFAULT false NOT NULL,
	"terminal_status" text,
	"selected_route" text,
	"effects_suppressed" boolean,
	"error" text,
	"execution_receipt" jsonb,
	"disposition" text,
	"created_at" text DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') NOT NULL,
	"updated_at" text DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tenant_behavioral_eval_definitions" (
	"id" text PRIMARY KEY,
	"organization_id" text NOT NULL,
	"tedi_id" text NOT NULL,
	"name" text NOT NULL,
	"latest_revision" bigint DEFAULT 1 NOT NULL,
	"created_at" text DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tenant_behavioral_eval_revisions" (
	"id" text PRIMARY KEY,
	"organization_id" text NOT NULL,
	"definition_id" text NOT NULL,
	"revision" bigint NOT NULL,
	"spec" jsonb NOT NULL,
	"created_at" text DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tenant_behavioral_eval_runs" (
	"id" text PRIMARY KEY,
	"organization_id" text NOT NULL,
	"definition_id" text NOT NULL,
	"revision_id" text NOT NULL,
	"tedi_id" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"version" bigint DEFAULT 0 NOT NULL,
	"idempotency_key" text NOT NULL,
	"payload_digest" text NOT NULL,
	"manifest" jsonb,
	"manifest_digest" text,
	"lease_token" text,
	"lease_until" text,
	"passed" boolean,
	"last_advance_error" text,
	"last_advance_error_phase" text,
	"last_advance_error_retryable" boolean,
	"created_at" text DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') NOT NULL,
	"updated_at" text DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tenant_bundles" (
	"id" text PRIMARY KEY,
	"slug" text NOT NULL,
	"version" bigint NOT NULL,
	"r2_prefix" text NOT NULL,
	"main_module" text NOT NULL,
	"etag" text NOT NULL,
	"modules_json" jsonb NOT NULL,
	"source_revision" text,
	"is_active" boolean DEFAULT false NOT NULL,
	"created_at" text DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') NOT NULL,
	"deployed_at" text,
	"deployed_by" text,
	"summary" text
);
--> statement-breakpoint
CREATE TABLE "tenant_provider_identity_preparations" (
	"id" text PRIMARY KEY,
	"organization_id" text NOT NULL,
	"owner_id" text NOT NULL,
	"mount" jsonb NOT NULL,
	"probe_mount" jsonb NOT NULL,
	"profile" jsonb NOT NULL,
	"profile_digest" text NOT NULL,
	"resource_generation_digest" text NOT NULL,
	"expires_at" text NOT NULL,
	"consumed_at" text
);
--> statement-breakpoint
CREATE TABLE "tenant_provider_identity_profiles" (
	"id" text PRIMARY KEY,
	"organization_id" text NOT NULL,
	"mount" jsonb NOT NULL,
	"probe_mount" jsonb NOT NULL,
	"profile" jsonb NOT NULL,
	"safety_attestation" text NOT NULL,
	"profile_digest" text NOT NULL,
	"resource_generation_digest" text NOT NULL,
	"created_by" text NOT NULL,
	"created_at" text NOT NULL,
	"revoked_at" text
);
--> statement-breakpoint
CREATE TABLE "tenant_tool_policies" (
	"id" text PRIMARY KEY,
	"organization_id" text NOT NULL,
	"app_id" text NOT NULL,
	"root_app_id" text,
	"mounted_tool_id" text,
	"tool_row_id" text NOT NULL,
	"tool_digest" text NOT NULL,
	"rule_digest" text NOT NULL,
	"mount_descriptor" jsonb,
	"mount_digest" text,
	"resource_generation_digest" text,
	"predicate" jsonb NOT NULL,
	"effect" jsonb NOT NULL,
	"policy_set" jsonb,
	"created_by" text NOT NULL,
	"created_at" text NOT NULL,
	"revoked_at" text
);
--> statement-breakpoint
CREATE TABLE "tenant_tool_policy_mount_revisions" (
	"sequence" bigint PRIMARY KEY GENERATED BY DEFAULT AS IDENTITY (sequence name "tenant_tool_policy_mount_revisions_sequence_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"organization_id" text NOT NULL,
	"root_app_id" text NOT NULL,
	"mounted_tool_id" text NOT NULL,
	"policy_id" text NOT NULL,
	"source_app_id" text,
	"source_tool_row_id" text,
	"source_tool_id" text,
	"subject_key" text,
	"retired_unknown_sequence" bigint
);
--> statement-breakpoint
CREATE TABLE "tenant_tool_policy_preparations" (
	"id" text PRIMARY KEY,
	"organization_id" text NOT NULL,
	"owner_id" text NOT NULL,
	"descriptor" jsonb NOT NULL,
	"descriptor_digest" text NOT NULL,
	"source_tool_digest" text,
	"example_args_digest" text,
	"resource_generation_digest" text,
	"expires_at" text NOT NULL,
	"consumed_at" text
);
--> statement-breakpoint
CREATE TABLE "tenant_tool_policy_resource_generations" (
	"organization_id" text,
	"resource_kind" text,
	"resource_id" text,
	"generation" bigint DEFAULT 0 NOT NULL,
	CONSTRAINT "tenant_tool_policy_resource_generations_pkey" PRIMARY KEY("organization_id","resource_kind","resource_id")
);
--> statement-breakpoint
CREATE TABLE "token_exchange_grants" (
	"jti" text PRIMARY KEY,
	"parent_jti" text,
	"organization_id" text NOT NULL,
	"subject" text NOT NULL,
	"actor_chain" jsonb NOT NULL,
	"audience" text NOT NULL,
	"endpoint" text NOT NULL,
	"scopes" jsonb NOT NULL,
	"issued_at" bigint NOT NULL,
	"expires_at" bigint NOT NULL,
	"used_at" text,
	"revoked_at" text,
	"revoked_by" text
);
--> statement-breakpoint
CREATE TABLE "trace_bundles" (
	"id" text PRIMARY KEY,
	"tedi_id" text NOT NULL,
	"org_id" text,
	"conversation_id" text,
	"run_id" text NOT NULL,
	"harness_version_id" text NOT NULL,
	"event_ids" jsonb DEFAULT '[]' NOT NULL,
	"rationale_record_ids" jsonb DEFAULT '[]' NOT NULL,
	"artifact_ids" jsonb DEFAULT '[]' NOT NULL,
	"eval_result_id" text,
	"bundle_uri" text,
	"summary" text,
	"outcome" text,
	"metadata" jsonb,
	"created_at" text DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') NOT NULL
);
--> statement-breakpoint
CREATE TABLE "upstream_drift_reports" (
	"id" text PRIMARY KEY,
	"catalog_app_id" text NOT NULL,
	"catalog_app_name" text NOT NULL,
	"added_tools" bigint DEFAULT 0 NOT NULL,
	"removed_tools" bigint DEFAULT 0 NOT NULL,
	"changed_tools" bigint DEFAULT 0 NOT NULL,
	"drifts" jsonb NOT NULL,
	"summary" text NOT NULL,
	"checked_at" text NOT NULL,
	"resolved_at" text
);
--> statement-breakpoint
CREATE TABLE "user_configs" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid(),
	"user_id" text NOT NULL,
	"namespace" text NOT NULL,
	"key" text NOT NULL,
	"value" jsonb NOT NULL,
	"revision" bigint DEFAULT 0 NOT NULL,
	"created_at" text DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
	"updated_at" text DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" text PRIMARY KEY,
	"email" text NOT NULL,
	"name" text,
	"avatar_url" text,
	"profile_revision" bigint DEFAULT 1 NOT NULL,
	"metadata" jsonb,
	"last_login_at" text,
	"created_at" text DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
	"updated_at" text DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
);
--> statement-breakpoint
CREATE TABLE "widget_events" (
	"id" text PRIMARY KEY,
	"organization_id" text NOT NULL,
	"app_id" text NOT NULL,
	"session_id" text NOT NULL,
	"event_type" text NOT NULL,
	"item_id" text,
	"item_position" bigint,
	"widget_key" text,
	"display_mode" text,
	"metadata" jsonb,
	"created_at" text DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
);
--> statement-breakpoint
CREATE TABLE "work_admissions" (
	"id" text PRIMARY KEY,
	"org_id" text NOT NULL,
	"work_item_id" text NOT NULL,
	"work_item_version" bigint NOT NULL,
	"admission_spec_revision" text NOT NULL,
	"executor_type" text NOT NULL,
	"executor_id" text NOT NULL,
	"executor_session_id" text,
	"external_session_key" text,
	"decision" text NOT NULL,
	"rejection_code" text,
	"rejection_reason" text,
	"rejection_key" text,
	"max_cost_micros" bigint,
	"decided_at" text NOT NULL,
	"expires_at" text NOT NULL,
	"created_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "work_agent_sessions" (
	"id" text PRIMARY KEY,
	"organization_id" text NOT NULL,
	"user_id" text NOT NULL,
	"harness" text NOT NULL,
	"session_key" text NOT NULL,
	"label" text DEFAULT '' NOT NULL,
	"telemetry" jsonb,
	"project_id" text,
	"work_item_id" text,
	"state" text NOT NULL,
	"summary" text DEFAULT '' NOT NULL,
	"state_since" text NOT NULL,
	"last_event_at" text NOT NULL,
	"created_at" text DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') NOT NULL,
	"updated_at" text DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') NOT NULL
);
--> statement-breakpoint
CREATE TABLE "work_approval_decisions" (
	"id" text PRIMARY KEY,
	"proposal_id" text NOT NULL,
	"resolved_proposal_version" bigint NOT NULL,
	"decision" text NOT NULL,
	"decider_type" text NOT NULL,
	"decider_id" text NOT NULL,
	"rationale" text NOT NULL,
	"decided_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "work_approval_executions" (
	"proposal_id" text PRIMARY KEY,
	"org_id" text NOT NULL,
	"execution" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "work_approval_proposals" (
	"id" text PRIMARY KEY,
	"org_id" text NOT NULL,
	"work_item_id" text NOT NULL,
	"work_item_version" bigint NOT NULL,
	"authority_key" text NOT NULL,
	"action" text NOT NULL,
	"proposal" jsonb NOT NULL,
	"requester_type" text NOT NULL,
	"requester_id" text NOT NULL,
	"requester_session_id" text,
	"requester_external_session_key" text,
	"approver_type" text NOT NULL,
	"approver_id" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"rationale" text NOT NULL,
	"expires_at" text NOT NULL,
	"resolution_fence" text,
	"created_at" text NOT NULL,
	"resolved_at" text,
	"version" bigint DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "work_attempt_messages" (
	"id" text PRIMARY KEY,
	"org_id" text NOT NULL,
	"work_item_id" text NOT NULL,
	"attempt_id" text NOT NULL,
	"kind" text NOT NULL,
	"body" text DEFAULT '' NOT NULL,
	"sender_type" text NOT NULL,
	"sender_id" text NOT NULL,
	"interrupt" boolean DEFAULT false NOT NULL,
	"created_at" text NOT NULL,
	"delivered_at" text,
	"applied_at" text
);
--> statement-breakpoint
CREATE TABLE "work_attempt_steps" (
	"id" text PRIMARY KEY,
	"org_id" text NOT NULL,
	"work_item_id" text NOT NULL,
	"attempt_id" text NOT NULL,
	"seq" bigint NOT NULL,
	"at" bigint NOT NULL,
	"kind" text NOT NULL,
	"text" text NOT NULL,
	"choices" jsonb
);
--> statement-breakpoint
CREATE TABLE "work_attempts" (
	"id" text PRIMARY KEY,
	"admission_id" text,
	"work_item_id" text NOT NULL,
	"org_id" text NOT NULL,
	"executor_type" text NOT NULL,
	"executor_id" text NOT NULL,
	"executor_session_id" text,
	"external_session_key" text,
	"run_id" text,
	"runtime_state" text DEFAULT 'running' NOT NULL,
	"outcome" text,
	"attempt_number" bigint NOT NULL,
	"started_at" text NOT NULL,
	"heartbeat_at" text NOT NULL,
	"expires_at" text,
	"finished_at" text,
	"summary" text,
	"version" bigint DEFAULT 1 NOT NULL,
	"metadata" jsonb DEFAULT '{}' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "work_budget_envelopes" (
	"id" text PRIMARY KEY,
	"org_id" text NOT NULL,
	"scope_type" text NOT NULL,
	"scope_id" text NOT NULL,
	"limit_micros" bigint NOT NULL,
	"reservation_micros" bigint NOT NULL,
	"currency" text DEFAULT 'USD' NOT NULL,
	"mode" text DEFAULT 'stop' NOT NULL,
	"alerted_percent" bigint DEFAULT 0 NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" text NOT NULL,
	"updated_at" text,
	"version" bigint DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "work_budget_reservations" (
	"id" text PRIMARY KEY,
	"org_id" text NOT NULL,
	"admission_id" text NOT NULL,
	"work_item_id" text NOT NULL,
	"envelope_id" text NOT NULL,
	"envelope_version" bigint NOT NULL,
	"amount_micros" bigint NOT NULL,
	"consumed_micros" bigint,
	"state" text DEFAULT 'active' NOT NULL,
	"reserved_at" text NOT NULL,
	"expires_at" text NOT NULL,
	"settled_at" text,
	"version" bigint DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "work_case_dependencies" (
	"id" text PRIMARY KEY,
	"org_id" text NOT NULL,
	"prerequisite_case_id" text NOT NULL,
	"dependent_case_id" text NOT NULL,
	"created_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "work_case_items" (
	"id" text PRIMARY KEY,
	"org_id" text NOT NULL,
	"case_id" text NOT NULL,
	"work_item_id" text NOT NULL,
	"rationale" text,
	"discovered_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "work_cases" (
	"id" text PRIMARY KEY,
	"org_id" text NOT NULL,
	"project_id" text,
	"objective_id" text,
	"title" text NOT NULL,
	"description" text,
	"kind" text NOT NULL,
	"stage" text DEFAULT 'investigating' NOT NULL,
	"accountable_owner_type" text NOT NULL,
	"accountable_owner_id" text NOT NULL,
	"opened_at" text NOT NULL,
	"target_resolution_at" text,
	"proof_ref" text,
	"metadata" jsonb DEFAULT '{}' NOT NULL,
	"created_at" text NOT NULL,
	"updated_at" text,
	"closed_at" text,
	"version" bigint DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "work_due" (
	"org_id" text,
	"kind" text,
	"object_id" text,
	"due_at" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"lease_until" text DEFAULT '' NOT NULL,
	CONSTRAINT "work_due_pkey" PRIMARY KEY("org_id","kind","object_id")
);
--> statement-breakpoint
CREATE TABLE "work_events" (
	"sequence" bigint PRIMARY KEY GENERATED BY DEFAULT AS IDENTITY (sequence name "work_events_sequence_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"id" text NOT NULL UNIQUE,
	"org_id" text NOT NULL,
	"work_item_id" text NOT NULL,
	"project_id" text,
	"objective_id" text,
	"attempt_id" text,
	"event_type" text NOT NULL,
	"actor_type" text NOT NULL,
	"actor_id" text NOT NULL,
	"actor_session_id" text,
	"payload" jsonb DEFAULT '{}' NOT NULL,
	"occurred_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "work_evidence" (
	"id" text PRIMARY KEY,
	"work_item_id" text NOT NULL,
	"org_id" text NOT NULL,
	"attempt_id" text,
	"claim_key" text NOT NULL,
	"kind" text NOT NULL,
	"uri" text NOT NULL,
	"digest" text,
	"media_type" text,
	"label" text,
	"submitted_by_type" text NOT NULL,
	"submitted_by_id" text NOT NULL,
	"submitted_by_session_id" text,
	"disposition" text DEFAULT 'pending' NOT NULL,
	"reviewed_by_type" text,
	"reviewed_by_id" text,
	"reviewed_by_session_id" text,
	"review_reason" text,
	"submitted_at" text NOT NULL,
	"reviewed_at" text,
	"version" bigint DEFAULT 1 NOT NULL,
	"metadata" jsonb DEFAULT '{}' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "work_evidence_verifications" (
	"id" text PRIMARY KEY,
	"org_id" text NOT NULL,
	"work_item_id" text NOT NULL,
	"evidence_id" text NOT NULL,
	"source" text NOT NULL,
	"verifier_type" text DEFAULT 'system' NOT NULL,
	"verifier_id" text NOT NULL,
	"claimed" jsonb DEFAULT '{}' NOT NULL,
	"observed" jsonb DEFAULT '{}' NOT NULL,
	"matches_claim" boolean NOT NULL,
	"observed_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "work_interaction_attention" (
	"org_id" text,
	"interaction_id" text,
	"kind" text NOT NULL,
	"need" text,
	"asks" double precision,
	"decided_at" text NOT NULL,
	CONSTRAINT "work_interaction_attention_pkey" PRIMARY KEY("org_id","interaction_id")
);
--> statement-breakpoint
CREATE TABLE "work_interaction_card_presentations" (
	"org_id" text,
	"interaction_id" text,
	"person_id" text NOT NULL,
	"request_version" bigint NOT NULL,
	"presentation" jsonb NOT NULL,
	"updated_at" text NOT NULL,
	CONSTRAINT "work_interaction_card_presentations_pkey" PRIMARY KEY("org_id","interaction_id")
);
--> statement-breakpoint
CREATE TABLE "work_interaction_card_revisions" (
	"id" text PRIMARY KEY,
	"org_id" text NOT NULL,
	"request_id" text NOT NULL,
	"revision" bigint NOT NULL,
	"body" text NOT NULL,
	"proposal" jsonb,
	"cause" text NOT NULL,
	"actor_type" text NOT NULL,
	"actor_id" text NOT NULL,
	"actor_session_id" text,
	"instruction" text,
	"response_id" text,
	"field" text,
	"anchors" jsonb,
	"anchors_resolved" jsonb,
	"summary" text,
	"kept_hunks" jsonb,
	"learning_event_id" text,
	"parent_revision" bigint,
	"created_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "work_interaction_decision_history" (
	"org_id" text,
	"interaction_id" text,
	"response_id" text,
	"target_type" text NOT NULL,
	"target_id" text NOT NULL,
	"relation_key" text,
	"responded_at" text NOT NULL,
	CONSTRAINT "work_interaction_decision_history_pkey" PRIMARY KEY("org_id","interaction_id","response_id","relation_key")
);
--> statement-breakpoint
CREATE TABLE "work_interaction_deliveries" (
	"org_id" text,
	"response_id" text,
	"interaction_id" text NOT NULL,
	"delivered_at" text,
	"delivered_via" text,
	"acknowledged_at" text,
	"handoff_to" text,
	"handoff_ref" text,
	"updated_at" text NOT NULL,
	CONSTRAINT "work_interaction_deliveries_pkey" PRIMARY KEY("org_id","response_id")
);
--> statement-breakpoint
CREATE TABLE "work_interaction_reply_drafts" (
	"id" text PRIMARY KEY,
	"org_id" text NOT NULL,
	"interaction_id" text NOT NULL,
	"drafter_type" text NOT NULL,
	"drafter_id" text NOT NULL,
	"body" text NOT NULL,
	"rationale" text NOT NULL,
	"turn_type" text,
	"delivery" text DEFAULT 'review' NOT NULL,
	"gate" jsonb,
	"created_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "work_interaction_responses" (
	"id" text PRIMARY KEY,
	"org_id" text NOT NULL,
	"interaction_id" text NOT NULL,
	"resolved_request_version" bigint NOT NULL,
	"resolution_fence" text NOT NULL,
	"responder_type" text NOT NULL,
	"responder_id" text NOT NULL,
	"responder_session_id" text,
	"responder_external_session_key" text,
	"body" text NOT NULL,
	"response_kind" text NOT NULL,
	"artifact_ref" text,
	"artifact_version" text,
	"artifact_digest" text,
	"resolves_request" boolean DEFAULT false NOT NULL,
	"metadata" jsonb DEFAULT '{}' NOT NULL,
	"responded_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "work_interactions" (
	"id" text PRIMARY KEY,
	"org_id" text NOT NULL,
	"work_item_id" text,
	"case_id" text,
	"project_id" text,
	"kind" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"subject" text NOT NULL,
	"prompt" text NOT NULL,
	"creator_type" text NOT NULL,
	"creator_id" text NOT NULL,
	"creator_session_id" text,
	"creator_external_session_key" text,
	"target_type" text,
	"target_id" text,
	"due_at" text,
	"expires_at" text,
	"resolution_fence" text,
	"created_at" text NOT NULL,
	"resolved_at" text,
	"cancelled_at" text,
	"expired_at" text,
	"version" bigint DEFAULT 1 NOT NULL,
	"source" text,
	"delegated_owner_id" text,
	"metadata" jsonb DEFAULT '{}' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "work_item_comments" (
	"id" text PRIMARY KEY,
	"work_item_id" text NOT NULL,
	"org_id" text NOT NULL,
	"author_type" text NOT NULL,
	"author_id" text,
	"body" text NOT NULL,
	"metadata" jsonb DEFAULT '{}',
	"created_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "work_item_corroborations" (
	"id" text PRIMARY KEY,
	"org_id" text NOT NULL,
	"work_item_id" text NOT NULL,
	"principal_type" text NOT NULL,
	"principal_id" text NOT NULL,
	"session_id" text,
	"evidence_ref" text NOT NULL,
	"stance" text DEFAULT 'corroborates' NOT NULL,
	"body" text NOT NULL,
	"occurred_at" text NOT NULL,
	"created_at" text DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') NOT NULL
);
--> statement-breakpoint
CREATE TABLE "work_item_org_counts" (
	"org_id" text PRIMARY KEY,
	"total" bigint DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "work_item_projections" (
	"id" text PRIMARY KEY,
	"work_item_id" text NOT NULL,
	"org_id" text NOT NULL,
	"provider" text NOT NULL,
	"direction" text DEFAULT 'projection' NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"external_id" text,
	"external_url" text,
	"external_project_id" text,
	"external_section_id" text,
	"last_synced_at" text,
	"last_error" text,
	"sync_cursor" text,
	"provider_state" jsonb DEFAULT '{}',
	"created_at" text NOT NULL,
	"updated_at" text
);
--> statement-breakpoint
CREATE TABLE "work_item_relations" (
	"id" text PRIMARY KEY,
	"org_id" text NOT NULL,
	"from_work_item_id" text NOT NULL,
	"to_work_item_id" text NOT NULL,
	"relation_type" text NOT NULL,
	"metadata" jsonb DEFAULT '{}',
	"created_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "work_item_sources" (
	"id" text PRIMARY KEY,
	"org_id" text NOT NULL,
	"project_id" text,
	"work_item_id" text,
	"provider" text NOT NULL,
	"external_id" text NOT NULL,
	"kind" text DEFAULT 'other' NOT NULL,
	"external_url" text,
	"title" text,
	"content_hash" text,
	"state" text DEFAULT 'current' NOT NULL,
	"last_checked_at" text,
	"last_changed_at" text,
	"missing_since_at" text,
	"tombstoned_at" text,
	"attributed_to" text,
	"metadata" jsonb DEFAULT '{}',
	"created_at" text NOT NULL,
	"updated_at" text
);
--> statement-breakpoint
CREATE TABLE "work_items" (
	"id" text PRIMARY KEY,
	"org_id" text NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"disposition" text DEFAULT 'proposed' NOT NULL,
	"work_kind" text DEFAULT 'other' NOT NULL,
	"risk_level" text DEFAULT 'medium' NOT NULL,
	"acceptance_contract" jsonb,
	"required_capabilities" jsonb DEFAULT '[]' NOT NULL,
	"required_authorities" jsonb DEFAULT '[]' NOT NULL,
	"admission_spec_revision" text DEFAULT 'legacy' NOT NULL,
	"priority" text DEFAULT 'medium' NOT NULL,
	"accountable_owner_type" text,
	"accountable_owner_id" text,
	"steward_type" text,
	"steward_id" text,
	"reviewer_type" text,
	"reviewer_id" text,
	"reviewer_lease_expires_at" text,
	"objective_id" text,
	"work_class" text,
	"purpose_exception_expires_at" text,
	"project_id" text,
	"parent_work_item_id" text,
	"executor_type" text,
	"executor_id" text,
	"dispatch_state" text,
	"delegation_depth" bigint,
	"max_attempts" bigint,
	"root_work_item_id" text,
	"root_goal" text,
	"budget_share_micros" bigint,
	"source_session_key" text,
	"source_intent_id" text,
	"due_date" text,
	"deadline" text,
	"start_at" text,
	"duration_days" bigint,
	"provenance" jsonb DEFAULT '{}',
	"repository_observer" bigint,
	"report" text,
	"observer_woken_at" text,
	"metadata_executor" text,
	"metadata_source" text,
	"delegation_root_id" text,
	"metadata" jsonb DEFAULT '{}',
	"created_at" text NOT NULL,
	"updated_at" text,
	"accepted_at" text,
	"completed_at" text,
	"cancelled_at" text,
	"version" bigint DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "work_project_health_judgments" (
	"id" text PRIMARY KEY,
	"org_id" text NOT NULL,
	"project_id" text NOT NULL,
	"status" text NOT NULL,
	"summary" text NOT NULL,
	"target_at" text,
	"actor_type" text NOT NULL,
	"actor_id" text NOT NULL,
	"actor_session_id" text,
	"actor_external_session_key" text,
	"metadata" jsonb DEFAULT '{}' NOT NULL,
	"observed_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "work_resource_pools" (
	"id" text PRIMARY KEY,
	"org_id" text NOT NULL,
	"resource_key" text NOT NULL,
	"allocation_mode" text NOT NULL,
	"capacity" bigint NOT NULL,
	"owner_ref" text,
	"enabled" boolean DEFAULT true NOT NULL,
	"metadata" jsonb DEFAULT '{}' NOT NULL,
	"created_at" text NOT NULL,
	"updated_at" text,
	"version" bigint DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "work_resource_requirements" (
	"org_id" text,
	"work_item_id" text,
	"resource_key" text,
	"quantity" bigint DEFAULT 1 NOT NULL,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL,
	CONSTRAINT "work_resource_requirements_pkey" PRIMARY KEY("org_id","work_item_id","resource_key")
);
--> statement-breakpoint
CREATE TABLE "work_resource_reservations" (
	"id" text PRIMARY KEY,
	"org_id" text NOT NULL,
	"admission_id" text NOT NULL,
	"work_item_id" text NOT NULL,
	"pool_id" text NOT NULL,
	"pool_version" bigint NOT NULL,
	"resource_key" text NOT NULL,
	"quantity" bigint NOT NULL,
	"state" text DEFAULT 'active' NOT NULL,
	"reserved_at" text NOT NULL,
	"expires_at" text NOT NULL,
	"settled_at" text,
	"version" bigint DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workflow_run_ledger" (
	"id" text PRIMARY KEY,
	"workflow_type" text NOT NULL,
	"workflow_id" text NOT NULL,
	"trigger" text NOT NULL,
	"target" text,
	"status" text NOT NULL,
	"started_at" text NOT NULL,
	"completed_at" text,
	"total_count" bigint DEFAULT 0,
	"success_count" bigint DEFAULT 0,
	"error_count" bigint DEFAULT 0,
	"output" jsonb,
	"error" text
);
--> statement-breakpoint
CREATE TABLE "workspace_activity" (
	"id" text PRIMARY KEY,
	"organization_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"seq" bigint NOT NULL,
	"kind" text NOT NULL,
	"entity_id" text NOT NULL,
	"revision" bigint NOT NULL,
	"actor_kind" text NOT NULL,
	"actor_id" text NOT NULL,
	"change_record_id" text NOT NULL,
	"title" text,
	"summary" text,
	"occurred_at" text NOT NULL,
	"applied_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workspace_feed_cursors" (
	"workspace_id" text PRIMARY KEY,
	"organization_id" text NOT NULL,
	"last_seq" bigint NOT NULL,
	"applied_at" text NOT NULL,
	"last_event_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workspace_feed_ledger" (
	"id" text PRIMARY KEY,
	"organization_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"seq" bigint NOT NULL,
	"kind" text NOT NULL,
	"entity_id" text NOT NULL,
	"revision" bigint NOT NULL,
	"actor_kind" text NOT NULL,
	"actor_id" text NOT NULL,
	"change_record_id" text NOT NULL,
	"summary" text DEFAULT '{}' NOT NULL,
	"at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workspace_output_index" (
	"id" text PRIMARY KEY,
	"organization_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"output_id" text NOT NULL,
	"revision" bigint NOT NULL,
	"revision_id" text NOT NULL,
	"is_current" bigint DEFAULT 0 NOT NULL,
	"output_kind" text NOT NULL,
	"title" text NOT NULL,
	"status" text NOT NULL,
	"search_text" text DEFAULT '' NOT NULL,
	"note" text,
	"output_created_by_kind" text NOT NULL,
	"output_created_by_id" text NOT NULL,
	"output_created_at" text NOT NULL,
	"revision_created_by_kind" text NOT NULL,
	"revision_created_by_id" text NOT NULL,
	"revision_created_at" text NOT NULL,
	"skill_run_id" text,
	"skill_id" text,
	"access_envelope" text,
	"content_sha256" text,
	"content_bytes" bigint,
	"body_r2_key" text,
	"updated_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workspace_template_sets" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid(),
	"organization_id" text,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"description" text,
	"scope" text DEFAULT 'organization' NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"version" bigint DEFAULT 1 NOT NULL,
	"supersedes_revision_id" text,
	"rollback_of_revision_id" text,
	"change_summary" text,
	"published_at" text,
	"published_by" text,
	"templates" jsonb NOT NULL,
	"created_at" text DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
	"updated_at" text DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
);
--> statement-breakpoint
CREATE TABLE "workspace_work_links" (
	"id" text PRIMARY KEY,
	"organization_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"output_id" text NOT NULL,
	"work_item_id" text NOT NULL,
	"revision" bigint NOT NULL,
	"linked_at" text NOT NULL,
	"unlinked_at" text
);
--> statement-breakpoint
CREATE TABLE "workstation_leases" (
	"id" text PRIMARY KEY,
	"workstation_id" text NOT NULL,
	"profile_id" text NOT NULL,
	"org_id" text,
	"work_item_id" text,
	"attempt_id" text,
	"repository_path" text,
	"repo_start_sha" text,
	"prepared_start_sha" text,
	"kernel_run_id" text,
	"trace_bundle_id" text,
	"status" text NOT NULL,
	"capabilities" jsonb DEFAULT '[]' NOT NULL,
	"adapters" jsonb DEFAULT '[]' NOT NULL,
	"approval_ids" jsonb DEFAULT '[]' NOT NULL,
	"artifact_refs" jsonb DEFAULT '[]' NOT NULL,
	"metadata" jsonb DEFAULT '{}' NOT NULL,
	"body_generation_id" text,
	"body_generation_kind" text,
	"body_generation_status" text,
	"body_generation_token_hash" text,
	"body_generation_token_expires_at" text,
	"body_generation_external_id" text,
	"body_generation_heartbeat_at" text,
	"body_instance_id" text,
	"body_instance_name" text,
	"body_instance_observed_at" text,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL,
	"expires_at" text,
	"released_at" text
);
--> statement-breakpoint
CREATE TABLE "workstation_participants" (
	"id" text PRIMARY KEY,
	"lease_id" text NOT NULL,
	"org_id" text,
	"tedi_id" text NOT NULL,
	"slug" text,
	"role" text NOT NULL,
	"status" text NOT NULL,
	"permission_scopes" jsonb DEFAULT '[]' NOT NULL,
	"joined_at" text NOT NULL,
	"left_at" text,
	"metadata" jsonb DEFAULT '{}' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workstation_sessions" (
	"id" text PRIMARY KEY,
	"lease_id" text NOT NULL,
	"org_id" text,
	"participant_id" text,
	"kind" text NOT NULL,
	"adapter" text NOT NULL,
	"status" text NOT NULL,
	"session_key" text,
	"external_id" text,
	"artifact_refs" jsonb DEFAULT '[]' NOT NULL,
	"started_at" text NOT NULL,
	"ended_at" text,
	"metadata" jsonb DEFAULT '{}' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workstations" (
	"id" text PRIMARY KEY,
	"profile_id" text NOT NULL,
	"org_id" text,
	"status" text NOT NULL,
	"seats" jsonb DEFAULT '[]' NOT NULL,
	"capabilities" jsonb DEFAULT '[]' NOT NULL,
	"adapters" jsonb DEFAULT '[]' NOT NULL,
	"artifact_refs" jsonb DEFAULT '[]' NOT NULL,
	"metadata" jsonb DEFAULT '{}' NOT NULL,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_agent_session_events_org_user_source" ON "agent_session_events" ("organization_id","user_id","source_key");--> statement-breakpoint
CREATE INDEX "idx_agent_session_events_org_user_status" ON "agent_session_events" ("organization_id","user_id","status","source_at");--> statement-breakpoint
CREATE INDEX "idx_agent_session_events_org_user_source_at" ON "agent_session_events" ("organization_id","user_id","source_at","id");--> statement-breakpoint
CREATE INDEX "idx_agent_session_events_session_order" ON "agent_session_events" ("organization_id","user_id","harness","session_key","status","source_at","id");--> statement-breakpoint
CREATE INDEX "idx_agent_session_events_session_kind_order" ON "agent_session_events" ("organization_id","user_id","harness","session_key","kind","source_at","source_key");--> statement-breakpoint
CREATE INDEX "idx_agent_session_events_pending_heads" ON "agent_session_events" ("organization_id","user_id","status","harness","session_key","source_at","id");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_agent_session_requests_org_user_source" ON "agent_session_requests" ("organization_id","user_id","source_key");--> statement-breakpoint
CREATE INDEX "idx_agent_session_requests_org_user_status" ON "agent_session_requests" ("organization_id","user_id","status","source_at");--> statement-breakpoint
CREATE INDEX "idx_agent_session_requests_org_user_session" ON "agent_session_requests" ("organization_id","user_id","harness","session_key");--> statement-breakpoint
CREATE INDEX "idx_api_key_org" ON "api_keys" ("organization_id");--> statement-breakpoint
CREATE INDEX "idx_api_key_status" ON "api_keys" ("status");--> statement-breakpoint
CREATE INDEX "idx_api_key_env" ON "api_keys" ("environment");--> statement-breakpoint
CREATE INDEX "idx_api_key_hash" ON "api_keys" ("key_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "adapter_binding_unique" ON "app_adapter_secret_bindings" ("adapter_id","config_path");--> statement-breakpoint
CREATE INDEX "idx_adapter_bindings_app" ON "app_adapter_secret_bindings" ("app_id");--> statement-breakpoint
CREATE INDEX "idx_adapter_bindings_secret" ON "app_adapter_secret_bindings" ("secret_id","secret_scope");--> statement-breakpoint
CREATE INDEX "idx_app_adapters_type" ON "app_adapters" ("adapter_type");--> statement-breakpoint
CREATE INDEX "idx_app_adapters_enabled" ON "app_adapters" ("app_id","enabled");--> statement-breakpoint
CREATE INDEX "app_catalog_name_idx" ON "app_catalog" ("name");--> statement-breakpoint
CREATE INDEX "app_catalog_vendor_key_idx" ON "app_catalog" ("vendor_key");--> statement-breakpoint
CREATE INDEX "app_catalog_slug_idx" ON "app_catalog" ("slug");--> statement-breakpoint
CREATE INDEX "app_catalog_connector_type_idx" ON "app_catalog" ("connector_type");--> statement-breakpoint
CREATE INDEX "app_catalog_category_idx" ON "app_catalog" ("category");--> statement-breakpoint
CREATE INDEX "app_catalog_distribution_channel_idx" ON "app_catalog" ("distribution_channel");--> statement-breakpoint
CREATE INDEX "app_catalog_status_idx" ON "app_catalog" ("status");--> statement-breakpoint
CREATE INDEX "app_catalog_is_discoverable_idx" ON "app_catalog" ("is_discoverable");--> statement-breakpoint
CREATE INDEX "app_catalog_developer_type_idx" ON "app_catalog" ("developer_type");--> statement-breakpoint
CREATE INDEX "app_catalog_health_status_idx" ON "app_catalog" ("health_status");--> statement-breakpoint
CREATE INDEX "app_catalog_mcp_endpoint_idx" ON "app_catalog" ("mcp_endpoint_normalized");--> statement-breakpoint
CREATE INDEX "app_catalog_tool_source_idx" ON "app_catalog" ("tool_source");--> statement-breakpoint
CREATE UNIQUE INDEX "app_catalog_mcp_endpoint_hash_unique" ON "app_catalog" ("mcp_endpoint_hash");--> statement-breakpoint
CREATE INDEX "app_catalog_category_total_idx" ON "app_catalog_category_totals" ("total","category");--> statement-breakpoint
CREATE INDEX "idx_catalog_changes_app" ON "app_catalog_changes" ("catalog_app_id","detected_at");--> statement-breakpoint
CREATE INDEX "idx_catalog_changes_type" ON "app_catalog_changes" ("change_type","detected_at");--> statement-breakpoint
CREATE INDEX "health_history_checked_idx" ON "app_catalog_health_history" ("checked_at");--> statement-breakpoint
CREATE INDEX "health_history_app_checked_idx" ON "app_catalog_health_history" ("catalog_app_id","checked_at");--> statement-breakpoint
CREATE UNIQUE INDEX "mcp_prompts_app_name_unique" ON "app_catalog_mcp_prompts" ("catalog_app_id","prompt_name");--> statement-breakpoint
CREATE UNIQUE INDEX "mcp_resource_tpl_app_name_unique" ON "app_catalog_mcp_resource_templates" ("catalog_app_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "mcp_resources_app_uri_unique" ON "app_catalog_mcp_resources" ("catalog_app_id","uri");--> statement-breakpoint
CREATE UNIQUE INDEX "mcp_skills_app_uri_unique" ON "app_catalog_mcp_skills" ("catalog_app_id","skill_uri");--> statement-breakpoint
CREATE INDEX "mcp_skills_app_last_seen_idx" ON "app_catalog_mcp_skills" ("catalog_app_id","last_seen_at");--> statement-breakpoint
CREATE UNIQUE INDEX "mcp_tools_app_name_unique" ON "app_catalog_mcp_tools" ("catalog_app_id","tool_name");--> statement-breakpoint
CREATE INDEX "mcp_tools_last_tested_idx" ON "app_catalog_mcp_tools" ("last_tested_at");--> statement-breakpoint
CREATE INDEX "mcp_tools_test_count_idx" ON "app_catalog_mcp_tools" ("test_count");--> statement-breakpoint
CREATE INDEX "mcp_tools_schema_source_idx" ON "app_catalog_mcp_tools" ("schema_source");--> statement-breakpoint
CREATE UNIQUE INDEX "store_listings_source_id_unique" ON "app_catalog_store_listings" ("source","source_app_id");--> statement-breakpoint
CREATE INDEX "store_listings_catalog_app_idx" ON "app_catalog_store_listings" ("catalog_app_id");--> statement-breakpoint
CREATE INDEX "tool_tests_tested_at_idx" ON "app_catalog_tool_tests" ("tested_at");--> statement-breakpoint
CREATE INDEX "tool_tests_success_idx" ON "app_catalog_tool_tests" ("success");--> statement-breakpoint
CREATE INDEX "tool_tests_app_tool_tested_idx" ON "app_catalog_tool_tests" ("catalog_app_id","tool_name","tested_at");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_app_config_versions_app_version" ON "app_config_versions" ("app_id","version");--> statement-breakpoint
CREATE INDEX "idx_app_config_versions_status" ON "app_config_versions" ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "app_secret_unique" ON "app_secrets" ("app_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_app_tool_unique" ON "app_tools" ("app_id","tool_id");--> statement-breakpoint
CREATE INDEX "idx_app_tools_app_enabled" ON "app_tools" ("app_id","enabled");--> statement-breakpoint
CREATE INDEX "idx_app_tools_app_review" ON "app_tools" ("app_id","review_state");--> statement-breakpoint
CREATE INDEX "idx_app_tools_app_sort" ON "app_tools" ("app_id","sort_order");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_app_org_slug" ON "apps" ("organization_id","slug");--> statement-breakpoint
CREATE INDEX "idx_app_slug" ON "apps" ("slug");--> statement-breakpoint
CREATE INDEX "idx_app_domain" ON "apps" ("custom_mcp_domain");--> statement-breakpoint
CREATE INDEX "idx_app_primary_domain" ON "apps" ("primary_domain");--> statement-breakpoint
CREATE INDEX "idx_app_discovery" ON "apps" ("discovery_status");--> statement-breakpoint
CREATE INDEX "idx_app_visibility" ON "apps" ("visibility");--> statement-breakpoint
CREATE INDEX "idx_app_active_config_version" ON "apps" ("active_config_version_id");--> statement-breakpoint
CREATE INDEX "idx_app_source" ON "apps" ("source_app_id");--> statement-breakpoint
CREATE INDEX "idx_app_catalog" ON "apps" ("catalog_app_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_artifact_redaction_candidates_child" ON "artifact_redaction_candidates" ("child_artifact_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_artifact_redaction_candidates_idempotency" ON "artifact_redaction_candidates" ("organization_id","parent_artifact_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "idx_artifact_redaction_candidates_parent" ON "artifact_redaction_candidates" ("organization_id","parent_artifact_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_artifact_release_reviews_previous" ON "artifact_release_reviews" ("candidate_id","previous_review_id");--> statement-breakpoint
CREATE INDEX "idx_artifact_release_reviews_candidate" ON "artifact_release_reviews" ("organization_id","candidate_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_artifact_release_reviews_target" ON "artifact_release_reviews" ("target_approval_id");--> statement-breakpoint
CREATE INDEX "idx_audit_events_org_timestamp" ON "audit_events" ("organization_id","timestamp");--> statement-breakpoint
CREATE INDEX "idx_audit_events_trace_id_timestamp" ON "audit_events" ("trace_id","timestamp");--> statement-breakpoint
CREATE INDEX "idx_audit_events_timestamp" ON "audit_events" ("timestamp");--> statement-breakpoint
CREATE INDEX "idx_audit_events_action_timestamp" ON "audit_events" ("action","timestamp");--> statement-breakpoint
CREATE INDEX "idx_audit_events_resource" ON "audit_events" ("organization_id","resource_type","resource_id","timestamp");--> statement-breakpoint
CREATE UNIQUE INDEX "audit_metadata_refs_org_kind_value_idx" ON "audit_metadata_refs" ("organization_id","kind","value");--> statement-breakpoint
CREATE INDEX "idx_billing_account_status" ON "billing_accounts" ("status","period_end");--> statement-breakpoint
CREATE INDEX "idx_billing_account_stripe_environment" ON "billing_accounts" ("stripe_environment");--> statement-breakpoint
CREATE INDEX "idx_billing_account_plan" ON "billing_accounts" ("plan_version_id");--> statement-breakpoint
CREATE INDEX "idx_cloudflare_daily_cost_day" ON "billing_cloudflare_daily_costs" ("day");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_billing_cost_rollups_grain" ON "billing_cost_rollups" ("organization_id","day","tedi_id","session_type","source","model","provider","provider_resource","provider_base_url","deployment","cost_basis","success");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_billing_credit_consumption_source" ON "billing_credit_consumptions" ("kind","source_ref");--> statement-breakpoint
CREATE INDEX "idx_billing_credit_consumption_org_period" ON "billing_credit_consumptions" ("organization_id","period_start");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_billing_credit_meter_outbox_idempotency" ON "billing_credit_meter_outbox" ("idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_billing_credit_meter_outbox_consumption" ON "billing_credit_meter_outbox" ("consumption_id");--> statement-breakpoint
CREATE INDEX "idx_billing_credit_meter_outbox_retry" ON "billing_credit_meter_outbox" ("stripe_environment","status","next_attempt_at","lease_expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_billing_credit_notice_delivery" ON "billing_credit_notice_deliveries" ("organization_id","period_start","threshold","channel","recipient_user_id");--> statement-breakpoint
CREATE INDEX "idx_billing_credit_notice_delivery_retry" ON "billing_credit_notice_deliveries" ("status","next_attempt_at");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_billing_credit_top_up_idempotency" ON "billing_credit_top_ups" ("idempotency_key");--> statement-breakpoint
CREATE INDEX "idx_billing_credit_top_up_org_expiry" ON "billing_credit_top_ups" ("organization_id","expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_billing_gateway_reconciliation" ON "billing_gateway_reconciliations" ("day","gateway_id","provider","model");--> statement-breakpoint
CREATE INDEX "idx_billing_gateway_reconciliation_status" ON "billing_gateway_reconciliations" ("status","day");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_historical_decision_revision" ON "billing_historical_decisions" ("organization_id","tedi_id","revision");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_historical_decision_operation" ON "billing_historical_decisions" ("organization_id","tedi_id","operation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_historical_exposure_operation" ON "billing_historical_exposures" ("organization_id","tedi_id","operation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_historical_exposure_source" ON "billing_historical_exposures" ("organization_id","tedi_id","object_id","generation","snapshot_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_billing_inference_policy_subject" ON "billing_inference_policies" ("organization_id","scope","subject_key");--> statement-breakpoint
CREATE INDEX "idx_billing_inference_policy_tedi" ON "billing_inference_policies" ("tedi_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_billing_plan_key_version" ON "billing_plan_versions" ("plan_key","version");--> statement-breakpoint
CREATE INDEX "idx_billing_plan_active" ON "billing_plan_versions" ("plan_key","status","effective_at");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_provider_cost_evidence_idempotency" ON "billing_provider_cost_evidence_versions" ("idempotency_digest");--> statement-breakpoint
CREATE INDEX "idx_provider_cost_evidence_org_time_source" ON "billing_provider_cost_evidence_versions" ("original_org_id","occurred_at","source_call_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_billing_provider_reconciliation" ON "billing_provider_reconciliations" ("provider","provider_resource","period_start","period_end");--> statement-breakpoint
CREATE INDEX "idx_billing_provider_reconciliation_status" ON "billing_provider_reconciliations" ("status","period_end");--> statement-breakpoint
CREATE INDEX "idx_billing_provider_usage_org_occurred" ON "billing_provider_usage" ("organization_id","occurred_at");--> statement-breakpoint
CREATE INDEX "idx_billing_provider_usage_kind_occurred" ON "billing_provider_usage" ("usage_kind","occurred_at");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_billing_service_credit_control" ON "billing_service_credit_controls" ("organization_id","service_key");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_billing_service_reservation_idempotency" ON "billing_service_credit_reservations" ("idempotency_key");--> statement-breakpoint
CREATE INDEX "idx_billing_service_reservation_org_status" ON "billing_service_credit_reservations" ("organization_id","service_key","status","expires_at");--> statement-breakpoint
CREATE INDEX "idx_billing_service_reservation_tedi_period" ON "billing_service_credit_reservations" ("tedi_id","service_key","period_start");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_billing_service_rate_card_version" ON "billing_service_rate_cards" ("service_key","operation_key","version");--> statement-breakpoint
CREATE INDEX "idx_billing_service_rate_card_active" ON "billing_service_rate_cards" ("service_key","operation_key","status","effective_at");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_billing_top_up_pack_version" ON "billing_top_up_pack_versions" ("pack_key","version","stripe_environment");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_billing_top_up_pack_lookup" ON "billing_top_up_pack_versions" ("stripe_environment","stripe_lookup_key");--> statement-breakpoint
CREATE INDEX "idx_billing_top_up_pack_active" ON "billing_top_up_pack_versions" ("stripe_environment","status","effective_at");--> statement-breakpoint
CREATE INDEX "idx_billing_charge_org_occurred" ON "billing_usage_charges" ("organization_id","occurred_at");--> statement-breakpoint
CREATE INDEX "idx_billing_charge_reservation" ON "billing_usage_charges" ("reservation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_billing_usage_period" ON "billing_usage_periods" ("organization_id","period_start","period_end");--> statement-breakpoint
CREATE INDEX "idx_billing_usage_period_end" ON "billing_usage_periods" ("period_end");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_billing_usage_quarantine_gateway_log" ON "billing_usage_quarantines" ("gateway_log_id");--> statement-breakpoint
CREATE INDEX "idx_billing_usage_quarantine_reason_created" ON "billing_usage_quarantines" ("reason","created_at");--> statement-breakpoint
CREATE INDEX "idx_billing_usage_quarantine_created" ON "billing_usage_quarantines" ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_billing_reservation_idempotency" ON "billing_usage_reservations" ("idempotency_key");--> statement-breakpoint
CREATE INDEX "idx_billing_reservation_org_status" ON "billing_usage_reservations" ("organization_id","status","expires_at");--> statement-breakpoint
CREATE INDEX "idx_billing_reservation_status_expiry" ON "billing_usage_reservations" ("status","expires_at");--> statement-breakpoint
CREATE INDEX "idx_billing_reservation_plan" ON "billing_usage_reservations" ("plan_version_id");--> statement-breakpoint
CREATE INDEX "idx_billing_reservation_tedi_created" ON "billing_usage_reservations" ("tedi_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_billing_reservation_org_created" ON "billing_usage_reservations" ("organization_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_billing_reservation_org_run" ON "billing_usage_reservations" ("organization_id","run_id");--> statement-breakpoint
CREATE INDEX "calendar_coordinator_workspace_idx" ON "calendar_coordinator_configurations" ("organization_id","workspace_id");--> statement-breakpoint
CREATE UNIQUE INDEX "calendar_coordinator_mirror_unique" ON "calendar_coordinator_mirrors" ("configuration_id","source_key","destination_key");--> statement-breakpoint
CREATE UNIQUE INDEX "calendar_coordinator_action_unique" ON "calendar_coordinator_mutations" ("configuration_id","action_id");--> statement-breakpoint
CREATE INDEX "calendar_coordinator_plan_config_idx" ON "calendar_coordinator_plans" ("organization_id","configuration_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_capability_links_target" ON "capability_links" ("capability_id","entity_kind","entity_id");--> statement-breakpoint
CREATE INDEX "idx_capability_links_org_entity" ON "capability_links" ("organization_id","entity_kind","entity_id");--> statement-breakpoint
CREATE INDEX "idx_chat_dispatch_idem_tedi_convo" ON "chat_dispatch_idempotency" ("tedi_id","conversation_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_chat_dispatch_idem_run" ON "chat_dispatch_idempotency" ("tedi_id","run_id");--> statement-breakpoint
CREATE INDEX "idx_chat_dispatch_idem_created" ON "chat_dispatch_idempotency" ("created_at");--> statement-breakpoint
CREATE INDEX "cms_deprovision_operations_org_idx" ON "cms_deprovision_operations" ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "cms_domain_claims_hostname_unique" ON "cms_domain_claims" ("hostname");--> statement-breakpoint
CREATE UNIQUE INDEX "cms_domain_claims_provider_unique" ON "cms_domain_claims" ("provider_hostname_id");--> statement-breakpoint
CREATE INDEX "cms_domain_claims_site_idx" ON "cms_domain_claims" ("organization_id","site_id");--> statement-breakpoint
CREATE INDEX "cms_restore_permits_site_slug_idx" ON "cms_restore_permits" ("site_id","slug");--> statement-breakpoint
CREATE UNIQUE INDEX "cms_sites_slug_unique" ON "cms_sites" ("slug");--> statement-breakpoint
CREATE INDEX "cms_sites_org_idx" ON "cms_sites" ("organization_id");--> statement-breakpoint
CREATE INDEX "cms_sites_status_idx" ON "cms_sites" ("status");--> statement-breakpoint
CREATE INDEX "cms_sites_mcp_app_idx" ON "cms_sites" ("mcp_app_id");--> statement-breakpoint
CREATE INDEX "cms_sites_authoring_app_idx" ON "cms_sites" ("authoring_app_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_competency_attestation_principal" ON "competency_observation_attestations" ("observation_id","principal_type","principal_id");--> statement-breakpoint
CREATE INDEX "idx_competency_attestation_org_principal" ON "competency_observation_attestations" ("organization_id","principal_type","principal_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_competency_observation_org_client" ON "competency_observations" ("organization_id","client_observation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_competency_observation_episode_activity" ON "competency_observations" ("organization_id","tedi_id","execution_opportunity_id","activity_id","rubric_version","harness_version");--> statement-breakpoint
CREATE INDEX "idx_competency_observation_subject" ON "competency_observations" ("tedi_id","activity_id","occurred_at");--> statement-breakpoint
CREATE UNIQUE INDEX "connection_connect_tickets_hash_idx" ON "connection_connect_tickets" ("ticket_hash");--> statement-breakpoint
CREATE INDEX "connection_connect_tickets_user_idx" ON "connection_connect_tickets" ("organization_id","user_id");--> statement-breakpoint
CREATE INDEX "connection_instances_org_provider_idx" ON "connection_instances" ("organization_id","provider_id");--> statement-breakpoint
CREATE INDEX "connection_instances_owner_provider_idx" ON "connection_instances" ("owner_user_id","provider_id");--> statement-breakpoint
CREATE INDEX "connection_provider_ownership_org_idx" ON "connection_provider_ownership" ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "connection_providers_descope_app_id_unique" ON "connection_providers" ("descope_app_id");--> statement-breakpoint
CREATE INDEX "connection_providers_category_idx" ON "connection_providers" ("category");--> statement-breakpoint
CREATE INDEX "connection_providers_type_idx" ON "connection_providers" ("type");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_content_source_documents_app_url" ON "content_source_documents" ("app_id","canonical_url");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_content_source_documents_app_object" ON "content_source_documents" ("app_id","object_key");--> statement-breakpoint
CREATE INDEX "idx_content_source_documents_source_id" ON "content_source_documents" ("source_id");--> statement-breakpoint
CREATE INDEX "idx_content_source_documents_projection" ON "content_source_documents" ("ai_search_status");--> statement-breakpoint
CREATE INDEX "idx_content_sources_app_id" ON "content_sources" ("app_id");--> statement-breakpoint
CREATE INDEX "idx_content_sources_status" ON "content_sources" ("last_ingest_status");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_decision_edges_org_from_kind_to" ON "decision_edges" ("org_id","from_id","from_kind","kind","to_id","to_kind");--> statement-breakpoint
CREATE INDEX "idx_decision_edges_org_to_kind" ON "decision_edges" ("org_id","to_id","kind");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_decision_exposure_org_actor_event" ON "decision_exposures" ("organization_id","actor_id","id");--> statement-breakpoint
CREATE INDEX "idx_decision_exposure_org_actor_card" ON "decision_exposures" ("organization_id","actor_id","card_id");--> statement-breakpoint
CREATE INDEX "idx_decision_exposure_expiry" ON "decision_exposures" ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_decision_label_org_actor_receipt_window" ON "decision_outcome_labels" ("organization_id","actor_id","card_id","window","id");--> statement-breakpoint
CREATE INDEX "idx_decision_label_org_class" ON "decision_outcome_labels" ("organization_id","actor_id","class_id","window");--> statement-breakpoint
CREATE INDEX "idx_decision_label_due" ON "decision_outcome_labels" ("window","due_at");--> statement-breakpoint
CREATE INDEX "idx_decision_label_expiry" ON "decision_outcome_labels" ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_delegation_value_claim_observation" ON "delegation_value_claims" ("organization_id","observation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_delegation_value_claim_event" ON "delegation_value_claims" ("organization_id","value_event_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_delegation_value_claim_evidence" ON "delegation_value_claims" ("organization_id","value_evidence_ref");--> statement-breakpoint
CREATE INDEX "idx_delegation_value_claim_tedi" ON "delegation_value_claims" ("organization_id","tedi_id","created_at");--> statement-breakpoint
CREATE INDEX "docs_builds_site_created_idx" ON "docs_builds" ("site_id","created_at");--> statement-breakpoint
CREATE INDEX "docs_builds_status_idx" ON "docs_builds" ("status");--> statement-breakpoint
CREATE INDEX "docs_changes_site_created_idx" ON "docs_changes" ("site_id","created_at");--> statement-breakpoint
CREATE INDEX "docs_changes_status_idx" ON "docs_changes" ("status");--> statement-breakpoint
CREATE INDEX "docs_releases_site_created_idx" ON "docs_releases" ("site_id","created_at");--> statement-breakpoint
CREATE INDEX "docs_releases_build_idx" ON "docs_releases" ("build_id");--> statement-breakpoint
CREATE UNIQUE INDEX "docs_sites_slug_unique" ON "docs_sites" ("slug");--> statement-breakpoint
CREATE INDEX "docs_sites_org_slug_idx" ON "docs_sites" ("org_slug");--> statement-breakpoint
CREATE INDEX "idx_embedded_contact_email" ON "embedded_contact_users" ("installation_id","email");--> statement-breakpoint
CREATE INDEX "idx_entrustable_activity_risk" ON "entrustable_activities" ("risk_level");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_external_agent_attribution" ON "external_agent_attributions" ("organization_id","target_type","target_id","role","principal_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_external_agent_attribution_org_id" ON "external_agent_attributions" ("organization_id","id");--> statement-breakpoint
CREATE INDEX "idx_external_agent_attribution_occurred" ON "external_agent_attributions" ("occurred_at");--> statement-breakpoint
CREATE INDEX "idx_external_agent_attribution_work_item" ON "external_agent_attributions" ("organization_id","work_item_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_external_agent_mcp_client_record" ON "external_agent_mcp_credentials" ("client_record_id");--> statement-breakpoint
CREATE INDEX "idx_external_agent_mcp_credential_session" ON "external_agent_mcp_credentials" ("organization_id","principal_id","session_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_external_agent_mcp_issuance_lease_target" ON "external_agent_mcp_issuance_leases" ("organization_id","principal_id","session_id","mcp_server_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_external_agent_principal_org_id" ON "external_agent_principals" ("organization_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_external_agent_principal_key" ON "external_agent_principals" ("organization_id","key");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_external_agent_credential_binding" ON "external_agent_principals" ("organization_id","credential_binding_type","credential_binding_id");--> statement-breakpoint
CREATE INDEX "idx_external_agent_principal_status" ON "external_agent_principals" ("organization_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_external_agent_review_principal_execution" ON "external_agent_review_evidence" ("organization_id","execution_attribution_id","reviewer_principal_type","reviewer_principal_id");--> statement-breakpoint
CREATE INDEX "idx_external_agent_review_subject_context" ON "external_agent_review_evidence" ("organization_id","subject_principal_id","task_family","repository_key","risk_level");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_external_agent_session_org_principal_id" ON "external_agent_sessions" ("organization_id","principal_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_external_agent_session_key" ON "external_agent_sessions" ("organization_id","harness","external_session_key");--> statement-breakpoint
CREATE INDEX "idx_external_agent_session_principal" ON "external_agent_sessions" ("organization_id","principal_id","status");--> statement-breakpoint
CREATE INDEX "idx_external_agent_session_principal_started" ON "external_agent_sessions" ("organization_id","principal_id","started_at","id");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_external_agent_workload_issuer_jti" ON "external_agent_workload_token_uses" ("issuer","jti");--> statement-breakpoint
CREATE INDEX "idx_external_agent_workload_principal" ON "external_agent_workload_token_uses" ("organization_id","principal_id","consumed_at");--> statement-breakpoint
CREATE INDEX "idx_graph_projection_consumers_lease" ON "graph_projection_consumers" ("lease_until");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_graph_projection_maintenance_org_idempotency" ON "graph_projection_maintenance_runs" ("runtime_environment","organization_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "idx_graph_projection_maintenance_org_status" ON "graph_projection_maintenance_runs" ("runtime_environment","organization_id","status","updated_at");--> statement-breakpoint
CREATE INDEX "idx_graph_projection_maintenance_status_updated" ON "graph_projection_maintenance_runs" ("runtime_environment","status","updated_at","id");--> statement-breakpoint
CREATE INDEX "idx_graph_projection_outbox_org_sequence" ON "graph_projection_outbox" ("organization_id","sequence");--> statement-breakpoint
CREATE INDEX "idx_graph_projection_outbox_entity" ON "graph_projection_outbox" ("organization_id","entity_kind","entity_id","sequence");--> statement-breakpoint
CREATE INDEX "idx_graph_projection_outbox_retry" ON "graph_projection_outbox" ("poisoned_at","next_attempt_at","sequence");--> statement-breakpoint
CREATE INDEX "idx_graph_projection_readiness_state" ON "graph_projection_readiness" ("state","updated_at");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_graph_benchmark_case_key" ON "graph_retrieval_benchmark_cases" ("suite_id","case_key");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_graph_benchmark_case_checksum" ON "graph_retrieval_benchmark_cases" ("suite_id","checksum");--> statement-breakpoint
CREATE INDEX "idx_graph_benchmark_case_suite" ON "graph_retrieval_benchmark_cases" ("organization_id","suite_id","case_key");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_graph_benchmark_result_case" ON "graph_retrieval_benchmark_results" ("run_id","case_id");--> statement-breakpoint
CREATE INDEX "idx_graph_benchmark_result_run" ON "graph_retrieval_benchmark_results" ("organization_id","run_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_graph_benchmark_run_pair_variant" ON "graph_retrieval_benchmark_runs" ("organization_id","paired_run_key","variant");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_graph_benchmark_run_org_id" ON "graph_retrieval_benchmark_runs" ("organization_id","id");--> statement-breakpoint
CREATE INDEX "idx_graph_benchmark_run_suite" ON "graph_retrieval_benchmark_runs" ("organization_id","suite_id","status","started_at");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_graph_benchmark_suite_version" ON "graph_retrieval_benchmark_suites" ("organization_id","name","version");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_graph_benchmark_suite_org_id" ON "graph_retrieval_benchmark_suites" ("organization_id","id");--> statement-breakpoint
CREATE INDEX "idx_graph_benchmark_suite_status" ON "graph_retrieval_benchmark_suites" ("organization_id","status","split");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_graph_benchmark_graduation_pair" ON "graph_retrieval_graduation_evaluations" ("baseline_run_id","graph_run_id","evaluator_version");--> statement-breakpoint
CREATE INDEX "idx_graph_benchmark_graduation_suite" ON "graph_retrieval_graduation_evaluations" ("organization_id","suite_id","evaluated_at");--> statement-breakpoint
CREATE INDEX "idx_harness_eval_results_version" ON "harness_eval_results" ("harness_version_id");--> statement-breakpoint
CREATE INDEX "idx_harness_eval_results_tedi_created" ON "harness_eval_results" ("tedi_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_harness_eval_results_org" ON "harness_eval_results" ("org_id");--> statement-breakpoint
CREATE INDEX "idx_harness_eval_results_created" ON "harness_eval_results" ("created_at");--> statement-breakpoint
CREATE INDEX "idx_harness_eval_runs_version" ON "harness_eval_runs" ("harness_version_id");--> statement-breakpoint
CREATE INDEX "idx_harness_eval_runs_tedi_created" ON "harness_eval_runs" ("tedi_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_harness_eval_runs_org" ON "harness_eval_runs" ("org_id");--> statement-breakpoint
CREATE INDEX "idx_harness_eval_runs_created" ON "harness_eval_runs" ("created_at");--> statement-breakpoint
CREATE INDEX "idx_harness_subject_eval_results_subject" ON "harness_subject_eval_results" ("subject_kind","subject_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_harness_subject_eval_results_org" ON "harness_subject_eval_results" ("org_id");--> statement-breakpoint
CREATE INDEX "idx_harness_subject_eval_results_version" ON "harness_subject_eval_results" ("harness_version_id");--> statement-breakpoint
CREATE INDEX "idx_harness_subject_eval_results_created" ON "harness_subject_eval_results" ("created_at");--> statement-breakpoint
CREATE INDEX "idx_harness_subject_eval_runs_subject" ON "harness_subject_eval_runs" ("subject_kind","subject_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_harness_subject_eval_runs_org" ON "harness_subject_eval_runs" ("org_id");--> statement-breakpoint
CREATE INDEX "idx_harness_subject_eval_runs_version" ON "harness_subject_eval_runs" ("harness_version_id");--> statement-breakpoint
CREATE INDEX "idx_harness_subject_eval_runs_created" ON "harness_subject_eval_runs" ("created_at");--> statement-breakpoint
CREATE INDEX "idx_harness_subject_trace_bundles_subject_run" ON "harness_subject_trace_bundles" ("subject_kind","subject_id","run_id");--> statement-breakpoint
CREATE INDEX "idx_harness_subject_trace_bundles_subject_created" ON "harness_subject_trace_bundles" ("subject_kind","subject_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_harness_subject_trace_bundles_version" ON "harness_subject_trace_bundles" ("harness_version_id");--> statement-breakpoint
CREATE INDEX "idx_harness_subject_trace_bundles_org" ON "harness_subject_trace_bundles" ("org_id");--> statement-breakpoint
CREATE INDEX "idx_harness_subject_trace_bundles_tedi" ON "harness_subject_trace_bundles" ("tedi_id");--> statement-breakpoint
CREATE INDEX "idx_harness_subject_versions_subject_created" ON "harness_subject_versions" ("subject_kind","subject_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_harness_subject_versions_subject_status" ON "harness_subject_versions" ("subject_kind","subject_id","promotion_status");--> statement-breakpoint
CREATE INDEX "idx_harness_subject_versions_org" ON "harness_subject_versions" ("org_id");--> statement-breakpoint
CREATE INDEX "idx_harness_subject_versions_tedi" ON "harness_subject_versions" ("tedi_id");--> statement-breakpoint
CREATE INDEX "idx_harness_versions_tedi_created" ON "harness_versions" ("tedi_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_harness_versions_tedi_status" ON "harness_versions" ("tedi_id","promotion_status");--> statement-breakpoint
CREATE INDEX "idx_harness_versions_org" ON "harness_versions" ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_items_app_url" ON "items" ("app_id","url");--> statement-breakpoint
CREATE INDEX "idx_items_vertical" ON "items" ("vertical");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_kernel_conversation_artifact_pin_name" ON "kernel_conversation_artifact_pins" ("organization_id","conversation_id","replay_name");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_kernel_conversation_artifact_pin_revision" ON "kernel_conversation_artifact_pins" ("organization_id","conversation_id","artifact_id","revision_digest");--> statement-breakpoint
CREATE INDEX "idx_kernel_conversation_artifact_pin_conversation" ON "kernel_conversation_artifact_pins" ("organization_id","conversation_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_kernel_conversation_capability_name" ON "kernel_conversation_capabilities" ("organization_id","conversation_id","replay_name");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_kernel_conversation_capability_target" ON "kernel_conversation_capabilities" ("organization_id","conversation_id","capability_id");--> statement-breakpoint
CREATE INDEX "idx_kernel_conversation_capability_conversation" ON "kernel_conversation_capabilities" ("organization_id","conversation_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_kernel_conversation_grants_user" ON "kernel_conversation_grants" ("organization_id","grantee_descope_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_kernel_conversation_grants_unique_user" ON "kernel_conversation_grants" ("organization_id","conversation_id","grantee_descope_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_kernel_conversation_session_policy_scope" ON "kernel_conversation_session_policies" ("organization_id","conversation_id","scope_key");--> statement-breakpoint
CREATE INDEX "idx_kernel_conversation_session_policy_conversation" ON "kernel_conversation_session_policies" ("organization_id","conversation_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_kernel_conversations_org_conversation" ON "kernel_conversations" ("organization_id","conversation_id");--> statement-breakpoint
CREATE INDEX "idx_kernel_conversations_org_last_message" ON "kernel_conversations" ("organization_id","last_message_at","conversation_id");--> statement-breakpoint
CREATE INDEX "idx_kernel_conversations_org_workspace_last_message" ON "kernel_conversations" ("organization_id","workspace_id","last_message_at","conversation_id");--> statement-breakpoint
CREATE INDEX "idx_kernel_home_approval_mirrors_child" ON "kernel_home_approval_mirrors" ("organization_id","parent_conversation_id","child_run_id");--> statement-breakpoint
CREATE UNIQUE INDEX "kernel_request_events_version_unique" ON "kernel_request_events" ("request_id","version");--> statement-breakpoint
CREATE INDEX "kernel_request_events_created_idx" ON "kernel_request_events" ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "kernel_requests_source_unique" ON "kernel_requests" ("organization_id","owner_user_id","source_kind","source_id");--> statement-breakpoint
CREATE INDEX "kernel_requests_due_idx" ON "kernel_requests" ("organization_id","next_due_at");--> statement-breakpoint
CREATE INDEX "kernel_requests_updated_idx" ON "kernel_requests" ("organization_id","updated_at");--> statement-breakpoint
CREATE INDEX "idx_kernel_runtime_events_created" ON "kernel_runtime_events" ("created_at");--> statement-breakpoint
CREATE INDEX "idx_kernel_runtime_events_org_created" ON "kernel_runtime_events" ("organization_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_kernel_runtime_events_conversation_created" ON "kernel_runtime_events" ("organization_id","conversation_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_kernel_runtime_events_conversation_run_created" ON "kernel_runtime_events" ("organization_id","conversation_id","run_id","created_at","id");--> statement-breakpoint
CREATE INDEX "idx_kernel_runtime_events_run_created" ON "kernel_runtime_events" ("organization_id","run_id","created_at","id");--> statement-breakpoint
CREATE INDEX "idx_kernel_runtime_events_delegated_tedi" ON "kernel_runtime_events" ("delegated_tedi_id");--> statement-breakpoint
CREATE INDEX "idx_kernel_runtime_runs_work_item" ON "kernel_runtime_runs" ("organization_id","work_item_id","updated_at");--> statement-breakpoint
CREATE INDEX "idx_kernel_runtime_runs_target_tedi" ON "kernel_runtime_runs" ("organization_id","status","target_tedi_id","updated_at");--> statement-breakpoint
CREATE INDEX "idx_kernel_runtime_runs_conversation_updated" ON "kernel_runtime_runs" ("organization_id","conversation_id","updated_at");--> statement-breakpoint
CREATE INDEX "idx_kernel_runtime_runs_status_updated" ON "kernel_runtime_runs" ("organization_id","status","updated_at");--> statement-breakpoint
CREATE INDEX "idx_kernel_runtime_runs_child" ON "kernel_runtime_runs" ("delegated_tedi_id","child_run_id");--> statement-breakpoint
CREATE INDEX "idx_kernel_runtime_runs_org_child" ON "kernel_runtime_runs" ("organization_id","child_run_id");--> statement-breakpoint
CREATE INDEX "idx_kernel_runtime_runs_org_output_revision" ON "kernel_runtime_runs" ("organization_id","output_revision_id");--> statement-breakpoint
CREATE INDEX "idx_kernel_runtime_runs_org_updated" ON "kernel_runtime_runs" ("organization_id","updated_at");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_kernel_tool_results_object_key" ON "kernel_tool_results" ("object_key");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_kernel_tool_results_source" ON "kernel_tool_results" ("organization_id","source_kind","source_id");--> statement-breakpoint
CREATE INDEX "idx_kernel_tool_results_conversation_active" ON "kernel_tool_results" ("organization_id","conversation_id","evicted_at","created_at","id");--> statement-breakpoint
CREATE INDEX "idx_kernel_tool_results_cleanup" ON "kernel_tool_results" ("evicted_at","expires_at","id");--> statement-breakpoint
CREATE INDEX "idx_kernel_tool_results_digest" ON "kernel_tool_results" ("organization_id","conversation_id","sha256");--> statement-breakpoint
CREATE INDEX "idx_kernel_wake_queue_org_acked" ON "kernel_wake_queue" ("organization_id","acked_at","queued_at");--> statement-breakpoint
CREATE INDEX "idx_kernel_wake_queue_conversation" ON "kernel_wake_queue" ("organization_id","parent_conversation_id","acked_at");--> statement-breakpoint
CREATE INDEX "idx_knowledge_entries_tedi" ON "knowledge_entries" ("tedi_id");--> statement-breakpoint
CREATE INDEX "idx_knowledge_entries_domain" ON "knowledge_entries" ("domain_id");--> statement-breakpoint
CREATE INDEX "idx_knowledge_entries_type" ON "knowledge_entries" ("entry_type");--> statement-breakpoint
CREATE INDEX "idx_knowledge_entries_visibility" ON "knowledge_entries" ("visibility");--> statement-breakpoint
CREATE INDEX "idx_knowledge_entries_org_domain" ON "knowledge_entries" ("organization_id","domain_id");--> statement-breakpoint
CREATE INDEX "idx_knowledge_entries_supersedes" ON "knowledge_entries" ("supersedes_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_learning_attr_org_client_event" ON "learning_feedback_attributions" ("organization_id","client_attribution_id","feedback_event_id");--> statement-breakpoint
CREATE INDEX "idx_learning_attr_subject" ON "learning_feedback_attributions" ("organization_id","subject_kind","subject_id");--> statement-breakpoint
CREATE INDEX "idx_learning_attr_event" ON "learning_feedback_attributions" ("feedback_event_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_learning_measure_org_client" ON "learning_feedback_measurements" ("organization_id","client_measurement_id");--> statement-breakpoint
CREATE INDEX "idx_learning_measure_attr_window" ON "learning_feedback_measurements" ("attribution_id","window_kind","window_end");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_learning_proposal_org_client" ON "learning_improvement_proposals" ("organization_id","client_proposal_id");--> statement-breakpoint
CREATE INDEX "idx_learning_proposal_org_status_updated" ON "learning_improvement_proposals" ("organization_id","status","updated_at");--> statement-breakpoint
CREATE INDEX "idx_learning_proposal_tedi_issue" ON "learning_improvement_proposals" ("tedi_id","issue_key");--> statement-breakpoint
CREATE INDEX "idx_learning_proposal_subject" ON "learning_improvement_proposals" ("organization_id","subject_kind","subject_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_learning_event_org_client" ON "learning_interaction_events" ("organization_id","client_event_id");--> statement-breakpoint
CREATE INDEX "idx_learning_event_org_occurred" ON "learning_interaction_events" ("organization_id","occurred_at");--> statement-breakpoint
CREATE INDEX "idx_learning_event_tedi_occurred" ON "learning_interaction_events" ("tedi_id","occurred_at");--> statement-breakpoint
CREATE INDEX "idx_learning_event_target_occurred" ON "learning_interaction_events" ("organization_id","scope_kind","scope_id","target_type","target_id","occurred_at");--> statement-breakpoint
CREATE INDEX "idx_learning_event_issue" ON "learning_interaction_events" ("organization_id","issue_key");--> statement-breakpoint
CREATE INDEX "idx_learning_interaction_events_created" ON "learning_interaction_events" ("created_at");--> statement-breakpoint
CREATE INDEX "idx_learning_event_surface_occurred" ON "learning_interaction_events" ("surface","occurred_at");--> statement-breakpoint
CREATE INDEX "idx_learning_event_surface_kind_occurred" ON "learning_interaction_events" ("organization_id","surface","event_kind","occurred_at");--> statement-breakpoint
CREATE INDEX "idx_learning_event_scope_occurred" ON "learning_interaction_events" ("organization_id","scope_kind","scope_id","occurred_at");--> statement-breakpoint
CREATE INDEX "idx_learning_event_scope_surface_occurred" ON "learning_interaction_events" ("organization_id","scope_kind","scope_id","surface","occurred_at");--> statement-breakpoint
CREATE INDEX "machine_provider_probe_results_org_idx" ON "machine_provider_probe_results" ("organization_id","expires_at");--> statement-breakpoint
CREATE INDEX "idx_machine_tool_calls_machine_status" ON "machine_tool_calls" ("org_id","machine_name","status","created_at");--> statement-breakpoint
CREATE INDEX "idx_mcp_event_subscriptions_due" ON "mcp_event_subscriptions" ("status","next_attempt_at");--> statement-breakpoint
CREATE INDEX "idx_mcp_event_subscriptions_org_owner" ON "mcp_event_subscriptions" ("organization_id","owner_subject");--> statement-breakpoint
CREATE INDEX "mcp_inbound_client_attempts_org_seen_idx" ON "mcp_inbound_client_attempts" ("organization_id","last_seen_at");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_mcp_payment_account_target" ON "mcp_payment_accounts" ("organization_id","tedi_id","app_slug","network","asset","public_address");--> statement-breakpoint
CREATE INDEX "idx_mcp_payment_account_tedi" ON "mcp_payment_accounts" ("tedi_id");--> statement-breakpoint
CREATE INDEX "idx_mcp_payment_account_app" ON "mcp_payment_accounts" ("app_slug");--> statement-breakpoint
CREATE INDEX "idx_mcp_payment_account_status" ON "mcp_payment_accounts" ("status");--> statement-breakpoint
CREATE INDEX "idx_mcp_payment_requirement" ON "mcp_payment_events" ("requirement_id");--> statement-breakpoint
CREATE INDEX "idx_mcp_payment_app" ON "mcp_payment_events" ("app_id");--> statement-breakpoint
CREATE INDEX "idx_mcp_payment_org" ON "mcp_payment_events" ("organization_id");--> statement-breakpoint
CREATE INDEX "idx_mcp_payment_tedi" ON "mcp_payment_events" ("tedi_id");--> statement-breakpoint
CREATE INDEX "idx_mcp_payment_tool" ON "mcp_payment_events" ("app_slug","tool_id");--> statement-breakpoint
CREATE INDEX "idx_mcp_payment_status" ON "mcp_payment_events" ("status");--> statement-breakpoint
CREATE INDEX "idx_mcp_payment_created" ON "mcp_payment_events" ("created_at");--> statement-breakpoint
CREATE INDEX "idx_mcp_payment_rationale" ON "mcp_payment_events" ("rationale_record_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_mcp_payment_policy_target" ON "mcp_payment_policies" ("organization_id","tedi_id","app_slug","tool_id","currency","network");--> statement-breakpoint
CREATE INDEX "idx_mcp_payment_policy_tedi" ON "mcp_payment_policies" ("tedi_id");--> statement-breakpoint
CREATE INDEX "idx_mcp_payment_policy_tool" ON "mcp_payment_policies" ("app_slug","tool_id");--> statement-breakpoint
CREATE INDEX "idx_mcp_payment_policy_enabled" ON "mcp_payment_policies" ("enabled");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_mcp_payment_reservation_requirement" ON "mcp_payment_reservations" ("requirement_id");--> statement-breakpoint
CREATE INDEX "idx_mcp_payment_reservation_org" ON "mcp_payment_reservations" ("organization_id");--> statement-breakpoint
CREATE INDEX "idx_mcp_payment_reservation_tedi" ON "mcp_payment_reservations" ("tedi_id");--> statement-breakpoint
CREATE INDEX "idx_mcp_payment_reservation_tool" ON "mcp_payment_reservations" ("app_slug","tool_id");--> statement-breakpoint
CREATE INDEX "idx_mcp_payment_reservation_status" ON "mcp_payment_reservations" ("status");--> statement-breakpoint
CREATE INDEX "idx_mcp_payment_reservation_expires" ON "mcp_payment_reservations" ("expires_at");--> statement-breakpoint
CREATE INDEX "idx_mcp_tasks_task_id" ON "mcp_tasks" ("task_id");--> statement-breakpoint
CREATE INDEX "idx_mcp_tasks_org_app_status" ON "mcp_tasks" ("org_id","app_id","status");--> statement-breakpoint
CREATE INDEX "idx_mcp_tasks_org_subject_user" ON "mcp_tasks" ("org_id","subject_user_id");--> statement-breakpoint
CREATE INDEX "idx_mcp_tasks_expires_at" ON "mcp_tasks" ("expires_at");--> statement-breakpoint
CREATE INDEX "idx_mcp_tasks_workflow_id" ON "mcp_tasks" ("workflow_id");--> statement-breakpoint
CREATE INDEX "idx_mcp_tool_approval_grants_lookup" ON "mcp_tool_approval_grants" ("organization_id","subject_id","tool_id");--> statement-breakpoint
CREATE INDEX "idx_mcp_tool_approval_grants_expiry" ON "mcp_tool_approval_grants" ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_domain_org_name" ON "memory_domains" ("organization_id","name");--> statement-breakpoint
CREATE INDEX "idx_memory_domains_org" ON "memory_domains" ("organization_id");--> statement-breakpoint
CREATE INDEX "idx_memory_domains_parent" ON "memory_domains" ("parent_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_edge" ON "memory_edges" ("source_fact_id","target_fact_id","relation_type");--> statement-breakpoint
CREATE INDEX "idx_memory_edges_source" ON "memory_edges" ("source_fact_id");--> statement-breakpoint
CREATE INDEX "idx_memory_edges_target" ON "memory_edges" ("target_fact_id");--> statement-breakpoint
CREATE INDEX "idx_memory_edges_type" ON "memory_edges" ("relation_type");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_memory_entity_org_id" ON "memory_entities" ("organization_id","id");--> statement-breakpoint
CREATE INDEX "idx_memory_entity_candidate" ON "memory_entities" ("organization_id","entity_type","normalized_name","status");--> statement-breakpoint
CREATE INDEX "idx_memory_entity_merge_target" ON "memory_entities" ("organization_id","merged_into_entity_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_memory_entity_alias" ON "memory_entity_aliases" ("organization_id","entity_id","normalized_form","locale");--> statement-breakpoint
CREATE INDEX "idx_memory_entity_alias_lookup" ON "memory_entity_aliases" ("organization_id","normalized_form","review_status");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_memory_entity_mention_occurrence" ON "memory_entity_mentions" ("organization_id","occurrence_key");--> statement-breakpoint
CREATE INDEX "idx_memory_entity_mention_source_fact" ON "memory_entity_mentions" ("organization_id","source_fact_id");--> statement-breakpoint
CREATE INDEX "idx_memory_entity_mention_candidate" ON "memory_entity_mentions" ("organization_id","proposed_type","normalized_form","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_memory_entity_resolution_proposal" ON "memory_entity_resolution_decisions" ("organization_id","client_proposal_key");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_memory_entity_resolution_rollback" ON "memory_entity_resolution_decisions" ("rollback_of_decision_id");--> statement-breakpoint
CREATE INDEX "idx_memory_entity_resolution_mention" ON "memory_entity_resolution_decisions" ("organization_id","mention_id","proposed_at");--> statement-breakpoint
CREATE INDEX "idx_memory_entity_resolution_status" ON "memory_entity_resolution_decisions" ("organization_id","status","proposed_at");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_memory_entity_head_org_mention" ON "memory_entity_resolution_heads" ("organization_id","mention_id");--> statement-breakpoint
CREATE INDEX "idx_memory_entity_head_current" ON "memory_entity_resolution_heads" ("organization_id","current_entity_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_memory_entity_resolution_decision" ON "memory_entity_resolutions" ("decision_id");--> statement-breakpoint
CREATE INDEX "idx_memory_entity_resolution_entity" ON "memory_entity_resolutions" ("organization_id","entity_id","status");--> statement-breakpoint
CREATE INDEX "idx_memory_entity_resolution_temporal" ON "memory_entity_resolutions" ("organization_id","mention_id","valid_from","valid_to");--> statement-breakpoint
CREATE INDEX "idx_memory_fact_citations_org_cited" ON "memory_fact_citations" ("organization_id","cited_fact_id");--> statement-breakpoint
CREATE INDEX "idx_memory_facts_priority_rank" ON "memory_facts" ("organization_id","priority","archived_at","confidence","last_accessed_at");--> statement-breakpoint
CREATE INDEX "idx_memory_facts_domain" ON "memory_facts" ("domain_id");--> statement-breakpoint
CREATE INDEX "idx_memory_facts_type" ON "memory_facts" ("fact_type");--> statement-breakpoint
CREATE INDEX "idx_memory_facts_source" ON "memory_facts" ("source");--> statement-breakpoint
CREATE INDEX "idx_memory_facts_org_source_id" ON "memory_facts" ("organization_id","source","id");--> statement-breakpoint
CREATE INDEX "idx_memory_facts_org_type_rank" ON "memory_facts" ("organization_id","fact_type","archived_at","valid_to","confidence","last_accessed_at","created_at");--> statement-breakpoint
CREATE INDEX "idx_memory_facts_org_live_rank" ON "memory_facts" ("organization_id","archived_at","valid_to","confidence","last_accessed_at","created_at");--> statement-breakpoint
CREATE INDEX "idx_memory_facts_status" ON "memory_facts" ("status");--> statement-breakpoint
CREATE INDEX "idx_memory_facts_org_domain_live" ON "memory_facts" ("organization_id","domain_id","archived_at","valid_to","created_at");--> statement-breakpoint
CREATE INDEX "idx_memory_facts_topic_key" ON "memory_facts" ("organization_id","topic_key");--> statement-breakpoint
CREATE INDEX "idx_memory_facts_flywheel_created" ON "memory_facts" ("organization_id","tedi_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_memory_facts_flywheel_accessed" ON "memory_facts" ("organization_id","last_accessed_at");--> statement-breakpoint
CREATE INDEX "idx_memory_facts_flywheel_updated" ON "memory_facts" ("organization_id","updated_at");--> statement-breakpoint
CREATE INDEX "idx_memory_facts_visibility_policy_updated" ON "memory_facts" ("organization_id","visibility","review_status","use_policy","updated_at");--> statement-breakpoint
CREATE INDEX "memory_facts_tedi_domain_idx" ON "memory_facts" ("tedi_id","domain_id");--> statement-breakpoint
CREATE INDEX "idx_oidc_sessions_expiry" ON "oidc_sessions" ("expires_at");--> statement-breakpoint
CREATE INDEX "idx_ops_alert_state_status" ON "ops_alert_state" ("status");--> statement-breakpoint
CREATE INDEX "idx_org_capabilities_parent" ON "org_capabilities" ("parent_id");--> statement-breakpoint
CREATE INDEX "idx_org_capabilities_org_status" ON "org_capabilities" ("organization_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_org_capabilities_org_slug" ON "org_capabilities" ("organization_id","slug");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_org_member" ON "organization_members" ("organization_id","descope_user_id");--> statement-breakpoint
CREATE INDEX "idx_org_members_canonical_user" ON "organization_members" ("user_id");--> statement-breakpoint
CREATE INDEX "idx_org_members_user" ON "organization_members" ("descope_user_id");--> statement-breakpoint
CREATE INDEX "idx_org_members_email" ON "organization_members" ("email");--> statement-breakpoint
CREATE INDEX "idx_org_members_status" ON "organization_members" ("status");--> statement-breakpoint
CREATE INDEX "idx_org_members_role" ON "organization_members" ("role");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_org_purpose_version" ON "organization_purpose_charters" ("org_id","version");--> statement-breakpoint
CREATE INDEX "idx_org_purpose_history" ON "organization_purpose_charters" ("org_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "org_secret_unique" ON "organization_secrets" ("organization_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "organizations_slug_unique" ON "organizations" ("slug");--> statement-breakpoint
CREATE INDEX "idx_org_slug" ON "organizations" ("slug");--> statement-breakpoint
CREATE INDEX "idx_org_descope" ON "organizations" ("descope_tenant_id");--> statement-breakpoint
CREATE INDEX "organizations_type_idx" ON "organizations" ("type");--> statement-breakpoint
CREATE INDEX "os_approval_rules_org_kind_idx" ON "os_approval_rules" ("organization_id","action_kind");--> statement-breakpoint
CREATE UNIQUE INDEX "os_blueprint_revisions_blueprint_revision_unique" ON "os_blueprint_revisions" ("blueprint_id","revision");--> statement-breakpoint
CREATE INDEX "os_blueprint_revisions_org_idx" ON "os_blueprint_revisions" ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "os_blueprints_org_name_unique" ON "os_blueprints" ("organization_id","name");--> statement-breakpoint
CREATE INDEX "os_collaboration_proposals_document_idx" ON "os_collaboration_proposals" ("organization_id","workspace_id","document_type","document_id","updated_at");--> statement-breakpoint
CREATE INDEX "os_collaboration_proposals_source_idx" ON "os_collaboration_proposals" ("organization_id","source_kind","source_id");--> statement-breakpoint
CREATE INDEX "os_gadget_code_gadget_idx" ON "os_gadget_code" ("gadget_id","created_at");--> statement-breakpoint
CREATE INDEX "os_gadget_code_org_idx" ON "os_gadget_code" ("organization_id");--> statement-breakpoint
CREATE INDEX "idx_os_gadget_executions_completed" ON "os_gadget_executions" ("completed_at");--> statement-breakpoint
CREATE INDEX "idx_os_gadget_executions_run" ON "os_gadget_executions" ("organization_id","run_id","runtime_environment");--> statement-breakpoint
CREATE INDEX "os_gadget_executions_org_workspace_environment_idx" ON "os_gadget_executions" ("organization_id","workspace_id","runtime_environment");--> statement-breakpoint
CREATE INDEX "os_gadget_executions_gadget_idx" ON "os_gadget_executions" ("gadget_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "os_gadget_revisions_gadget_revision_unique" ON "os_gadget_revisions" ("gadget_id","revision");--> statement-breakpoint
CREATE INDEX "os_gadget_revisions_org_idx" ON "os_gadget_revisions" ("organization_id");--> statement-breakpoint
CREATE INDEX "os_gadget_state_workspace_idx" ON "os_gadget_state" ("organization_id","workspace_id");--> statement-breakpoint
CREATE UNIQUE INDEX "os_gadgets_workspace_name_unique" ON "os_gadgets" ("workspace_id","name");--> statement-breakpoint
CREATE INDEX "os_gadgets_org_status_created_idx" ON "os_gadgets" ("organization_id","status","created_at","id");--> statement-breakpoint
CREATE INDEX "os_gadgets_status_created_idx" ON "os_gadgets" ("status","created_at","id");--> statement-breakpoint
CREATE INDEX "os_gadgets_org_work_status_created_idx" ON "os_gadgets" ("organization_id","has_work_navigation","status","created_at","id");--> statement-breakpoint
CREATE INDEX "os_gadgets_triggers_status_created_idx" ON "os_gadgets" ("has_runtime_triggers","status","created_at","id");--> statement-breakpoint
CREATE INDEX "os_review_batches_share_created_idx" ON "os_review_batches" ("share_link_id","created_at");--> statement-breakpoint
CREATE INDEX "os_review_batches_org_idx" ON "os_review_batches" ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "os_review_feedback_recipient_unique" ON "os_review_feedback" ("batch_id","card_id","reviewer_id");--> statement-breakpoint
CREATE INDEX "os_share_email_codes_link_email_created_idx" ON "os_share_email_codes" ("share_link_id","email","created_at");--> statement-breakpoint
CREATE INDEX "os_share_email_codes_ip_created_idx" ON "os_share_email_codes" ("ip_hash","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "os_share_link_invitees_link_email_unique" ON "os_share_link_invitees" ("share_link_id","email");--> statement-breakpoint
CREATE INDEX "os_share_link_invitees_link_user_idx" ON "os_share_link_invitees" ("share_link_id","user_id");--> statement-breakpoint
CREATE INDEX "os_share_links_org_resource_idx" ON "os_share_links" ("organization_id","resource_id");--> statement-breakpoint
CREATE UNIQUE INDEX "os_share_links_token_hash_unique" ON "os_share_links" ("token_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "os_share_links_public_id_unique" ON "os_share_links" ("public_id");--> statement-breakpoint
CREATE INDEX "os_share_sessions_link_idx" ON "os_share_sessions" ("share_link_id");--> statement-breakpoint
CREATE UNIQUE INDEX "os_share_sessions_token_hash_unique" ON "os_share_sessions" ("session_token_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "os_share_skill_read_grants_slot_unique" ON "os_share_skill_read_grants" ("organization_id","share_link_id","revision_id","slot");--> statement-breakpoint
CREATE UNIQUE INDEX "os_workspace_access_edges_unique" ON "os_workspace_access_edges" ("workspace_id","target_user_id","edge_key");--> statement-breakpoint
CREATE UNIQUE INDEX "os_workspace_collaborators_workspace_user_unique" ON "os_workspace_collaborators" ("workspace_id","user_id");--> statement-breakpoint
CREATE INDEX "os_workspace_collaborators_user_idx" ON "os_workspace_collaborators" ("user_id");--> statement-breakpoint
CREATE INDEX "os_workspace_events_workspace_seq_idx" ON "os_workspace_events" ("workspace_id","seq");--> statement-breakpoint
CREATE INDEX "os_workspace_events_created_idx" ON "os_workspace_events" ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "os_workspace_projects_workspace_project_unique" ON "os_workspace_projects" ("workspace_id","project_id");--> statement-breakpoint
CREATE INDEX "os_workspace_projects_org_project_status_idx" ON "os_workspace_projects" ("organization_id","project_id","status");--> statement-breakpoint
CREATE INDEX "os_workspace_projects_org_workspace_status_idx" ON "os_workspace_projects" ("organization_id","workspace_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "os_workspace_resources_workspace_slot_unique" ON "os_workspace_resources" ("workspace_id","slot");--> statement-breakpoint
CREATE INDEX "os_workspace_resources_org_workspace_idx" ON "os_workspace_resources" ("organization_id","workspace_id","status");--> statement-breakpoint
CREATE INDEX "os_workspace_share_keys_link_idx" ON "os_workspace_share_keys" ("link_id");--> statement-breakpoint
CREATE INDEX "os_workspace_share_links_workspace_idx" ON "os_workspace_share_links" ("workspace_id");--> statement-breakpoint
CREATE INDEX "os_workspace_skill_draft_proposals_target_idx" ON "os_workspace_skill_draft_proposals" ("organization_id","workspace_id","resource_id","created_at");--> statement-breakpoint
CREATE INDEX "os_workspace_summaries_org_idx" ON "os_workspace_summaries" ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "os_workspaces_org_id_unique" ON "os_workspaces" ("organization_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "os_workspaces_org_name_unique" ON "os_workspaces" ("organization_id","name");--> statement-breakpoint
CREATE INDEX "personal_resource_delegations_owner_org_idx" ON "personal_resource_delegations" ("organization_id","owner_user_id");--> statement-breakpoint
CREATE INDEX "personal_resource_delegations_tedi_idx" ON "personal_resource_delegations" ("organization_id","tedi_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_platform_cron_executions_fire" ON "platform_cron_executions" ("schedule_id","scheduled_at");--> statement-breakpoint
CREATE INDEX "idx_platform_cron_executions_status_started" ON "platform_cron_executions" ("status","started_at");--> statement-breakpoint
CREATE INDEX "idx_platform_cron_executions_created" ON "platform_cron_executions" ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_policy_packs_scope_slug_version" ON "policy_packs" ("scope","slug","version");--> statement-breakpoint
CREATE INDEX "idx_policy_packs_org" ON "policy_packs" ("organization_id");--> statement-breakpoint
CREATE INDEX "idx_policy_packs_status" ON "policy_packs" ("status");--> statement-breakpoint
CREATE INDEX "idx_policy_packs_target" ON "policy_packs" ("target");--> statement-breakpoint
CREATE INDEX "idx_policy_packs_family" ON "policy_packs" ("scope","slug","version");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_principal_identity_external" ON "principal_identities" ("provider","issuer","subject");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_principal_identity_canonical" ON "principal_identities" ("principal_type","principal_id","provider","issuer","subject");--> statement-breakpoint
CREATE INDEX "idx_principal_identity_principal" ON "principal_identities" ("principal_type","principal_id","status");--> statement-breakpoint
CREATE INDEX "idx_principal_identity_org" ON "principal_identities" ("organization_id","principal_type","status");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_projects_org_id" ON "projects" ("org_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_projects_org_key" ON "projects" ("org_id","key");--> statement-breakpoint
CREATE INDEX "idx_projects_status_id" ON "projects" ("status","id");--> statement-breakpoint
CREATE INDEX "idx_projects_org_status_id" ON "projects" ("org_id","status","id");--> statement-breakpoint
CREATE INDEX "idx_projects_org_objective_status" ON "projects" ("org_id","objective_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_promotion_decision_observation" ON "promotion_decision_observations" ("decision_id","observation_id");--> statement-breakpoint
CREATE INDEX "idx_promotion_decision_observation_org" ON "promotion_decision_observations" ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_promotion_decision_org_client" ON "promotion_decisions" ("organization_id","client_proposal_id");--> statement-breakpoint
CREATE INDEX "idx_promotion_decision_subject_status" ON "promotion_decisions" ("tedi_id","status","created_at");--> statement-breakpoint
CREATE INDEX "idx_promotion_decision_org_kind" ON "promotion_decisions" ("organization_id","kind","created_at");--> statement-breakpoint
CREATE INDEX "provider_event_channels_subscription_idx" ON "provider_event_channels" ("subscription_id");--> statement-breakpoint
CREATE INDEX "provider_event_deliveries_pending_idx" ON "provider_event_deliveries" ("status","created_at");--> statement-breakpoint
CREATE INDEX "provider_event_subscriptions_org_idx" ON "provider_event_subscriptions" ("organization_id");--> statement-breakpoint
CREATE INDEX "provider_event_subscriptions_due_idx" ON "provider_event_subscriptions" ("next_reconcile_at");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_provider_execution_admission" ON "provider_execution_attempts" ("organization_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "idx_provider_execution_authorized" ON "provider_execution_attempts" ("authorized_at");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_provider_installation_tenant" ON "provider_installations" ("provider_organization_id","provider_app_id","external_tenant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_provider_installation_credential_tenant" ON "provider_installations" ("provider_api_key_id","external_tenant_id");--> statement-breakpoint
CREATE INDEX "idx_provider_installation_customer" ON "provider_installations" ("customer_organization_id");--> statement-breakpoint
CREATE INDEX "idx_provider_installation_tedi" ON "provider_installations" ("primary_tedi_id");--> statement-breakpoint
CREATE INDEX "idx_provider_model_rate_lookup" ON "provider_model_rate_versions" ("provider","model_id","deployment_scope","effective_from");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_provider_model_rate_correction" ON "provider_model_rate_versions" ("supersedes_rate_version_id");--> statement-breakpoint
CREATE INDEX "provider_probe_receipts_org_idx" ON "provider_probe_receipts" ("organization_id","expires_at");--> statement-breakpoint
CREATE INDEX "provider_probe_results_org_idx" ON "provider_probe_results" ("organization_id","expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "residency_provider_version" ON "residency_provider_versions" ("member_key","revision");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_role_templates_org_key" ON "role_templates" ("org_id","key");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_runtime_profiles_scope_slug_version" ON "runtime_profiles" ("scope","slug","version");--> statement-breakpoint
CREATE INDEX "idx_runtime_profiles_org" ON "runtime_profiles" ("organization_id");--> statement-breakpoint
CREATE INDEX "idx_runtime_profiles_status" ON "runtime_profiles" ("status");--> statement-breakpoint
CREATE INDEX "idx_runtime_profiles_family" ON "runtime_profiles" ("scope","slug","version");--> statement-breakpoint
CREATE INDEX "idx_runtime_submission_attempts_submission" ON "runtime_submission_attempts" ("submission_id","attempt_no");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_runtime_submission_attempts_no" ON "runtime_submission_attempts" ("submission_id","attempt_no");--> statement-breakpoint
CREATE INDEX "idx_runtime_submissions_org_created" ON "runtime_submissions" ("organization_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_runtime_submissions_subject" ON "runtime_submissions" ("organization_id","subject_kind","subject_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_runtime_submissions_run" ON "runtime_submissions" ("organization_id","run_id");--> statement-breakpoint
CREATE INDEX "idx_runtime_submissions_status_updated" ON "runtime_submissions" ("organization_id","status","updated_at");--> statement-breakpoint
CREATE INDEX "idx_runtime_submissions_idempotency" ON "runtime_submissions" ("organization_id","idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_runtime_submissions_delivery" ON "runtime_submissions" ("organization_id","source_provider","source_delivery_id");--> statement-breakpoint
CREATE INDEX "idx_runtime_submissions_created" ON "runtime_submissions" ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_site_reconciliation_findings_identity" ON "site_reconciliation_findings" ("organization_id","site_id","code","first_detected_at");--> statement-breakpoint
CREATE INDEX "idx_site_reconciliation_findings_open" ON "site_reconciliation_findings" ("organization_id","resolved_at","last_detected_at");--> statement-breakpoint
CREATE INDEX "idx_site_reconciliation_findings_run" ON "site_reconciliation_findings" ("run_id");--> statement-breakpoint
CREATE INDEX "idx_site_reconciliation_runs_org_completed" ON "site_reconciliation_runs" ("organization_id","completed_at");--> statement-breakpoint
CREATE INDEX "idx_site_reconciliation_runs_completed" ON "site_reconciliation_runs" ("completed_at");--> statement-breakpoint
CREATE INDEX "idx_skill_entries_tedi" ON "skill_entries" ("tedi_id");--> statement-breakpoint
CREATE INDEX "idx_skill_entries_domain" ON "skill_entries" ("domain_id");--> statement-breakpoint
CREATE INDEX "idx_skill_entries_visibility" ON "skill_entries" ("visibility");--> statement-breakpoint
CREATE INDEX "idx_skill_entries_org_domain" ON "skill_entries" ("organization_id","domain_id");--> statement-breakpoint
CREATE INDEX "idx_skill_entries_supersedes" ON "skill_entries" ("supersedes_id");--> statement-breakpoint
CREATE INDEX "idx_skill_entries_source_skill" ON "skill_entries" ("source_skill_id");--> statement-breakpoint
CREATE INDEX "idx_skill_entries_app" ON "skill_entries" ("app_id");--> statement-breakpoint
CREATE INDEX "idx_skill_entries_org_app" ON "skill_entries" ("organization_id","app_id");--> statement-breakpoint
CREATE INDEX "idx_skill_entries_org_folder" ON "skill_entries" ("organization_id","folder_path");--> statement-breakpoint
CREATE INDEX "idx_skill_entries_org_visibility" ON "skill_entries" ("organization_id","visibility");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_skill_entries_org_slug" ON "skill_entries" ("organization_id","slug");--> statement-breakpoint
CREATE INDEX "idx_skill_entries_lifecycle" ON "skill_entries" ("lifecycle_state");--> statement-breakpoint
CREATE INDEX "idx_skill_entries_pace_layer" ON "skill_entries" ("pace_layer");--> statement-breakpoint
CREATE INDEX "idx_skill_entries_org_updated" ON "skill_entries" ("organization_id","updated_at","success_count","id");--> statement-breakpoint
CREATE INDEX "idx_skill_entries_org_tedi_supersedes" ON "skill_entries" ("organization_id","tedi_id","supersedes_id","lifecycle_state");--> statement-breakpoint
CREATE INDEX "idx_skill_run_admission_dedup_expires" ON "skill_run_admission_dedup" ("expires_at");--> statement-breakpoint
CREATE INDEX "idx_skill_run_admission_dedup_run" ON "skill_run_admission_dedup" ("run_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_skill_run_artifacts_path" ON "skill_run_artifacts" ("run_id","path");--> statement-breakpoint
CREATE INDEX "idx_skill_run_artifacts_created" ON "skill_run_artifacts" ("created_at");--> statement-breakpoint
CREATE INDEX "idx_skill_run_effect_observations_org_run" ON "skill_run_effect_observations" ("organization_id","skill_run_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_skill_run_effect_observation_user_ref" ON "skill_run_effect_observations" ("organization_id","skill_run_id","observer_user_id","evidence_ref");--> statement-breakpoint
CREATE INDEX "idx_skill_runs_completed" ON "skill_runs" ("completed_at");--> statement-breakpoint
CREATE INDEX "idx_skill_runs_org_work_environment" ON "skill_runs" ("organization_id","work_item_id","runtime_environment");--> statement-breakpoint
CREATE INDEX "idx_skill_runs_org_status" ON "skill_runs" ("organization_id","status");--> statement-breakpoint
CREATE INDEX "idx_skill_runs_skill" ON "skill_runs" ("skill_id");--> statement-breakpoint
CREATE INDEX "idx_skill_runs_tedi_started" ON "skill_runs" ("tedi_id","started_at");--> statement-breakpoint
CREATE INDEX "idx_skill_runs_reconcile" ON "skill_runs" ("runtime_environment","last_reconciled_at");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_skill_runs_workflow_instance" ON "skill_runs" ("workflow_instance_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_skill_schedules_skill" ON "skill_schedules" ("skill_id");--> statement-breakpoint
CREATE INDEX "idx_skill_schedules_due" ON "skill_schedules" ("enabled","next_fire_at");--> statement-breakpoint
CREATE INDEX "idx_skill_schedules_org" ON "skill_schedules" ("organization_id");--> statement-breakpoint
CREATE INDEX "idx_skill_schedules_tedi" ON "skill_schedules" ("tedi_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_skill_usage_events_run" ON "skill_usage_events" ("run_id","execution_epoch");--> statement-breakpoint
CREATE INDEX "idx_skill_usage_events_skill_outcome" ON "skill_usage_events" ("skill_id","outcome");--> statement-breakpoint
CREATE INDEX "idx_skill_usage_events_tedi_created" ON "skill_usage_events" ("tedi_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_skill_usage_events_org_created" ON "skill_usage_events" ("organization_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_skill_usage_events_created" ON "skill_usage_events" ("created_at");--> statement-breakpoint
CREATE INDEX "idx_stripe_webhook_entity_created" ON "stripe_webhook_events" ("entity_key","event_created_at");--> statement-breakpoint
CREATE INDEX "idx_stripe_webhook_status_lease" ON "stripe_webhook_events" ("status","lease_expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "support_tickets_org_key" ON "support_tickets" ("org_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "support_tickets_org_reporter" ON "support_tickets" ("org_id","reporter_key");--> statement-breakpoint
CREATE INDEX "support_tickets_platform_due" ON "support_tickets" ("platform_org_id","next_update_due");--> statement-breakpoint
CREATE INDEX "idx_approval_dependency_dependent_created" ON "tedi_approval_dependency_events" ("organization_id","dependent_approval_request_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_approval_dependency_prerequisite" ON "tedi_approval_dependency_events" ("organization_id","prerequisite_approval_request_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_approval_dependency_invalidation" ON "tedi_approval_dependency_events" ("invalidates_event_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_approval_execution_receipt_idempotency" ON "tedi_approval_execution_receipts" ("organization_id","approval_request_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "idx_approval_execution_receipts_request_executed" ON "tedi_approval_execution_receipts" ("organization_id","approval_request_id","executed_at");--> statement-breakpoint
CREATE INDEX "idx_approval_requests_org_action_work_status" ON "tedi_approval_requests" ("org_id","action_type","work_item_id","status");--> statement-breakpoint
CREATE INDEX "idx_approval_requests_execution_attention" ON "tedi_approval_requests" ("org_id","status","action_type","execution_dismissed_at","execution_status","expires_at");--> statement-breakpoint
CREATE INDEX "idx_approval_requests_unconsumed" ON "tedi_approval_requests" ("consumed_at","execution_status","expires_at");--> statement-breakpoint
CREATE INDEX "idx_approval_requests_resolved" ON "tedi_approval_requests" ("resolved_at");--> statement-breakpoint
CREATE INDEX "idx_approval_requests_org_created" ON "tedi_approval_requests" ("org_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_approval_requests_org_status_created" ON "tedi_approval_requests" ("org_id","status","created_at");--> statement-breakpoint
CREATE INDEX "idx_approval_requests_tedi_status" ON "tedi_approval_requests" ("tedi_id","status");--> statement-breakpoint
CREATE INDEX "idx_approval_simulations_request_created" ON "tedi_approval_simulations" ("organization_id","approval_request_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_tedi_artifact_contribution_receipts_artifact" ON "tedi_artifact_contribution_receipts" ("artifact_id");--> statement-breakpoint
CREATE INDEX "idx_tedi_artifact_contribution_receipts_tedi_created" ON "tedi_artifact_contribution_receipts" ("organization_id","tedi_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_tedi_artifacts_org" ON "tedi_artifacts" ("organization_id");--> statement-breakpoint
CREATE INDEX "idx_tedi_artifacts_tedi_created" ON "tedi_artifacts" ("tedi_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_tedi_artifacts_conversation" ON "tedi_artifacts" ("tedi_id","conversation_id");--> statement-breakpoint
CREATE INDEX "idx_tedi_artifacts_run" ON "tedi_artifacts" ("tedi_id","run_id");--> statement-breakpoint
CREATE INDEX "idx_tedi_artifacts_kind" ON "tedi_artifacts" ("tedi_id","kind");--> statement-breakpoint
CREATE INDEX "idx_call_costs_org" ON "tedi_call_costs" ("org_id","snapshot_at");--> statement-breakpoint
CREATE INDEX "idx_call_costs_created" ON "tedi_call_costs" ("created_at");--> statement-breakpoint
CREATE INDEX "idx_call_costs_window" ON "tedi_call_costs" ("tedi_id","snapshot_at");--> statement-breakpoint
CREATE INDEX "idx_call_costs_model" ON "tedi_call_costs" ("tedi_id","model","snapshot_at");--> statement-breakpoint
CREATE INDEX "idx_call_costs_run" ON "tedi_call_costs" ("run_id","snapshot_at");--> statement-breakpoint
CREATE INDEX "idx_call_costs_work_item" ON "tedi_call_costs" ("work_item_id","snapshot_at");--> statement-breakpoint
CREATE INDEX "idx_call_costs_billing_reservation" ON "tedi_call_costs" ("billing_reservation_id");--> statement-breakpoint
CREATE INDEX "idx_call_costs_execution" ON "tedi_call_costs" ("provider_execution_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_call_costs_gateway_log_id" ON "tedi_call_costs" ("gateway_log_id");--> statement-breakpoint
CREATE INDEX "idx_tedi_control_plane_binding_history_tedi_kind_time" ON "tedi_control_plane_binding_history" ("tedi_id","kind","effective_at");--> statement-breakpoint
CREATE INDEX "idx_tedi_control_plane_binding_history_org" ON "tedi_control_plane_binding_history" ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_tedi_cron_executions_fire" ON "tedi_cron_executions" ("tedi_id","fire_key");--> statement-breakpoint
CREATE INDEX "idx_tedi_cron_executions_name_started" ON "tedi_cron_executions" ("tedi_id","cron_name","started_at");--> statement-breakpoint
CREATE INDEX "idx_tedi_cron_executions_org_started" ON "tedi_cron_executions" ("org_id","started_at");--> statement-breakpoint
CREATE INDEX "idx_tedi_cron_executions_created" ON "tedi_cron_executions" ("created_at");--> statement-breakpoint
CREATE INDEX "idx_curiosity_queue_tedi" ON "tedi_curiosity_queue" ("tedi_id");--> statement-breakpoint
CREATE INDEX "idx_curiosity_queue_org" ON "tedi_curiosity_queue" ("organization_id");--> statement-breakpoint
CREATE INDEX "idx_curiosity_queue_status" ON "tedi_curiosity_queue" ("status");--> statement-breakpoint
CREATE INDEX "idx_curiosity_queue_priority" ON "tedi_curiosity_queue" ("priority");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_custom_domain_hostname" ON "tedi_custom_domains" ("hostname");--> statement-breakpoint
CREATE INDEX "idx_custom_domains_tedi" ON "tedi_custom_domains" ("tedi_id");--> statement-breakpoint
CREATE INDEX "idx_tedi_devices_status" ON "tedi_devices" ("tedi_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_tedi_email_address" ON "tedi_email_addresses" ("address");--> statement-breakpoint
CREATE INDEX "idx_tedi_email_addresses_tedi" ON "tedi_email_addresses" ("tedi_id","status");--> statement-breakpoint
CREATE INDEX "idx_tedi_email_addresses_org" ON "tedi_email_addresses" ("organization_id","status");--> statement-breakpoint
CREATE INDEX "idx_tedi_email_attachments_message" ON "tedi_email_attachments" ("message_id");--> statement-breakpoint
CREATE INDEX "idx_tedi_email_events_message" ON "tedi_email_events" ("message_id");--> statement-breakpoint
CREATE INDEX "idx_tedi_email_events_thread" ON "tedi_email_events" ("thread_id");--> statement-breakpoint
CREATE INDEX "idx_tedi_email_events_tedi_created" ON "tedi_email_events" ("tedi_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_tedi_email_messages_thread" ON "tedi_email_messages" ("thread_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_tedi_email_messages_tedi_created" ON "tedi_email_messages" ("tedi_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_tedi_email_messages_message_id" ON "tedi_email_messages" ("tedi_id","message_id_header");--> statement-breakpoint
CREATE INDEX "idx_tedi_email_messages_unread" ON "tedi_email_messages" ("tedi_id","read_at","direction");--> statement-breakpoint
CREATE INDEX "idx_tedi_email_threads_tedi_last" ON "tedi_email_threads" ("tedi_id","last_message_at");--> statement-breakpoint
CREATE INDEX "idx_tedi_email_threads_org" ON "tedi_email_threads" ("organization_id");--> statement-breakpoint
CREATE INDEX "idx_tedi_email_threads_status" ON "tedi_email_threads" ("tedi_id","status");--> statement-breakpoint
CREATE INDEX "idx_tedi_email_threads_subject" ON "tedi_email_threads" ("tedi_id","subject_norm");--> statement-breakpoint
CREATE INDEX "idx_tedi_email_trusted_recipients_org_tedi" ON "tedi_email_trusted_recipients" ("organization_id","tedi_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_tedi_entrustment_grant_activity" ON "tedi_entrustment_grants" ("tedi_id","activity_id");--> statement-breakpoint
CREATE INDEX "idx_tedi_entrustment_grant_org_status" ON "tedi_entrustment_grants" ("organization_id","status");--> statement-breakpoint
CREATE INDEX "idx_tedi_entrustment_grant_expiry" ON "tedi_entrustment_grants" ("status","expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_tedi_domain" ON "tedi_expertise" ("tedi_id","domain_id");--> statement-breakpoint
CREATE INDEX "idx_tedi_expertise_tedi" ON "tedi_expertise" ("tedi_id");--> statement-breakpoint
CREATE INDEX "idx_tedi_expertise_domain" ON "tedi_expertise" ("domain_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_growth_snapshot_tedi_date" ON "tedi_growth_snapshots" ("tedi_id","snapshot_date");--> statement-breakpoint
CREATE INDEX "idx_growth_snapshot_org" ON "tedi_growth_snapshots" ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_tedi_memory_documents_version" ON "tedi_memory_documents" ("organization_id","tedi_id","kind","name","version");--> statement-breakpoint
CREATE INDEX "idx_tedi_memory_documents_tedi" ON "tedi_memory_documents" ("tedi_id");--> statement-breakpoint
CREATE INDEX "idx_muscle_memory_org" ON "tedi_muscle_memory" ("organization_id");--> statement-breakpoint
CREATE INDEX "idx_muscle_memory_kind" ON "tedi_muscle_memory" ("kind");--> statement-breakpoint
CREATE INDEX "idx_muscle_memory_origin" ON "tedi_muscle_memory" ("origin");--> statement-breakpoint
CREATE INDEX "idx_muscle_memory_source_skill" ON "tedi_muscle_memory" ("source_skill_id");--> statement-breakpoint
CREATE INDEX "idx_muscle_memory_tedi_name" ON "tedi_muscle_memory" ("tedi_id","name");--> statement-breakpoint
CREATE INDEX "idx_objectives_status_id" ON "tedi_objectives" ("status","id");--> statement-breakpoint
CREATE INDEX "idx_objectives_org_status_id" ON "tedi_objectives" ("org_id","status","id");--> statement-breakpoint
CREATE INDEX "idx_objectives_purpose_charter" ON "tedi_objectives" ("purpose_charter_id");--> statement-breakpoint
CREATE INDEX "idx_objectives_tedi_status" ON "tedi_objectives" ("tedi_id","status");--> statement-breakpoint
CREATE INDEX "idx_objectives_tedi_type" ON "tedi_objectives" ("tedi_id","type");--> statement-breakpoint
CREATE INDEX "idx_optimization_signals_tedi" ON "tedi_optimization_signals" ("tedi_id");--> statement-breakpoint
CREATE INDEX "idx_optimization_signals_org" ON "tedi_optimization_signals" ("organization_id");--> statement-breakpoint
CREATE INDEX "idx_optimization_signals_status" ON "tedi_optimization_signals" ("status");--> statement-breakpoint
CREATE INDEX "idx_optimization_signals_roi" ON "tedi_optimization_signals" ("roi");--> statement-breakpoint
CREATE INDEX "idx_plugin_events_org" ON "tedi_plugin_events" ("org_id");--> statement-breakpoint
CREATE INDEX "idx_plugin_events_plugin" ON "tedi_plugin_events" ("plugin_id");--> statement-breakpoint
CREATE INDEX "idx_plugin_events_tedi" ON "tedi_plugin_events" ("tedi_id");--> statement-breakpoint
CREATE INDEX "idx_plugin_events_status" ON "tedi_plugin_events" ("status");--> statement-breakpoint
CREATE INDEX "idx_plugin_events_type" ON "tedi_plugin_events" ("event_type");--> statement-breakpoint
CREATE INDEX "idx_plugin_installs_org" ON "tedi_plugin_installs" ("org_id");--> statement-breakpoint
CREATE INDEX "idx_plugin_installs_plugin" ON "tedi_plugin_installs" ("plugin_id");--> statement-breakpoint
CREATE INDEX "idx_plugin_installs_tedi" ON "tedi_plugin_installs" ("tedi_id");--> statement-breakpoint
CREATE INDEX "idx_plugin_installs_status" ON "tedi_plugin_installs" ("status");--> statement-breakpoint
CREATE INDEX "idx_plugins_type" ON "tedi_plugins" ("type");--> statement-breakpoint
CREATE INDEX "idx_plugins_status" ON "tedi_plugins" ("status");--> statement-breakpoint
CREATE INDEX "idx_plugins_author" ON "tedi_plugins" ("author_org_id");--> statement-breakpoint
CREATE INDEX "idx_tedi_provisional_outcomes_org_created" ON "tedi_provisional_outcomes" ("org_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_tedi_provisional_outcomes_tedi_created" ON "tedi_provisional_outcomes" ("tedi_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_rationale_org_created" ON "tedi_rationale_records" ("org_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_rationale_tedi_created" ON "tedi_rationale_records" ("tedi_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_rationale_flywheel_window" ON "tedi_rationale_records" ("tedi_id","org_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_rationale_replay" ON "tedi_rationale_records" ("tedi_id","org_id","category","outcome_status","created_at");--> statement-breakpoint
CREATE INDEX "idx_rationale_category" ON "tedi_rationale_records" ("tedi_id","category");--> statement-breakpoint
CREATE INDEX "idx_rationale_outcome" ON "tedi_rationale_records" ("tedi_id","outcome_status");--> statement-breakpoint
CREATE INDEX "idx_rationale_run" ON "tedi_rationale_records" ("run_id");--> statement-breakpoint
CREATE INDEX "idx_rationale_work_item" ON "tedi_rationale_records" ("work_item_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_tedi_role_assignment_instance" ON "tedi_role_assignments" ("tedi_id","role_key","assigned_at");--> statement-breakpoint
CREATE INDEX "idx_tedi_role_assignment_org_stage" ON "tedi_role_assignments" ("organization_id","career_stage");--> statement-breakpoint
CREATE INDEX "idx_tedi_runtime_events_unfinished" ON "tedi_runtime_events" ("terminal_seen","kind","created_at");--> statement-breakpoint
CREATE INDEX "idx_tedi_runtime_events_org_unfinished" ON "tedi_runtime_events" ("organization_id","terminal_seen","kind","created_at");--> statement-breakpoint
CREATE INDEX "idx_tedi_runtime_events_created" ON "tedi_runtime_events" ("created_at");--> statement-breakpoint
CREATE INDEX "idx_tedi_runtime_events_global_kind_created" ON "tedi_runtime_events" ("kind","created_at");--> statement-breakpoint
CREATE INDEX "idx_tedi_runtime_events_tedi_created" ON "tedi_runtime_events" ("tedi_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_tedi_runtime_events_conversation_created" ON "tedi_runtime_events" ("tedi_id","conversation_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_tedi_runtime_events_run_created" ON "tedi_runtime_events" ("tedi_id","run_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_tedi_runtime_events_run_kind_created" ON "tedi_runtime_events" ("tedi_id","run_id","kind","created_at");--> statement-breakpoint
CREATE INDEX "idx_tedi_runtime_events_kind_created" ON "tedi_runtime_events" ("tedi_id","kind","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "tedi_runtime_leases_scope_unique" ON "tedi_runtime_leases" ("tedi_id","name");--> statement-breakpoint
CREATE INDEX "idx_tedi_runtime_leases_expires" ON "tedi_runtime_leases" ("expires_at");--> statement-breakpoint
CREATE INDEX "idx_tedi_runtime_snapshots_observed" ON "tedi_runtime_snapshots" ("tedi_id","observed_at");--> statement-breakpoint
CREATE UNIQUE INDEX "tedi_secret_unique" ON "tedi_secrets" ("tedi_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "tedi_session_states_scope_unique" ON "tedi_session_states" ("organization_id","tedi_id","user_id","session_key");--> statement-breakpoint
CREATE INDEX "idx_tedi_session_states_pinned" ON "tedi_session_states" ("tedi_id","user_id","pinned_at");--> statement-breakpoint
CREATE INDEX "idx_tedi_session_states_deleted" ON "tedi_session_states" ("tedi_id","user_id","deleted_at");--> statement-breakpoint
CREATE INDEX "idx_tasks_objective" ON "tedi_tasks" ("objective_id");--> statement-breakpoint
CREATE INDEX "idx_tasks_tedi_status" ON "tedi_tasks" ("tedi_id","status");--> statement-breakpoint
CREATE INDEX "idx_tedi_usage_events_window" ON "tedi_usage_events" ("tedi_id","started_at");--> statement-breakpoint
CREATE INDEX "idx_tedi_usage_events_created" ON "tedi_usage_events" ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_tedi_org_slug" ON "tedis" ("organization_id","slug");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_tedi_slug" ON "tedis" ("slug");--> statement-breakpoint
CREATE INDEX "idx_tedis_slug" ON "tedis" ("slug");--> statement-breakpoint
CREATE INDEX "tedis_descope_user_id_idx" ON "tedis" ("descope_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "tedis_body_generation_token_hash_idx" ON "tedis" ("body_generation_token_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_tbe_assertion_result" ON "tenant_behavioral_eval_assertion_results" ("case_run_id","assertion_index");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_tbe_case_attempt_number" ON "tenant_behavioral_eval_case_attempts" ("case_run_id","attempt_number");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_tbe_case_attempt_home" ON "tenant_behavioral_eval_case_attempts" ("home_run_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_tbe_case_run" ON "tenant_behavioral_eval_case_runs" ("run_id","case_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_tbe_home_run" ON "tenant_behavioral_eval_case_runs" ("home_run_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_tbe_definitions_id_org" ON "tenant_behavioral_eval_definitions" ("id","organization_id");--> statement-breakpoint
CREATE INDEX "idx_tbe_definitions_org" ON "tenant_behavioral_eval_definitions" ("organization_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_tbe_revisions_id_org" ON "tenant_behavioral_eval_revisions" ("id","organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_tbe_revision_number" ON "tenant_behavioral_eval_revisions" ("definition_id","revision");--> statement-breakpoint
CREATE INDEX "idx_tbe_revisions_org_definition" ON "tenant_behavioral_eval_revisions" ("organization_id","definition_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_tbe_run_idempotency" ON "tenant_behavioral_eval_runs" ("organization_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "idx_tbe_runs_org" ON "tenant_behavioral_eval_runs" ("organization_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "tenant_bundles_slug_version_unique" ON "tenant_bundles" ("slug","version");--> statement-breakpoint
CREATE INDEX "tenant_bundles_slug_active_idx" ON "tenant_bundles" ("slug","is_active");--> statement-breakpoint
CREATE INDEX "tenant_provider_identity_preparations_owner_idx" ON "tenant_provider_identity_preparations" ("organization_id","owner_id");--> statement-breakpoint
CREATE INDEX "tenant_provider_identity_profiles_org_idx" ON "tenant_provider_identity_profiles" ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "tenant_tool_policies_revision_order_idx" ON "tenant_tool_policies" ("organization_id","app_id","tool_row_id","created_at");--> statement-breakpoint
CREATE INDEX "tenant_tool_policy_mount_revision_lookup_idx" ON "tenant_tool_policy_mount_revisions" ("organization_id","root_app_id","mounted_tool_id","sequence");--> statement-breakpoint
CREATE INDEX "tenant_tool_policy_subject_revision_lookup_idx" ON "tenant_tool_policy_mount_revisions" ("organization_id","root_app_id","mounted_tool_id","subject_key","sequence");--> statement-breakpoint
CREATE INDEX "tenant_tool_policy_preparations_owner_idx" ON "tenant_tool_policy_preparations" ("organization_id","owner_id");--> statement-breakpoint
CREATE INDEX "token_exchange_grants_org_issued_idx" ON "token_exchange_grants" ("organization_id","issued_at");--> statement-breakpoint
CREATE INDEX "token_exchange_grants_parent_idx" ON "token_exchange_grants" ("parent_jti");--> statement-breakpoint
CREATE INDEX "idx_trace_bundles_tedi_run" ON "trace_bundles" ("tedi_id","run_id");--> statement-breakpoint
CREATE INDEX "idx_trace_bundles_tedi_created" ON "trace_bundles" ("tedi_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_trace_bundles_org" ON "trace_bundles" ("org_id");--> statement-breakpoint
CREATE INDEX "idx_trace_bundles_created" ON "trace_bundles" ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "drift_reports_catalog_app_unique" ON "upstream_drift_reports" ("catalog_app_id");--> statement-breakpoint
CREATE INDEX "drift_reports_checked_idx" ON "upstream_drift_reports" ("checked_at");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_user_configs_user_namespace_key" ON "user_configs" ("user_id","namespace","key");--> statement-breakpoint
CREATE INDEX "idx_user_configs_namespace" ON "user_configs" ("namespace");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_users_email" ON "users" ("email");--> statement-breakpoint
CREATE INDEX "idx_users_email" ON "users" ("email");--> statement-breakpoint
CREATE INDEX "idx_users_last_login" ON "users" ("last_login_at");--> statement-breakpoint
CREATE INDEX "idx_widget_events_org" ON "widget_events" ("organization_id");--> statement-breakpoint
CREATE INDEX "idx_widget_events_app" ON "widget_events" ("app_id");--> statement-breakpoint
CREATE INDEX "idx_widget_events_session" ON "widget_events" ("session_id");--> statement-breakpoint
CREATE INDEX "idx_widget_events_type" ON "widget_events" ("event_type");--> statement-breakpoint
CREATE INDEX "idx_widget_events_widget" ON "widget_events" ("widget_key");--> statement-breakpoint
CREATE INDEX "idx_widget_events_created" ON "widget_events" ("created_at");--> statement-breakpoint
CREATE INDEX "idx_widget_events_item" ON "widget_events" ("item_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_work_admission_org_item_id" ON "work_admissions" ("org_id","work_item_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_work_admission_rejection_key" ON "work_admissions" ("org_id","rejection_key");--> statement-breakpoint
CREATE INDEX "idx_work_admission_executor_time" ON "work_admissions" ("org_id","executor_type","executor_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_work_admission_item_time" ON "work_admissions" ("org_id","work_item_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_work_agent_sessions_org_harness_session" ON "work_agent_sessions" ("organization_id","harness","session_key");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_work_agent_sessions_org_user_harness_session" ON "work_agent_sessions" ("organization_id","user_id","harness","session_key");--> statement-breakpoint
CREATE INDEX "idx_work_agent_sessions_org_user_last_event" ON "work_agent_sessions" ("organization_id","user_id","last_event_at");--> statement-breakpoint
CREATE INDEX "idx_work_agent_sessions_org_user_session" ON "work_agent_sessions" ("organization_id","user_id","session_key");--> statement-breakpoint
CREATE INDEX "idx_work_agent_sessions_org_project" ON "work_agent_sessions" ("organization_id","project_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_work_approval_decision_proposal" ON "work_approval_decisions" ("proposal_id");--> statement-breakpoint
CREATE INDEX "idx_work_approval_decisions_time" ON "work_approval_decisions" ("decided_at");--> statement-breakpoint
CREATE INDEX "idx_work_approval_resolved" ON "work_approval_proposals" ("resolved_at");--> statement-breakpoint
CREATE INDEX "idx_work_approval_approver_status" ON "work_approval_proposals" ("org_id","approver_type","approver_id","status");--> statement-breakpoint
CREATE INDEX "idx_work_approval_item_created" ON "work_approval_proposals" ("org_id","work_item_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_work_attempt_messages_attempt_delivered" ON "work_attempt_messages" ("attempt_id","delivered_at");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_work_attempt_step_seq" ON "work_attempt_steps" ("attempt_id","seq");--> statement-breakpoint
CREATE INDEX "idx_work_attempt_steps_item_attempt_seq" ON "work_attempt_steps" ("work_item_id","attempt_id","seq");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_work_attempt_number" ON "work_attempts" ("org_id","work_item_id","attempt_number");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_work_attempt_admission" ON "work_attempts" ("admission_id");--> statement-breakpoint
CREATE INDEX "idx_work_attempt_executor_state" ON "work_attempts" ("org_id","executor_type","executor_id","runtime_state");--> statement-breakpoint
CREATE INDEX "idx_work_attempt_expiry" ON "work_attempts" ("runtime_state","expires_at");--> statement-breakpoint
CREATE INDEX "idx_work_attempt_org_started" ON "work_attempts" ("org_id","started_at");--> statement-breakpoint
CREATE INDEX "idx_work_attempt_org_item_heartbeat" ON "work_attempts" ("org_id","work_item_id","heartbeat_at");--> statement-breakpoint
CREATE INDEX "idx_work_attempt_org_state_started" ON "work_attempts" ("org_id","runtime_state","started_at");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_work_budget_scope" ON "work_budget_envelopes" ("org_id","scope_type","scope_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_work_budget_org_id" ON "work_budget_envelopes" ("org_id","id");--> statement-breakpoint
CREATE INDEX "idx_work_budget_org_enabled" ON "work_budget_envelopes" ("org_id","enabled");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_work_budget_reservation_admission_envelope" ON "work_budget_reservations" ("admission_id","envelope_id");--> statement-breakpoint
CREATE INDEX "idx_work_budget_reservation_envelope_active" ON "work_budget_reservations" ("org_id","envelope_id","state","expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_work_case_dependency" ON "work_case_dependencies" ("org_id","prerequisite_case_id","dependent_case_id");--> statement-breakpoint
CREATE INDEX "idx_work_case_dependency_to" ON "work_case_dependencies" ("org_id","dependent_case_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_work_case_item" ON "work_case_items" ("org_id","case_id","work_item_id");--> statement-breakpoint
CREATE INDEX "idx_work_case_items_work" ON "work_case_items" ("org_id","work_item_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_work_cases_org_id" ON "work_cases" ("org_id","id");--> statement-breakpoint
CREATE INDEX "idx_work_cases_org_stage" ON "work_cases" ("org_id","stage","created_at");--> statement-breakpoint
CREATE INDEX "idx_work_cases_project" ON "work_cases" ("org_id","project_id");--> statement-breakpoint
CREATE INDEX "idx_work_due_status_due" ON "work_due" ("status","due_at");--> statement-breakpoint
CREATE INDEX "idx_work_events_occurred" ON "work_events" ("occurred_at");--> statement-breakpoint
CREATE INDEX "idx_work_events_org_occurred" ON "work_events" ("org_id","occurred_at","id");--> statement-breakpoint
CREATE INDEX "idx_work_events_project_occurred" ON "work_events" ("org_id","project_id","occurred_at","id");--> statement-breakpoint
CREATE INDEX "idx_work_events_objective_occurred" ON "work_events" ("org_id","objective_id","occurred_at","id");--> statement-breakpoint
CREATE INDEX "idx_work_events_project_sequence" ON "work_events" ("org_id","project_id","sequence");--> statement-breakpoint
CREATE INDEX "idx_work_events_objective_sequence" ON "work_events" ("org_id","objective_id","sequence");--> statement-breakpoint
CREATE INDEX "idx_work_events_item_sequence" ON "work_events" ("org_id","work_item_id","sequence");--> statement-breakpoint
CREATE INDEX "idx_work_events_attempt_sequence" ON "work_events" ("attempt_id","sequence");--> statement-breakpoint
CREATE INDEX "idx_work_events_org_type_actor" ON "work_events" ("org_id","event_type","actor_type");--> statement-breakpoint
CREATE INDEX "idx_work_events_org_type_occurred" ON "work_events" ("org_id","event_type","occurred_at");--> statement-breakpoint
CREATE INDEX "idx_work_evidence_item_disposition" ON "work_evidence" ("org_id","work_item_id","disposition");--> statement-breakpoint
CREATE INDEX "idx_work_evidence_attempt" ON "work_evidence" ("attempt_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_work_evidence_verification_source" ON "work_evidence_verifications" ("org_id","evidence_id","source");--> statement-breakpoint
CREATE INDEX "idx_work_evidence_verifications_item" ON "work_evidence_verifications" ("org_id","work_item_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_card_revision" ON "work_interaction_card_revisions" ("org_id","request_id","revision");--> statement-breakpoint
CREATE INDEX "idx_work_interaction_decision_history_latest" ON "work_interaction_decision_history" ("org_id","target_type","target_id","relation_key","responded_at","response_id","interaction_id");--> statement-breakpoint
CREATE INDEX "idx_work_interaction_deliveries_request" ON "work_interaction_deliveries" ("org_id","interaction_id");--> statement-breakpoint
CREATE INDEX "idx_work_interaction_reply_drafts_request" ON "work_interaction_reply_drafts" ("org_id","interaction_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_work_interaction_responses_time" ON "work_interaction_responses" ("responded_at");--> statement-breakpoint
CREATE INDEX "idx_work_interaction_responses_cursor" ON "work_interaction_responses" ("org_id","interaction_id","responded_at","id");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_work_interactions_org_id" ON "work_interactions" ("org_id","id");--> statement-breakpoint
CREATE INDEX "idx_work_interactions_source_status_org" ON "work_interactions" ("source","status","org_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_work_interactions_due" ON "work_interactions" ("due_at");--> statement-breakpoint
CREATE INDEX "idx_work_interactions_target_status" ON "work_interactions" ("org_id","target_type","target_id","status","created_at");--> statement-breakpoint
CREATE INDEX "idx_work_interactions_work" ON "work_interactions" ("org_id","work_item_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_work_item_comments_work_item" ON "work_item_comments" ("work_item_id");--> statement-breakpoint
CREATE INDEX "idx_work_item_comments_org" ON "work_item_comments" ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_work_item_corroboration_principal" ON "work_item_corroborations" ("org_id","work_item_id","principal_type","principal_id");--> statement-breakpoint
CREATE INDEX "idx_work_item_projections_org_provider" ON "work_item_projections" ("org_id","provider");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_work_item_projection_provider" ON "work_item_projections" ("work_item_id","provider");--> statement-breakpoint
CREATE INDEX "idx_work_item_relations_org" ON "work_item_relations" ("org_id");--> statement-breakpoint
CREATE INDEX "idx_work_item_relations_to" ON "work_item_relations" ("to_work_item_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_work_item_relation" ON "work_item_relations" ("from_work_item_id","to_work_item_id","relation_type");--> statement-breakpoint
CREATE INDEX "idx_work_item_source_project" ON "work_item_sources" ("org_id","project_id","state");--> statement-breakpoint
CREATE INDEX "idx_work_item_source_work_item" ON "work_item_sources" ("org_id","work_item_id");--> statement-breakpoint
CREATE INDEX "idx_work_item_source_sweep" ON "work_item_sources" ("org_id","provider","last_checked_at");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_work_items_org_id" ON "work_items" ("org_id","id");--> statement-breakpoint
CREATE INDEX "idx_work_items_metadata_executor" ON "work_items" ("org_id","metadata_executor","created_at");--> statement-breakpoint
CREATE INDEX "idx_work_items_metadata_source" ON "work_items" ("org_id","metadata_source","created_at");--> statement-breakpoint
CREATE INDEX "idx_work_items_observer_report_woken" ON "work_items" ("org_id","project_id","repository_observer","report","observer_woken_at");--> statement-breakpoint
CREATE INDEX "idx_work_items_deadline" ON "work_items" ("deadline");--> statement-breakpoint
CREATE INDEX "idx_work_items_due_date" ON "work_items" ("due_date");--> statement-breakpoint
CREATE INDEX "idx_work_items_org_created" ON "work_items" ("org_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_work_items_lane_executor" ON "work_items" ("org_id","disposition","executor_type","executor_id","created_at","id");--> statement-breakpoint
CREATE INDEX "idx_work_items_org_kind_risk" ON "work_items" ("org_id","work_kind","risk_level");--> statement-breakpoint
CREATE INDEX "idx_work_items_project" ON "work_items" ("project_id");--> statement-breakpoint
CREATE INDEX "idx_work_items_org_project_created" ON "work_items" ("org_id","project_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_work_items_org_project_disposition" ON "work_items" ("org_id","project_id","disposition");--> statement-breakpoint
CREATE INDEX "idx_work_items_parent" ON "work_items" ("parent_work_item_id");--> statement-breakpoint
CREATE INDEX "idx_work_items_accountable_owner" ON "work_items" ("org_id","accountable_owner_type","accountable_owner_id");--> statement-breakpoint
CREATE INDEX "idx_work_items_objective" ON "work_items" ("objective_id");--> statement-breakpoint
CREATE INDEX "idx_work_items_org_objective" ON "work_items" ("org_id","objective_id");--> statement-breakpoint
CREATE INDEX "idx_work_items_org_class" ON "work_items" ("org_id","work_class");--> statement-breakpoint
CREATE INDEX "idx_work_items_source_intent" ON "work_items" ("source_intent_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_work_items_org_source_intent" ON "work_items" ("org_id","source_intent_id");--> statement-breakpoint
CREATE INDEX "idx_work_project_health_observed" ON "work_project_health_judgments" ("org_id","project_id","observed_at");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_work_resource_pool_key" ON "work_resource_pools" ("org_id","resource_key");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_work_resource_pool_org_id" ON "work_resource_pools" ("org_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_work_resource_reservation_admission_key" ON "work_resource_reservations" ("admission_id","resource_key");--> statement-breakpoint
CREATE INDEX "idx_work_resource_reservation_pool_active" ON "work_resource_reservations" ("org_id","pool_id","state","expires_at");--> statement-breakpoint
CREATE INDEX "workflow_run_ledger_type_started_idx" ON "workflow_run_ledger" ("workflow_type","started_at");--> statement-breakpoint
CREATE INDEX "workflow_run_ledger_status_started_idx" ON "workflow_run_ledger" ("status","started_at");--> statement-breakpoint
CREATE INDEX "workflow_run_ledger_workflow_id_idx" ON "workflow_run_ledger" ("workflow_id");--> statement-breakpoint
CREATE INDEX "workflow_run_ledger_started_idx" ON "workflow_run_ledger" ("started_at");--> statement-breakpoint
CREATE INDEX "workspace_activity_org_occurred_idx" ON "workspace_activity" ("organization_id","occurred_at","seq");--> statement-breakpoint
CREATE INDEX "workspace_activity_workspace_seq_idx" ON "workspace_activity" ("workspace_id","seq");--> statement-breakpoint
CREATE INDEX "workspace_activity_entity_idx" ON "workspace_activity" ("entity_id","revision");--> statement-breakpoint
CREATE INDEX "workspace_feed_cursors_org_idx" ON "workspace_feed_cursors" ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "workspace_feed_ledger_workspace_seq_unique" ON "workspace_feed_ledger" ("workspace_id","seq");--> statement-breakpoint
CREATE INDEX "workspace_feed_ledger_org_idx" ON "workspace_feed_ledger" ("organization_id");--> statement-breakpoint
CREATE INDEX "workspace_feed_ledger_workspace_change_idx" ON "workspace_feed_ledger" ("workspace_id","change_record_id");--> statement-breakpoint
CREATE UNIQUE INDEX "workspace_output_index_output_revision_unique" ON "workspace_output_index" ("output_id","revision");--> statement-breakpoint
CREATE INDEX "workspace_output_index_org_current_idx" ON "workspace_output_index" ("organization_id","is_current","updated_at");--> statement-breakpoint
CREATE INDEX "workspace_output_index_workspace_idx" ON "workspace_output_index" ("workspace_id","output_id");--> statement-breakpoint
CREATE INDEX "workspace_output_index_org_output_current_idx" ON "workspace_output_index" ("organization_id","output_id","is_current","revision");--> statement-breakpoint
CREATE INDEX "workspace_output_index_org_workspace_current_idx" ON "workspace_output_index" ("organization_id","workspace_id","is_current","updated_at");--> statement-breakpoint
CREATE INDEX "workspace_output_index_org_revision_idx" ON "workspace_output_index" ("organization_id","revision_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_workspace_template_sets_scope_slug_version" ON "workspace_template_sets" ("scope","slug","version");--> statement-breakpoint
CREATE INDEX "idx_workspace_template_sets_org" ON "workspace_template_sets" ("organization_id");--> statement-breakpoint
CREATE INDEX "idx_workspace_template_sets_status" ON "workspace_template_sets" ("status");--> statement-breakpoint
CREATE INDEX "idx_workspace_template_sets_family" ON "workspace_template_sets" ("scope","slug","version");--> statement-breakpoint
CREATE INDEX "workspace_work_links_work_item_idx" ON "workspace_work_links" ("organization_id","work_item_id");--> statement-breakpoint
CREATE INDEX "workspace_work_links_output_idx" ON "workspace_work_links" ("output_id");--> statement-breakpoint
CREATE INDEX "idx_workstation_leases_workstation" ON "workstation_leases" ("workstation_id");--> statement-breakpoint
CREATE INDEX "idx_workstation_leases_org" ON "workstation_leases" ("org_id");--> statement-breakpoint
CREATE INDEX "idx_workstation_leases_kernel_run" ON "workstation_leases" ("kernel_run_id");--> statement-breakpoint
CREATE INDEX "idx_workstation_leases_work_item" ON "workstation_leases" ("work_item_id");--> statement-breakpoint
CREATE INDEX "idx_workstation_leases_attempt" ON "workstation_leases" ("attempt_id");--> statement-breakpoint
CREATE INDEX "idx_workstation_leases_trace_bundle" ON "workstation_leases" ("trace_bundle_id");--> statement-breakpoint
CREATE INDEX "idx_workstation_leases_status" ON "workstation_leases" ("status");--> statement-breakpoint
CREATE INDEX "idx_workstation_leases_body_generation" ON "workstation_leases" ("body_generation_id");--> statement-breakpoint
CREATE INDEX "idx_workstation_leases_body_instance" ON "workstation_leases" ("body_instance_name");--> statement-breakpoint
CREATE INDEX "idx_workstation_participants_lease" ON "workstation_participants" ("lease_id");--> statement-breakpoint
CREATE INDEX "idx_workstation_participants_tedi" ON "workstation_participants" ("tedi_id");--> statement-breakpoint
CREATE INDEX "idx_workstation_participants_org" ON "workstation_participants" ("org_id");--> statement-breakpoint
CREATE INDEX "idx_workstation_sessions_lease" ON "workstation_sessions" ("lease_id");--> statement-breakpoint
CREATE INDEX "idx_workstation_sessions_participant" ON "workstation_sessions" ("participant_id");--> statement-breakpoint
CREATE INDEX "idx_workstation_sessions_org" ON "workstation_sessions" ("org_id");--> statement-breakpoint
CREATE INDEX "idx_workstation_sessions_kind" ON "workstation_sessions" ("kind");--> statement-breakpoint
CREATE INDEX "idx_workstations_org_profile" ON "workstations" ("org_id","profile_id");--> statement-breakpoint
CREATE INDEX "idx_workstations_status" ON "workstations" ("status");--> statement-breakpoint
ALTER TABLE "agent_session_events" ADD CONSTRAINT "agent_session_events_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "agent_session_requests" ADD CONSTRAINT "agent_session_requests_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "app_adapter_secret_bindings" ADD CONSTRAINT "app_adapter_secret_bindings_adapter_id_app_adapters_id_fk" FOREIGN KEY ("adapter_id") REFERENCES "app_adapters"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "app_adapter_secret_bindings" ADD CONSTRAINT "app_adapter_secret_bindings_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "apps"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "app_adapters" ADD CONSTRAINT "app_adapters_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "apps"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "app_catalog_changes" ADD CONSTRAINT "app_catalog_changes_catalog_app_id_app_catalog_id_fk" FOREIGN KEY ("catalog_app_id") REFERENCES "app_catalog"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "app_catalog_health_history" ADD CONSTRAINT "app_catalog_health_history_catalog_app_id_app_catalog_id_fk" FOREIGN KEY ("catalog_app_id") REFERENCES "app_catalog"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "app_catalog_mcp_prompts" ADD CONSTRAINT "app_catalog_mcp_prompts_catalog_app_id_app_catalog_id_fk" FOREIGN KEY ("catalog_app_id") REFERENCES "app_catalog"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "app_catalog_mcp_resource_templates" ADD CONSTRAINT "app_catalog_mcp_resource_templates_catalog_app_id_app_catalog_id_fk" FOREIGN KEY ("catalog_app_id") REFERENCES "app_catalog"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "app_catalog_mcp_resources" ADD CONSTRAINT "app_catalog_mcp_resources_catalog_app_id_app_catalog_id_fk" FOREIGN KEY ("catalog_app_id") REFERENCES "app_catalog"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "app_catalog_mcp_skills" ADD CONSTRAINT "app_catalog_mcp_skills_catalog_app_id_app_catalog_id_fk" FOREIGN KEY ("catalog_app_id") REFERENCES "app_catalog"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "app_catalog_mcp_tools" ADD CONSTRAINT "app_catalog_mcp_tools_catalog_app_id_app_catalog_id_fk" FOREIGN KEY ("catalog_app_id") REFERENCES "app_catalog"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "app_catalog_store_listings" ADD CONSTRAINT "app_catalog_store_listings_catalog_app_id_app_catalog_id_fk" FOREIGN KEY ("catalog_app_id") REFERENCES "app_catalog"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "app_catalog_tool_tests" ADD CONSTRAINT "app_catalog_tool_tests_catalog_app_id_app_catalog_id_fk" FOREIGN KEY ("catalog_app_id") REFERENCES "app_catalog"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "app_config_versions" ADD CONSTRAINT "app_config_versions_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "apps"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "app_secrets" ADD CONSTRAINT "app_secrets_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "apps"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "app_tool_csp_domains" ADD CONSTRAINT "app_tool_csp_domains_app_tool_id_app_tools_id_fk" FOREIGN KEY ("app_tool_id") REFERENCES "app_tools"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "app_tools" ADD CONSTRAINT "app_tools_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "apps"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "apps" ADD CONSTRAINT "apps_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "apps" ADD CONSTRAINT "apps_source_app_id_apps_id_fk" FOREIGN KEY ("source_app_id") REFERENCES "apps"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "apps" ADD CONSTRAINT "apps_catalog_app_id_app_catalog_id_fk" FOREIGN KEY ("catalog_app_id") REFERENCES "app_catalog"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "artifact_redaction_candidates" ADD CONSTRAINT "artifact_redaction_candidates_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "artifact_redaction_candidates" ADD CONSTRAINT "artifact_redaction_candidates_tedi_id_tedis_id_fk" FOREIGN KEY ("tedi_id") REFERENCES "tedis"("id");--> statement-breakpoint
ALTER TABLE "artifact_redaction_candidates" ADD CONSTRAINT "artifact_redaction_candidates_parent_artifact_id_tedi_artifacts_id_fk" FOREIGN KEY ("parent_artifact_id") REFERENCES "tedi_artifacts"("id");--> statement-breakpoint
ALTER TABLE "artifact_redaction_candidates" ADD CONSTRAINT "artifact_redaction_candidates_child_artifact_id_tedi_artifacts_id_fk" FOREIGN KEY ("child_artifact_id") REFERENCES "tedi_artifacts"("id");--> statement-breakpoint
ALTER TABLE "artifact_release_reviews" ADD CONSTRAINT "artifact_release_reviews_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "artifact_release_reviews" ADD CONSTRAINT "artifact_release_reviews_tedi_id_tedis_id_fk" FOREIGN KEY ("tedi_id") REFERENCES "tedis"("id");--> statement-breakpoint
ALTER TABLE "artifact_release_reviews" ADD CONSTRAINT "artifact_release_reviews_candidate_id_artifact_redaction_candidates_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "artifact_redaction_candidates"("id");--> statement-breakpoint
ALTER TABLE "billing_accounts" ADD CONSTRAINT "billing_accounts_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "billing_accounts" ADD CONSTRAINT "billing_accounts_plan_version_id_billing_plan_versions_id_fk" FOREIGN KEY ("plan_version_id") REFERENCES "billing_plan_versions"("id");--> statement-breakpoint
ALTER TABLE "billing_cost_rollups" ADD CONSTRAINT "billing_cost_rollups_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "billing_credit_caps" ADD CONSTRAINT "billing_credit_caps_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "billing_credit_consumptions" ADD CONSTRAINT "billing_credit_consumptions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "billing_credit_consumptions" ADD CONSTRAINT "billing_credit_consumptions_tedi_id_tedis_id_fk" FOREIGN KEY ("tedi_id") REFERENCES "tedis"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "billing_credit_meter_outbox" ADD CONSTRAINT "billing_credit_meter_outbox_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "billing_credit_meter_outbox" ADD CONSTRAINT "billing_credit_meter_outbox_consumption_id_billing_credit_consumptions_id_fk" FOREIGN KEY ("consumption_id") REFERENCES "billing_credit_consumptions"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "billing_credit_notice_deliveries" ADD CONSTRAINT "billing_credit_notice_deliveries_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "billing_credit_notices" ADD CONSTRAINT "billing_credit_notices_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "billing_credit_top_ups" ADD CONSTRAINT "billing_credit_top_ups_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "billing_credit_top_ups" ADD CONSTRAINT "billing_credit_top_ups_pack_version_id_billing_top_up_pack_versions_id_fk" FOREIGN KEY ("pack_version_id") REFERENCES "billing_top_up_pack_versions"("id");--> statement-breakpoint
ALTER TABLE "billing_credit_usage_totals" ADD CONSTRAINT "billing_credit_usage_totals_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "billing_inference_policies" ADD CONSTRAINT "billing_inference_policies_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "billing_inference_policies" ADD CONSTRAINT "billing_inference_policies_tedi_id_tedis_id_fk" FOREIGN KEY ("tedi_id") REFERENCES "tedis"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "billing_service_credit_controls" ADD CONSTRAINT "billing_service_credit_controls_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "billing_service_credit_reservations" ADD CONSTRAINT "billing_service_credit_reservations_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "billing_service_credit_reservations" ADD CONSTRAINT "billing_service_credit_reservations_plan_version_id_billing_plan_versions_id_fk" FOREIGN KEY ("plan_version_id") REFERENCES "billing_plan_versions"("id");--> statement-breakpoint
ALTER TABLE "billing_service_credit_reservations" ADD CONSTRAINT "billing_service_credit_reservations_rate_card_id_billing_service_rate_cards_id_fk" FOREIGN KEY ("rate_card_id") REFERENCES "billing_service_rate_cards"("id");--> statement-breakpoint
ALTER TABLE "billing_service_credit_reservations" ADD CONSTRAINT "billing_service_credit_reservations_tedi_id_tedis_id_fk" FOREIGN KEY ("tedi_id") REFERENCES "tedis"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "billing_usage_charges" ADD CONSTRAINT "billing_usage_charges_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "billing_usage_charges" ADD CONSTRAINT "billing_usage_charges_tedi_id_tedis_id_fk" FOREIGN KEY ("tedi_id") REFERENCES "tedis"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "billing_usage_charges" ADD CONSTRAINT "billing_usage_charges_reservation_id_billing_usage_reservations_id_fk" FOREIGN KEY ("reservation_id") REFERENCES "billing_usage_reservations"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "billing_usage_charges" ADD CONSTRAINT "billing_usage_charges_usage_period_id_billing_usage_periods_id_fk" FOREIGN KEY ("usage_period_id") REFERENCES "billing_usage_periods"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "billing_usage_periods" ADD CONSTRAINT "billing_usage_periods_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "billing_usage_periods" ADD CONSTRAINT "billing_usage_periods_plan_version_id_billing_plan_versions_id_fk" FOREIGN KEY ("plan_version_id") REFERENCES "billing_plan_versions"("id");--> statement-breakpoint
ALTER TABLE "billing_usage_reservations" ADD CONSTRAINT "billing_usage_reservations_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "billing_usage_reservations" ADD CONSTRAINT "billing_usage_reservations_plan_version_id_billing_plan_versions_id_fk" FOREIGN KEY ("plan_version_id") REFERENCES "billing_plan_versions"("id");--> statement-breakpoint
ALTER TABLE "billing_usage_reservations" ADD CONSTRAINT "billing_usage_reservations_tedi_id_tedis_id_fk" FOREIGN KEY ("tedi_id") REFERENCES "tedis"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "calendar_coordinator_configurations" ADD CONSTRAINT "calendar_coordinator_configurations_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "calendar_coordinator_configurations" ADD CONSTRAINT "calendar_coordinator_configurations_workspace_id_os_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "os_workspaces"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "calendar_coordinator_mirrors" ADD CONSTRAINT "calendar_coordinator_mirrors_configuration_id_calendar_coordinator_configurations_id_fk" FOREIGN KEY ("configuration_id") REFERENCES "calendar_coordinator_configurations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "calendar_coordinator_mutations" ADD CONSTRAINT "calendar_coordinator_mutations_configuration_id_calendar_coordinator_configurations_id_fk" FOREIGN KEY ("configuration_id") REFERENCES "calendar_coordinator_configurations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "calendar_coordinator_plans" ADD CONSTRAINT "calendar_coordinator_plans_configuration_id_calendar_coordinator_configurations_id_fk" FOREIGN KEY ("configuration_id") REFERENCES "calendar_coordinator_configurations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "capability_links" ADD CONSTRAINT "capability_links_capability_id_org_capabilities_id_fk" FOREIGN KEY ("capability_id") REFERENCES "org_capabilities"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "capability_links" ADD CONSTRAINT "capability_links_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "cms_deprovision_operations" ADD CONSTRAINT "cms_deprovision_operations_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "cms_domain_claims" ADD CONSTRAINT "cms_domain_claims_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "cms_domain_claims" ADD CONSTRAINT "cms_domain_claims_site_id_cms_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "cms_sites"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "cms_sites" ADD CONSTRAINT "cms_sites_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "cms_sites" ADD CONSTRAINT "cms_sites_mcp_app_id_apps_id_fk" FOREIGN KEY ("mcp_app_id") REFERENCES "apps"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "cms_sites" ADD CONSTRAINT "cms_sites_authoring_app_id_apps_id_fk" FOREIGN KEY ("authoring_app_id") REFERENCES "apps"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "commitment_wake_outbox" ADD CONSTRAINT "commitment_wake_outbox_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "competency_observation_attestations" ADD CONSTRAINT "competency_observation_attestations_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "competency_observation_attestations" ADD CONSTRAINT "competency_observation_attestations_observation_id_competency_observations_id_fk" FOREIGN KEY ("observation_id") REFERENCES "competency_observations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "competency_observations" ADD CONSTRAINT "competency_observations_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "competency_observations" ADD CONSTRAINT "competency_observations_tedi_id_tedis_id_fk" FOREIGN KEY ("tedi_id") REFERENCES "tedis"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "competency_observations" ADD CONSTRAINT "competency_observations_activity_id_entrustable_activities_id_fk" FOREIGN KEY ("activity_id") REFERENCES "entrustable_activities"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "competency_observations" ADD CONSTRAINT "competency_observations_work_item_id_work_items_id_fk" FOREIGN KEY ("work_item_id") REFERENCES "work_items"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "connection_provider_ownership" ADD CONSTRAINT "connection_provider_ownership_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "connection_provider_settings" ADD CONSTRAINT "connection_provider_settings_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "content_source_documents" ADD CONSTRAINT "content_source_documents_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "apps"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "content_source_documents" ADD CONSTRAINT "content_source_documents_source_id_content_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "content_sources"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "content_sources" ADD CONSTRAINT "content_sources_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "apps"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "decision_edges" ADD CONSTRAINT "decision_edges_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "decision_exposures" ADD CONSTRAINT "decision_exposures_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "decision_outcome_labels" ADD CONSTRAINT "decision_outcome_labels_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "delegation_value_claims" ADD CONSTRAINT "delegation_value_claims_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "delegation_value_claims" ADD CONSTRAINT "delegation_value_claims_tedi_id_tedis_id_fk" FOREIGN KEY ("tedi_id") REFERENCES "tedis"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "delegation_value_claims" ADD CONSTRAINT "delegation_value_claims_observation_id_competency_observations_id_fk" FOREIGN KEY ("observation_id") REFERENCES "competency_observations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "delegation_value_claims" ADD CONSTRAINT "delegation_value_claims_work_item_id_work_items_id_fk" FOREIGN KEY ("work_item_id") REFERENCES "work_items"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "dispatcher_health_reports" ADD CONSTRAINT "dispatcher_health_reports_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "docs_builds" ADD CONSTRAINT "docs_builds_site_id_docs_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "docs_sites"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "docs_changes" ADD CONSTRAINT "docs_changes_site_id_docs_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "docs_sites"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "docs_releases" ADD CONSTRAINT "docs_releases_site_id_docs_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "docs_sites"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "docs_releases" ADD CONSTRAINT "docs_releases_build_id_docs_builds_id_fk" FOREIGN KEY ("build_id") REFERENCES "docs_builds"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "docs_sites" ADD CONSTRAINT "docs_sites_org_slug_organizations_slug_fk" FOREIGN KEY ("org_slug") REFERENCES "organizations"("slug") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "earned_delegation_evidence_revisions" ADD CONSTRAINT "earned_delegation_evidence_revisions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "earned_delegation_evidence_revisions" ADD CONSTRAINT "earned_delegation_evidence_revisions_tedi_id_tedis_id_fk" FOREIGN KEY ("tedi_id") REFERENCES "tedis"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "embedded_contact_users" ADD CONSTRAINT "embedded_contact_users_installation_id_provider_installations_id_fk" FOREIGN KEY ("installation_id") REFERENCES "provider_installations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "entrustable_activities" ADD CONSTRAINT "entrustable_activities_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "entrustable_activities" ADD CONSTRAINT "entrustable_activities_supersedes_id_entrustable_activities_id_fk" FOREIGN KEY ("supersedes_id") REFERENCES "entrustable_activities"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "entrustable_activities" ADD CONSTRAINT "entrustable_activities_role_template_id_role_templates_id_fk" FOREIGN KEY ("role_template_id") REFERENCES "role_templates"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "external_agent_attributions" ADD CONSTRAINT "external_agent_attributions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "external_agent_attributions" ADD CONSTRAINT "fk_external_agent_attribution_session_org" FOREIGN KEY ("organization_id","principal_id","session_id") REFERENCES "external_agent_sessions"("organization_id","principal_id","id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "external_agent_attributions" ADD CONSTRAINT "fk_external_agent_attribution_work_item_org" FOREIGN KEY ("organization_id","work_item_id") REFERENCES "work_items"("org_id","id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "external_agent_exchange_limits" ADD CONSTRAINT "external_agent_exchange_limits_organization_id_principal_id_external_agent_principals_organization_id_id_fk" FOREIGN KEY ("organization_id","principal_id") REFERENCES "external_agent_principals"("organization_id","id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "external_agent_mcp_credentials" ADD CONSTRAINT "external_agent_mcp_credentials_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "external_agent_mcp_credentials" ADD CONSTRAINT "fk_external_agent_mcp_credential_session_org" FOREIGN KEY ("organization_id","principal_id","session_id") REFERENCES "external_agent_sessions"("organization_id","principal_id","id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "external_agent_mcp_issuance_leases" ADD CONSTRAINT "external_agent_mcp_issuance_leases_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "external_agent_mcp_issuance_leases" ADD CONSTRAINT "fk_external_agent_mcp_issuance_lease_session_org" FOREIGN KEY ("organization_id","principal_id","session_id") REFERENCES "external_agent_sessions"("organization_id","principal_id","id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "external_agent_principals" ADD CONSTRAINT "external_agent_principals_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "external_agent_review_evidence" ADD CONSTRAINT "external_agent_review_evidence_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "external_agent_review_evidence" ADD CONSTRAINT "fk_external_agent_review_execution_org" FOREIGN KEY ("organization_id","execution_attribution_id") REFERENCES "external_agent_attributions"("organization_id","id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "external_agent_review_evidence" ADD CONSTRAINT "fk_external_agent_review_subject_session" FOREIGN KEY ("organization_id","subject_principal_id","subject_session_id") REFERENCES "external_agent_sessions"("organization_id","principal_id","id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "external_agent_review_evidence" ADD CONSTRAINT "fk_external_agent_review_reviewer_session" FOREIGN KEY ("organization_id","reviewer_principal_id","reviewer_session_id") REFERENCES "external_agent_sessions"("organization_id","principal_id","id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "external_agent_review_evidence" ADD CONSTRAINT "fk_external_agent_review_work_item_org" FOREIGN KEY ("organization_id","work_item_id") REFERENCES "work_items"("org_id","id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "external_agent_sessions" ADD CONSTRAINT "external_agent_sessions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "external_agent_sessions" ADD CONSTRAINT "fk_external_agent_session_principal_org" FOREIGN KEY ("organization_id","principal_id") REFERENCES "external_agent_principals"("organization_id","id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "external_agent_workload_token_uses" ADD CONSTRAINT "external_agent_workload_token_uses_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "external_agent_workload_token_uses" ADD CONSTRAINT "fk_external_agent_workload_use_principal_org" FOREIGN KEY ("organization_id","principal_id") REFERENCES "external_agent_principals"("organization_id","id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "graph_retrieval_benchmark_cases" ADD CONSTRAINT "graph_retrieval_benchmark_cases_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "graph_retrieval_benchmark_cases" ADD CONSTRAINT "graph_retrieval_benchmark_cases_suite_id_graph_retrieval_benchmark_suites_id_fk" FOREIGN KEY ("suite_id") REFERENCES "graph_retrieval_benchmark_suites"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "graph_retrieval_benchmark_results" ADD CONSTRAINT "graph_retrieval_benchmark_results_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "graph_retrieval_benchmark_results" ADD CONSTRAINT "graph_retrieval_benchmark_results_run_id_graph_retrieval_benchmark_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "graph_retrieval_benchmark_runs"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "graph_retrieval_benchmark_results" ADD CONSTRAINT "graph_retrieval_benchmark_results_case_id_graph_retrieval_benchmark_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "graph_retrieval_benchmark_cases"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "graph_retrieval_benchmark_runs" ADD CONSTRAINT "graph_retrieval_benchmark_runs_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "graph_retrieval_benchmark_runs" ADD CONSTRAINT "graph_retrieval_benchmark_runs_suite_id_graph_retrieval_benchmark_suites_id_fk" FOREIGN KEY ("suite_id") REFERENCES "graph_retrieval_benchmark_suites"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "graph_retrieval_benchmark_suites" ADD CONSTRAINT "graph_retrieval_benchmark_suites_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "graph_retrieval_graduation_evaluations" ADD CONSTRAINT "graph_retrieval_graduation_evaluations_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "graph_retrieval_graduation_evaluations" ADD CONSTRAINT "graph_retrieval_graduation_evaluations_suite_id_graph_retrieval_benchmark_suites_id_fk" FOREIGN KEY ("suite_id") REFERENCES "graph_retrieval_benchmark_suites"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "graph_retrieval_graduation_evaluations" ADD CONSTRAINT "graph_retrieval_graduation_evaluations_baseline_run_id_graph_retrieval_benchmark_runs_id_fk" FOREIGN KEY ("baseline_run_id") REFERENCES "graph_retrieval_benchmark_runs"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "graph_retrieval_graduation_evaluations" ADD CONSTRAINT "graph_retrieval_graduation_evaluations_graph_run_id_graph_retrieval_benchmark_runs_id_fk" FOREIGN KEY ("graph_run_id") REFERENCES "graph_retrieval_benchmark_runs"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "harness_eval_results" ADD CONSTRAINT "harness_eval_results_tedi_id_tedis_id_fk" FOREIGN KEY ("tedi_id") REFERENCES "tedis"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "harness_eval_results" ADD CONSTRAINT "harness_eval_results_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "harness_eval_runs" ADD CONSTRAINT "harness_eval_runs_tedi_id_tedis_id_fk" FOREIGN KEY ("tedi_id") REFERENCES "tedis"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "harness_eval_runs" ADD CONSTRAINT "harness_eval_runs_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "harness_subject_eval_results" ADD CONSTRAINT "harness_subject_eval_results_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "harness_subject_eval_runs" ADD CONSTRAINT "harness_subject_eval_runs_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "harness_subject_trace_bundles" ADD CONSTRAINT "harness_subject_trace_bundles_tedi_id_tedis_id_fk" FOREIGN KEY ("tedi_id") REFERENCES "tedis"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "harness_subject_trace_bundles" ADD CONSTRAINT "harness_subject_trace_bundles_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "harness_subject_versions" ADD CONSTRAINT "harness_subject_versions_tedi_id_tedis_id_fk" FOREIGN KEY ("tedi_id") REFERENCES "tedis"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "harness_subject_versions" ADD CONSTRAINT "harness_subject_versions_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "harness_versions" ADD CONSTRAINT "harness_versions_tedi_id_tedis_id_fk" FOREIGN KEY ("tedi_id") REFERENCES "tedis"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "harness_versions" ADD CONSTRAINT "harness_versions_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "items" ADD CONSTRAINT "items_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "apps"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "apps"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "kernel_conversation_artifact_pins" ADD CONSTRAINT "kernel_conversation_artifact_pins_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "kernel_conversation_artifact_pins" ADD CONSTRAINT "kernel_conversation_artifact_pins_artifact_id_tedi_artifacts_id_fk" FOREIGN KEY ("artifact_id") REFERENCES "tedi_artifacts"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "kernel_conversation_capabilities" ADD CONSTRAINT "kernel_conversation_capabilities_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "kernel_conversation_capabilities" ADD CONSTRAINT "kernel_conversation_capabilities_capability_id_org_capabilities_id_fk" FOREIGN KEY ("capability_id") REFERENCES "org_capabilities"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "kernel_conversation_grants" ADD CONSTRAINT "kernel_conversation_grants_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "kernel_conversation_session_policies" ADD CONSTRAINT "kernel_conversation_session_policies_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "kernel_conversations" ADD CONSTRAINT "kernel_conversations_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "kernel_home_approval_mirrors" ADD CONSTRAINT "kernel_home_approval_mirrors_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "kernel_home_approval_mirrors" ADD CONSTRAINT "kernel_home_approval_mirrors_approval_request_id_tedi_approval_requests_id_fk" FOREIGN KEY ("approval_request_id") REFERENCES "tedi_approval_requests"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "kernel_home_approval_mirrors" ADD CONSTRAINT "kernel_home_approval_mirrors_delegated_tedi_id_tedis_id_fk" FOREIGN KEY ("delegated_tedi_id") REFERENCES "tedis"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "kernel_request_events" ADD CONSTRAINT "kernel_request_events_request_id_kernel_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "kernel_requests"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "kernel_requests" ADD CONSTRAINT "kernel_requests_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "kernel_runtime_events" ADD CONSTRAINT "kernel_runtime_events_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "kernel_runtime_events" ADD CONSTRAINT "kernel_runtime_events_delegated_tedi_id_tedis_id_fk" FOREIGN KEY ("delegated_tedi_id") REFERENCES "tedis"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "kernel_runtime_runs" ADD CONSTRAINT "kernel_runtime_runs_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "kernel_runtime_runs" ADD CONSTRAINT "kernel_runtime_runs_delegated_tedi_id_tedis_id_fk" FOREIGN KEY ("delegated_tedi_id") REFERENCES "tedis"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "kernel_tool_results" ADD CONSTRAINT "kernel_tool_results_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "kernel_wake_queue" ADD CONSTRAINT "kernel_wake_queue_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "knowledge_entries" ADD CONSTRAINT "knowledge_entries_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "knowledge_entries" ADD CONSTRAINT "knowledge_entries_tedi_id_tedis_id_fk" FOREIGN KEY ("tedi_id") REFERENCES "tedis"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "knowledge_entries" ADD CONSTRAINT "knowledge_entries_domain_id_memory_domains_id_fk" FOREIGN KEY ("domain_id") REFERENCES "memory_domains"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "learning_feedback_attributions" ADD CONSTRAINT "learning_feedback_attributions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "learning_feedback_attributions" ADD CONSTRAINT "learning_feedback_attributions_feedback_event_id_learning_interaction_events_id_fk" FOREIGN KEY ("feedback_event_id") REFERENCES "learning_interaction_events"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "learning_feedback_measurements" ADD CONSTRAINT "learning_feedback_measurements_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "learning_feedback_measurements" ADD CONSTRAINT "learning_feedback_measurements_attribution_id_learning_feedback_attributions_id_fk" FOREIGN KEY ("attribution_id") REFERENCES "learning_feedback_attributions"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "learning_improvement_proposals" ADD CONSTRAINT "learning_improvement_proposals_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "learning_improvement_proposals" ADD CONSTRAINT "learning_improvement_proposals_tedi_id_tedis_id_fk" FOREIGN KEY ("tedi_id") REFERENCES "tedis"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "learning_improvement_proposals" ADD CONSTRAINT "learning_improvement_proposals_attribution_id_learning_feedback_attributions_id_fk" FOREIGN KEY ("attribution_id") REFERENCES "learning_feedback_attributions"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "learning_improvement_proposals" ADD CONSTRAINT "learning_improvement_proposals_baseline_measurement_id_learning_feedback_measurements_id_fk" FOREIGN KEY ("baseline_measurement_id") REFERENCES "learning_feedback_measurements"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "learning_improvement_proposals" ADD CONSTRAINT "learning_improvement_proposals_followup_measurement_id_learning_feedback_measurements_id_fk" FOREIGN KEY ("followup_measurement_id") REFERENCES "learning_feedback_measurements"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "learning_interaction_events" ADD CONSTRAINT "learning_interaction_events_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "learning_interaction_events" ADD CONSTRAINT "learning_interaction_events_tedi_id_tedis_id_fk" FOREIGN KEY ("tedi_id") REFERENCES "tedis"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "machine_provider_probe_authorizations" ADD CONSTRAINT "machine_provider_probe_authorizations_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "machine_provider_probe_results" ADD CONSTRAINT "machine_provider_probe_results_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "machine_tool_calls" ADD CONSTRAINT "machine_tool_calls_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "machine_tool_polls" ADD CONSTRAINT "machine_tool_polls_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "mcp_payment_accounts" ADD CONSTRAINT "mcp_payment_accounts_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "mcp_payment_accounts" ADD CONSTRAINT "mcp_payment_accounts_tedi_id_tedis_id_fk" FOREIGN KEY ("tedi_id") REFERENCES "tedis"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "mcp_payment_events" ADD CONSTRAINT "mcp_payment_events_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "apps"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "mcp_payment_events" ADD CONSTRAINT "mcp_payment_events_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "mcp_payment_events" ADD CONSTRAINT "mcp_payment_events_tedi_id_tedis_id_fk" FOREIGN KEY ("tedi_id") REFERENCES "tedis"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "mcp_payment_policies" ADD CONSTRAINT "mcp_payment_policies_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "mcp_payment_policies" ADD CONSTRAINT "mcp_payment_policies_tedi_id_tedis_id_fk" FOREIGN KEY ("tedi_id") REFERENCES "tedis"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "mcp_payment_reservations" ADD CONSTRAINT "mcp_payment_reservations_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "mcp_payment_reservations" ADD CONSTRAINT "mcp_payment_reservations_tedi_id_tedis_id_fk" FOREIGN KEY ("tedi_id") REFERENCES "tedis"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "mcp_payment_reservations" ADD CONSTRAINT "mcp_payment_reservations_account_id_mcp_payment_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "mcp_payment_accounts"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "mcp_payment_reservations" ADD CONSTRAINT "mcp_payment_reservations_policy_id_mcp_payment_policies_id_fk" FOREIGN KEY ("policy_id") REFERENCES "mcp_payment_policies"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "mcp_tool_approval_grants" ADD CONSTRAINT "mcp_tool_approval_grants_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "memory_domains" ADD CONSTRAINT "memory_domains_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "memory_edge_org_counts" ADD CONSTRAINT "memory_edge_org_counts_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "memory_edges" ADD CONSTRAINT "memory_edges_source_fact_id_memory_facts_id_fk" FOREIGN KEY ("source_fact_id") REFERENCES "memory_facts"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "memory_edges" ADD CONSTRAINT "memory_edges_target_fact_id_memory_facts_id_fk" FOREIGN KEY ("target_fact_id") REFERENCES "memory_facts"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "memory_entities" ADD CONSTRAINT "memory_entities_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "memory_entities" ADD CONSTRAINT "memory_entities_merged_into_entity_id_memory_entities_id_fk" FOREIGN KEY ("merged_into_entity_id") REFERENCES "memory_entities"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "memory_entity_aliases" ADD CONSTRAINT "memory_entity_aliases_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "memory_entity_aliases" ADD CONSTRAINT "memory_entity_aliases_entity_id_memory_entities_id_fk" FOREIGN KEY ("entity_id") REFERENCES "memory_entities"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "memory_entity_aliases" ADD CONSTRAINT "memory_entity_aliases_source_mention_id_memory_entity_mentions_id_fk" FOREIGN KEY ("source_mention_id") REFERENCES "memory_entity_mentions"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "memory_entity_mentions" ADD CONSTRAINT "memory_entity_mentions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "memory_entity_mentions" ADD CONSTRAINT "memory_entity_mentions_source_fact_id_memory_facts_id_fk" FOREIGN KEY ("source_fact_id") REFERENCES "memory_facts"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "memory_entity_resolution_decisions" ADD CONSTRAINT "memory_entity_resolution_decisions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "memory_entity_resolution_decisions" ADD CONSTRAINT "memory_entity_resolution_decisions_mention_id_memory_entity_mentions_id_fk" FOREIGN KEY ("mention_id") REFERENCES "memory_entity_mentions"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "memory_entity_resolution_decisions" ADD CONSTRAINT "memory_entity_resolution_decisions_alias_id_memory_entity_aliases_id_fk" FOREIGN KEY ("alias_id") REFERENCES "memory_entity_aliases"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "memory_entity_resolution_decisions" ADD CONSTRAINT "memory_entity_resolution_decisions_source_entity_id_memory_entities_id_fk" FOREIGN KEY ("source_entity_id") REFERENCES "memory_entities"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "memory_entity_resolution_decisions" ADD CONSTRAINT "memory_entity_resolution_decisions_target_entity_id_memory_entities_id_fk" FOREIGN KEY ("target_entity_id") REFERENCES "memory_entities"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "memory_entity_resolution_decisions" ADD CONSTRAINT "memory_entity_resolution_decisions_supersedes_decision_id_memory_entity_resolution_decisions_id_fk" FOREIGN KEY ("supersedes_decision_id") REFERENCES "memory_entity_resolution_decisions"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "memory_entity_resolution_decisions" ADD CONSTRAINT "memory_entity_resolution_decisions_rollback_of_decision_id_memory_entity_resolution_decisions_id_fk" FOREIGN KEY ("rollback_of_decision_id") REFERENCES "memory_entity_resolution_decisions"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "memory_entity_resolution_heads" ADD CONSTRAINT "memory_entity_resolution_heads_mention_id_memory_entity_mentions_id_fk" FOREIGN KEY ("mention_id") REFERENCES "memory_entity_mentions"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "memory_entity_resolution_heads" ADD CONSTRAINT "memory_entity_resolution_heads_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "memory_entity_resolution_heads" ADD CONSTRAINT "memory_entity_resolution_heads_current_entity_id_memory_entities_id_fk" FOREIGN KEY ("current_entity_id") REFERENCES "memory_entities"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "memory_entity_resolutions" ADD CONSTRAINT "memory_entity_resolutions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "memory_entity_resolutions" ADD CONSTRAINT "memory_entity_resolutions_mention_id_memory_entity_mentions_id_fk" FOREIGN KEY ("mention_id") REFERENCES "memory_entity_mentions"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "memory_entity_resolutions" ADD CONSTRAINT "memory_entity_resolutions_entity_id_memory_entities_id_fk" FOREIGN KEY ("entity_id") REFERENCES "memory_entities"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "memory_entity_resolutions" ADD CONSTRAINT "memory_entity_resolutions_decision_id_memory_entity_resolution_decisions_id_fk" FOREIGN KEY ("decision_id") REFERENCES "memory_entity_resolution_decisions"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "memory_fact_citation_backfills" ADD CONSTRAINT "memory_fact_citation_backfills_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "memory_fact_citations" ADD CONSTRAINT "memory_fact_citations_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "memory_fact_citations" ADD CONSTRAINT "memory_fact_citations_consolidated_fact_id_memory_facts_id_fk" FOREIGN KEY ("consolidated_fact_id") REFERENCES "memory_facts"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "memory_fact_org_counts" ADD CONSTRAINT "memory_fact_org_counts_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "memory_facts" ADD CONSTRAINT "memory_facts_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "memory_facts" ADD CONSTRAINT "memory_facts_tedi_id_tedis_id_fk" FOREIGN KEY ("tedi_id") REFERENCES "tedis"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "memory_facts" ADD CONSTRAINT "memory_facts_domain_id_memory_domains_id_fk" FOREIGN KEY ("domain_id") REFERENCES "memory_domains"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "oidc_sessions" ADD CONSTRAINT "oidc_sessions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "org_capabilities" ADD CONSTRAINT "org_capabilities_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "org_capabilities" ADD CONSTRAINT "org_capabilities_parent_id_org_capabilities_id_fk" FOREIGN KEY ("parent_id") REFERENCES "org_capabilities"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "organization_members" ADD CONSTRAINT "organization_members_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "organization_purpose_charters" ADD CONSTRAINT "organization_purpose_charters_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "organization_residency_policies" ADD CONSTRAINT "organization_residency_policies_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "organization_secrets" ADD CONSTRAINT "organization_secrets_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "os_approval_rules" ADD CONSTRAINT "os_approval_rules_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "os_blueprint_revisions" ADD CONSTRAINT "os_blueprint_revisions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "os_blueprint_revisions" ADD CONSTRAINT "os_blueprint_revisions_blueprint_id_os_blueprints_id_fk" FOREIGN KEY ("blueprint_id") REFERENCES "os_blueprints"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "os_blueprints" ADD CONSTRAINT "os_blueprints_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "os_collaboration_proposals" ADD CONSTRAINT "os_collaboration_proposals_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "os_collaboration_proposals" ADD CONSTRAINT "os_collaboration_proposals_workspace_id_os_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "os_workspaces"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "os_gadget_code" ADD CONSTRAINT "os_gadget_code_revision_id_os_gadget_revisions_id_fk" FOREIGN KEY ("revision_id") REFERENCES "os_gadget_revisions"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "os_gadget_code" ADD CONSTRAINT "os_gadget_code_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "os_gadget_code" ADD CONSTRAINT "os_gadget_code_gadget_id_os_gadgets_id_fk" FOREIGN KEY ("gadget_id") REFERENCES "os_gadgets"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "os_gadget_code_blobs" ADD CONSTRAINT "os_gadget_code_blobs_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "os_gadget_executions" ADD CONSTRAINT "os_gadget_executions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "os_gadget_revisions" ADD CONSTRAINT "os_gadget_revisions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "os_gadget_revisions" ADD CONSTRAINT "os_gadget_revisions_gadget_id_os_gadgets_id_fk" FOREIGN KEY ("gadget_id") REFERENCES "os_gadgets"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "os_gadget_state" ADD CONSTRAINT "os_gadget_state_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "os_gadget_state" ADD CONSTRAINT "os_gadget_state_gadget_id_os_gadgets_id_fk" FOREIGN KEY ("gadget_id") REFERENCES "os_gadgets"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "os_gadget_state_mutations" ADD CONSTRAINT "os_gadget_state_mutations_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "os_gadget_state_mutations" ADD CONSTRAINT "os_gadget_state_mutations_gadget_id_os_gadgets_id_fk" FOREIGN KEY ("gadget_id") REFERENCES "os_gadgets"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "os_gadgets" ADD CONSTRAINT "os_gadgets_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "os_gadgets" ADD CONSTRAINT "os_gadgets_workspace_id_os_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "os_workspaces"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "os_review_batches" ADD CONSTRAINT "os_review_batches_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "os_review_batches" ADD CONSTRAINT "os_review_batches_share_link_id_os_share_links_id_fk" FOREIGN KEY ("share_link_id") REFERENCES "os_share_links"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "os_review_feedback" ADD CONSTRAINT "os_review_feedback_batch_id_os_review_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "os_review_batches"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "os_share_email_codes" ADD CONSTRAINT "os_share_email_codes_share_link_id_os_share_links_id_fk" FOREIGN KEY ("share_link_id") REFERENCES "os_share_links"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "os_share_link_invitees" ADD CONSTRAINT "os_share_link_invitees_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "os_share_link_invitees" ADD CONSTRAINT "os_share_link_invitees_share_link_id_os_share_links_id_fk" FOREIGN KEY ("share_link_id") REFERENCES "os_share_links"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "os_share_links" ADD CONSTRAINT "os_share_links_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "os_share_sessions" ADD CONSTRAINT "os_share_sessions_share_link_id_os_share_links_id_fk" FOREIGN KEY ("share_link_id") REFERENCES "os_share_links"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "os_share_skill_read_grants" ADD CONSTRAINT "os_share_skill_read_grants_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "os_share_skill_read_grants" ADD CONSTRAINT "os_share_skill_read_grants_share_link_id_os_share_links_id_fk" FOREIGN KEY ("share_link_id") REFERENCES "os_share_links"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "os_workspace_access_edges" ADD CONSTRAINT "os_workspace_access_edges_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "os_workspace_collaborators" ADD CONSTRAINT "os_workspace_collaborators_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "os_workspace_projects" ADD CONSTRAINT "os_workspace_projects_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "os_workspace_projects" ADD CONSTRAINT "os_workspace_projects_workspace_fk" FOREIGN KEY ("organization_id","workspace_id") REFERENCES "os_workspaces"("organization_id","id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "os_workspace_projects" ADD CONSTRAINT "os_workspace_projects_project_fk" FOREIGN KEY ("organization_id","project_id") REFERENCES "projects"("org_id","id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "os_workspace_resources" ADD CONSTRAINT "os_workspace_resources_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "os_workspace_resources" ADD CONSTRAINT "os_workspace_resources_workspace_id_os_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "os_workspaces"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "os_workspace_share_keys" ADD CONSTRAINT "os_workspace_share_keys_link_id_os_workspace_share_links_id_fk" FOREIGN KEY ("link_id") REFERENCES "os_workspace_share_links"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "os_workspace_share_links" ADD CONSTRAINT "os_workspace_share_links_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "os_workspace_summaries" ADD CONSTRAINT "os_workspace_summaries_workspace_id_os_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "os_workspaces"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "os_workspace_summaries" ADD CONSTRAINT "os_workspace_summaries_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "os_workspaces" ADD CONSTRAINT "os_workspaces_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "personal_agent_client_rates" ADD CONSTRAINT "personal_agent_client_rates_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "personal_agent_sessions" ADD CONSTRAINT "personal_agent_sessions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "policy_packs" ADD CONSTRAINT "policy_packs_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "policy_packs" ADD CONSTRAINT "policy_packs_supersedes_revision_id_policy_packs_id_fk" FOREIGN KEY ("supersedes_revision_id") REFERENCES "policy_packs"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "policy_packs" ADD CONSTRAINT "policy_packs_rollback_of_revision_id_policy_packs_id_fk" FOREIGN KEY ("rollback_of_revision_id") REFERENCES "policy_packs"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "principal_identities" ADD CONSTRAINT "principal_identities_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_lead_tedi_id_tedis_id_fk" FOREIGN KEY ("lead_tedi_id") REFERENCES "tedis"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_objective_id_tedi_objectives_id_fk" FOREIGN KEY ("objective_id") REFERENCES "tedi_objectives"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "promotion_decision_observations" ADD CONSTRAINT "promotion_decision_observations_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "promotion_decision_observations" ADD CONSTRAINT "promotion_decision_observations_decision_id_promotion_decisions_id_fk" FOREIGN KEY ("decision_id") REFERENCES "promotion_decisions"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "promotion_decision_observations" ADD CONSTRAINT "promotion_decision_observations_observation_id_competency_observations_id_fk" FOREIGN KEY ("observation_id") REFERENCES "competency_observations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "promotion_decisions" ADD CONSTRAINT "promotion_decisions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "promotion_decisions" ADD CONSTRAINT "promotion_decisions_tedi_id_tedis_id_fk" FOREIGN KEY ("tedi_id") REFERENCES "tedis"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "promotion_decisions" ADD CONSTRAINT "promotion_decisions_role_assignment_id_tedi_role_assignments_id_fk" FOREIGN KEY ("role_assignment_id") REFERENCES "tedi_role_assignments"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "promotion_decisions" ADD CONSTRAINT "promotion_decisions_activity_id_entrustable_activities_id_fk" FOREIGN KEY ("activity_id") REFERENCES "entrustable_activities"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "provider_installations" ADD CONSTRAINT "provider_installations_provider_organization_id_organizations_id_fk" FOREIGN KEY ("provider_organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "provider_installations" ADD CONSTRAINT "provider_installations_provider_app_id_apps_id_fk" FOREIGN KEY ("provider_app_id") REFERENCES "apps"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "provider_installations" ADD CONSTRAINT "provider_installations_provider_api_key_id_api_keys_id_fk" FOREIGN KEY ("provider_api_key_id") REFERENCES "api_keys"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "provider_installations" ADD CONSTRAINT "provider_installations_customer_organization_id_organizations_id_fk" FOREIGN KEY ("customer_organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "provider_installations" ADD CONSTRAINT "provider_installations_primary_workspace_id_os_workspaces_id_fk" FOREIGN KEY ("primary_workspace_id") REFERENCES "os_workspaces"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "provider_installations" ADD CONSTRAINT "provider_installations_primary_tedi_id_tedis_id_fk" FOREIGN KEY ("primary_tedi_id") REFERENCES "tedis"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "provider_model_rate_versions" ADD CONSTRAINT "provider_model_rate_versions_supersedes_rate_version_id_provider_model_rate_versions_id_fk" FOREIGN KEY ("supersedes_rate_version_id") REFERENCES "provider_model_rate_versions"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "provider_probe_receipts" ADD CONSTRAINT "provider_probe_receipts_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "provider_probe_results" ADD CONSTRAINT "provider_probe_results_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "rationale_org_counts" ADD CONSTRAINT "rationale_org_counts_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "role_templates" ADD CONSTRAINT "role_templates_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "runtime_profiles" ADD CONSTRAINT "runtime_profiles_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "runtime_profiles" ADD CONSTRAINT "runtime_profiles_supersedes_revision_id_runtime_profiles_id_fk" FOREIGN KEY ("supersedes_revision_id") REFERENCES "runtime_profiles"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "runtime_profiles" ADD CONSTRAINT "runtime_profiles_rollback_of_revision_id_runtime_profiles_id_fk" FOREIGN KEY ("rollback_of_revision_id") REFERENCES "runtime_profiles"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "runtime_submission_attempts" ADD CONSTRAINT "runtime_submission_attempts_submission_id_runtime_submissions_id_fk" FOREIGN KEY ("submission_id") REFERENCES "runtime_submissions"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "runtime_submission_attempts" ADD CONSTRAINT "runtime_submission_attempts_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "runtime_submissions" ADD CONSTRAINT "runtime_submissions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "runtime_submissions" ADD CONSTRAINT "runtime_submissions_tedi_id_tedis_id_fk" FOREIGN KEY ("tedi_id") REFERENCES "tedis"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "site_reconciliation_findings" ADD CONSTRAINT "site_reconciliation_findings_run_id_site_reconciliation_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "site_reconciliation_runs"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "site_reconciliation_findings" ADD CONSTRAINT "site_reconciliation_findings_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "site_reconciliation_runs" ADD CONSTRAINT "site_reconciliation_runs_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "skill_entries" ADD CONSTRAINT "skill_entries_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "skill_entries" ADD CONSTRAINT "skill_entries_tedi_id_tedis_id_fk" FOREIGN KEY ("tedi_id") REFERENCES "tedis"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "skill_entries" ADD CONSTRAINT "skill_entries_domain_id_memory_domains_id_fk" FOREIGN KEY ("domain_id") REFERENCES "memory_domains"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "skill_entries" ADD CONSTRAINT "skill_entries_source_skill_id_skill_entries_id_fk" FOREIGN KEY ("source_skill_id") REFERENCES "skill_entries"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "skill_entries" ADD CONSTRAINT "skill_entries_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "apps"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "skill_run_artifacts" ADD CONSTRAINT "skill_run_artifacts_run_id_skill_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "skill_runs"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "skill_run_effect_observations" ADD CONSTRAINT "skill_run_effect_observations_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "skill_run_effect_observations" ADD CONSTRAINT "skill_run_effect_observations_skill_run_id_skill_runs_id_fk" FOREIGN KEY ("skill_run_id") REFERENCES "skill_runs"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "skill_run_effect_observations" ADD CONSTRAINT "skill_run_effect_observations_work_item_id_work_items_id_fk" FOREIGN KEY ("work_item_id") REFERENCES "work_items"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "skill_runs" ADD CONSTRAINT "skill_runs_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "skill_runs" ADD CONSTRAINT "skill_runs_skill_id_skill_entries_id_fk" FOREIGN KEY ("skill_id") REFERENCES "skill_entries"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "skill_runs" ADD CONSTRAINT "skill_runs_tedi_id_tedis_id_fk" FOREIGN KEY ("tedi_id") REFERENCES "tedis"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "skill_schedules" ADD CONSTRAINT "skill_schedules_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "skill_schedules" ADD CONSTRAINT "skill_schedules_skill_id_skill_entries_id_fk" FOREIGN KEY ("skill_id") REFERENCES "skill_entries"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "skill_schedules" ADD CONSTRAINT "skill_schedules_tedi_id_tedis_id_fk" FOREIGN KEY ("tedi_id") REFERENCES "tedis"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "skill_usage_events" ADD CONSTRAINT "skill_usage_events_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "skill_usage_events" ADD CONSTRAINT "skill_usage_events_tedi_id_tedis_id_fk" FOREIGN KEY ("tedi_id") REFERENCES "tedis"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "skill_usage_events" ADD CONSTRAINT "skill_usage_events_skill_id_skill_entries_id_fk" FOREIGN KEY ("skill_id") REFERENCES "skill_entries"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "skill_workflow_sources" ADD CONSTRAINT "skill_workflow_sources_skill_id_skill_entries_id_fk" FOREIGN KEY ("skill_id") REFERENCES "skill_entries"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "tedi_approval_dependency_events" ADD CONSTRAINT "tedi_approval_dependency_events_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "tedi_approval_dependency_events" ADD CONSTRAINT "tedi_approval_dependency_events_dependent_approval_request_id_tedi_approval_requests_id_fk" FOREIGN KEY ("dependent_approval_request_id") REFERENCES "tedi_approval_requests"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "tedi_approval_dependency_events" ADD CONSTRAINT "tedi_approval_dependency_events_prerequisite_approval_request_id_tedi_approval_requests_id_fk" FOREIGN KEY ("prerequisite_approval_request_id") REFERENCES "tedi_approval_requests"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "tedi_approval_dependency_events" ADD CONSTRAINT "tedi_approval_dependency_events_simulation_id_tedi_approval_simulations_id_fk" FOREIGN KEY ("simulation_id") REFERENCES "tedi_approval_simulations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "tedi_approval_dependency_events" ADD CONSTRAINT "tedi_approval_dependency_events_invalidates_event_id_tedi_approval_dependency_events_id_fk" FOREIGN KEY ("invalidates_event_id") REFERENCES "tedi_approval_dependency_events"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "tedi_approval_execution_receipts" ADD CONSTRAINT "tedi_approval_execution_receipts_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "tedi_approval_execution_receipts" ADD CONSTRAINT "tedi_approval_execution_receipts_approval_request_id_tedi_approval_requests_id_fk" FOREIGN KEY ("approval_request_id") REFERENCES "tedi_approval_requests"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "tedi_approval_execution_receipts" ADD CONSTRAINT "tedi_approval_execution_receipts_simulation_id_tedi_approval_simulations_id_fk" FOREIGN KEY ("simulation_id") REFERENCES "tedi_approval_simulations"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "tedi_approval_requests" ADD CONSTRAINT "tedi_approval_requests_tedi_id_tedis_id_fk" FOREIGN KEY ("tedi_id") REFERENCES "tedis"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "tedi_approval_requests" ADD CONSTRAINT "tedi_approval_requests_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "tedi_approval_simulations" ADD CONSTRAINT "tedi_approval_simulations_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "tedi_approval_simulations" ADD CONSTRAINT "tedi_approval_simulations_approval_request_id_tedi_approval_requests_id_fk" FOREIGN KEY ("approval_request_id") REFERENCES "tedi_approval_requests"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "tedi_artifact_contribution_receipts" ADD CONSTRAINT "tedi_artifact_contribution_receipts_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "tedi_artifact_contribution_receipts" ADD CONSTRAINT "tedi_artifact_contribution_receipts_tedi_id_tedis_id_fk" FOREIGN KEY ("tedi_id") REFERENCES "tedis"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "tedi_artifact_contribution_receipts" ADD CONSTRAINT "tedi_artifact_contribution_receipts_artifact_id_tedi_artifacts_id_fk" FOREIGN KEY ("artifact_id") REFERENCES "tedi_artifacts"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "tedi_artifacts" ADD CONSTRAINT "tedi_artifacts_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "tedi_artifacts" ADD CONSTRAINT "tedi_artifacts_tedi_id_tedis_id_fk" FOREIGN KEY ("tedi_id") REFERENCES "tedis"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "tedi_call_costs" ADD CONSTRAINT "tedi_call_costs_tedi_id_tedis_id_fk" FOREIGN KEY ("tedi_id") REFERENCES "tedis"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "tedi_call_costs" ADD CONSTRAINT "tedi_call_costs_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "tedi_console_grants" ADD CONSTRAINT "tedi_console_grants_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "tedi_console_grants" ADD CONSTRAINT "tedi_console_grants_tedi_id_tedis_id_fk" FOREIGN KEY ("tedi_id") REFERENCES "tedis"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "tedi_control_plane_binding_history" ADD CONSTRAINT "tedi_control_plane_binding_history_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "tedi_control_plane_binding_history" ADD CONSTRAINT "tedi_control_plane_binding_history_tedi_id_tedis_id_fk" FOREIGN KEY ("tedi_id") REFERENCES "tedis"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "tedi_cron_executions" ADD CONSTRAINT "tedi_cron_executions_tedi_id_tedis_id_fk" FOREIGN KEY ("tedi_id") REFERENCES "tedis"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "tedi_cron_executions" ADD CONSTRAINT "tedi_cron_executions_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "tedi_curiosity_queue" ADD CONSTRAINT "tedi_curiosity_queue_tedi_id_tedis_id_fk" FOREIGN KEY ("tedi_id") REFERENCES "tedis"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "tedi_curiosity_queue" ADD CONSTRAINT "tedi_curiosity_queue_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "tedi_custom_domains" ADD CONSTRAINT "tedi_custom_domains_tedi_id_tedis_id_fk" FOREIGN KEY ("tedi_id") REFERENCES "tedis"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "tedi_devices" ADD CONSTRAINT "tedi_devices_tedi_id_tedis_id_fk" FOREIGN KEY ("tedi_id") REFERENCES "tedis"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "tedi_email_addresses" ADD CONSTRAINT "tedi_email_addresses_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "tedi_email_addresses" ADD CONSTRAINT "tedi_email_addresses_tedi_id_tedis_id_fk" FOREIGN KEY ("tedi_id") REFERENCES "tedis"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "tedi_email_attachments" ADD CONSTRAINT "tedi_email_attachments_message_id_tedi_email_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "tedi_email_messages"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "tedi_email_events" ADD CONSTRAINT "tedi_email_events_message_id_tedi_email_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "tedi_email_messages"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "tedi_email_events" ADD CONSTRAINT "tedi_email_events_thread_id_tedi_email_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "tedi_email_threads"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "tedi_email_events" ADD CONSTRAINT "tedi_email_events_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "tedi_email_events" ADD CONSTRAINT "tedi_email_events_tedi_id_tedis_id_fk" FOREIGN KEY ("tedi_id") REFERENCES "tedis"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "tedi_email_messages" ADD CONSTRAINT "tedi_email_messages_thread_id_tedi_email_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "tedi_email_threads"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "tedi_email_messages" ADD CONSTRAINT "tedi_email_messages_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "tedi_email_messages" ADD CONSTRAINT "tedi_email_messages_tedi_id_tedis_id_fk" FOREIGN KEY ("tedi_id") REFERENCES "tedis"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "tedi_email_threads" ADD CONSTRAINT "tedi_email_threads_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "tedi_email_threads" ADD CONSTRAINT "tedi_email_threads_tedi_id_tedis_id_fk" FOREIGN KEY ("tedi_id") REFERENCES "tedis"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "tedi_email_trusted_recipients" ADD CONSTRAINT "tedi_email_trusted_recipients_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "tedi_email_trusted_recipients" ADD CONSTRAINT "tedi_email_trusted_recipients_tedi_id_tedis_id_fk" FOREIGN KEY ("tedi_id") REFERENCES "tedis"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "tedi_entrustment_grants" ADD CONSTRAINT "tedi_entrustment_grants_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "tedi_entrustment_grants" ADD CONSTRAINT "tedi_entrustment_grants_tedi_id_tedis_id_fk" FOREIGN KEY ("tedi_id") REFERENCES "tedis"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "tedi_entrustment_grants" ADD CONSTRAINT "tedi_entrustment_grants_role_assignment_id_tedi_role_assignments_id_fk" FOREIGN KEY ("role_assignment_id") REFERENCES "tedi_role_assignments"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "tedi_entrustment_grants" ADD CONSTRAINT "tedi_entrustment_grants_activity_id_entrustable_activities_id_fk" FOREIGN KEY ("activity_id") REFERENCES "entrustable_activities"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "tedi_entrustment_grants" ADD CONSTRAINT "tedi_entrustment_grants_last_decision_id_promotion_decisions_id_fk" FOREIGN KEY ("last_decision_id") REFERENCES "promotion_decisions"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "tedi_expertise" ADD CONSTRAINT "tedi_expertise_tedi_id_tedis_id_fk" FOREIGN KEY ("tedi_id") REFERENCES "tedis"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "tedi_expertise" ADD CONSTRAINT "tedi_expertise_domain_id_memory_domains_id_fk" FOREIGN KEY ("domain_id") REFERENCES "memory_domains"("id");--> statement-breakpoint
ALTER TABLE "tedi_growth_snapshots" ADD CONSTRAINT "tedi_growth_snapshots_tedi_id_tedis_id_fk" FOREIGN KEY ("tedi_id") REFERENCES "tedis"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "tedi_growth_snapshots" ADD CONSTRAINT "tedi_growth_snapshots_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "tedi_memory_documents" ADD CONSTRAINT "tedi_memory_documents_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "tedi_memory_documents" ADD CONSTRAINT "tedi_memory_documents_tedi_id_tedis_id_fk" FOREIGN KEY ("tedi_id") REFERENCES "tedis"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "tedi_muscle_memory" ADD CONSTRAINT "tedi_muscle_memory_tedi_id_tedis_id_fk" FOREIGN KEY ("tedi_id") REFERENCES "tedis"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "tedi_muscle_memory" ADD CONSTRAINT "tedi_muscle_memory_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "tedi_muscle_memory" ADD CONSTRAINT "tedi_muscle_memory_source_skill_id_skill_entries_id_fk" FOREIGN KEY ("source_skill_id") REFERENCES "skill_entries"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "tedi_objectives" ADD CONSTRAINT "tedi_objectives_tedi_id_tedis_id_fk" FOREIGN KEY ("tedi_id") REFERENCES "tedis"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "tedi_objectives" ADD CONSTRAINT "tedi_objectives_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "tedi_optimization_signals" ADD CONSTRAINT "tedi_optimization_signals_tedi_id_tedis_id_fk" FOREIGN KEY ("tedi_id") REFERENCES "tedis"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "tedi_optimization_signals" ADD CONSTRAINT "tedi_optimization_signals_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "tedi_plugin_events" ADD CONSTRAINT "tedi_plugin_events_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "tedi_plugin_events" ADD CONSTRAINT "tedi_plugin_events_plugin_id_tedi_plugins_id_fk" FOREIGN KEY ("plugin_id") REFERENCES "tedi_plugins"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "tedi_plugin_events" ADD CONSTRAINT "tedi_plugin_events_tedi_id_tedis_id_fk" FOREIGN KEY ("tedi_id") REFERENCES "tedis"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "tedi_plugin_installs" ADD CONSTRAINT "tedi_plugin_installs_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "tedi_plugin_installs" ADD CONSTRAINT "tedi_plugin_installs_plugin_id_tedi_plugins_id_fk" FOREIGN KEY ("plugin_id") REFERENCES "tedi_plugins"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "tedi_plugin_installs" ADD CONSTRAINT "tedi_plugin_installs_tedi_id_tedis_id_fk" FOREIGN KEY ("tedi_id") REFERENCES "tedis"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "tedi_plugins" ADD CONSTRAINT "tedi_plugins_author_org_id_organizations_id_fk" FOREIGN KEY ("author_org_id") REFERENCES "organizations"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "tedi_provisional_outcomes" ADD CONSTRAINT "tedi_provisional_outcomes_tedi_id_tedis_id_fk" FOREIGN KEY ("tedi_id") REFERENCES "tedis"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "tedi_provisional_outcomes" ADD CONSTRAINT "tedi_provisional_outcomes_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "tedi_provisional_outcomes" ADD CONSTRAINT "tedi_provisional_outcomes_promotion_approval_request_id_tedi_approval_requests_id_fk" FOREIGN KEY ("promotion_approval_request_id") REFERENCES "tedi_approval_requests"("id");--> statement-breakpoint
ALTER TABLE "tedi_rationale_records" ADD CONSTRAINT "tedi_rationale_records_tedi_id_tedis_id_fk" FOREIGN KEY ("tedi_id") REFERENCES "tedis"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "tedi_rationale_records" ADD CONSTRAINT "tedi_rationale_records_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "tedi_role_assignments" ADD CONSTRAINT "tedi_role_assignments_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "tedi_role_assignments" ADD CONSTRAINT "tedi_role_assignments_tedi_id_tedis_id_fk" FOREIGN KEY ("tedi_id") REFERENCES "tedis"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "tedi_role_assignments" ADD CONSTRAINT "tedi_role_assignments_role_template_id_role_templates_id_fk" FOREIGN KEY ("role_template_id") REFERENCES "role_templates"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "tedi_runtime_events" ADD CONSTRAINT "tedi_runtime_events_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "tedi_runtime_events" ADD CONSTRAINT "tedi_runtime_events_tedi_id_tedis_id_fk" FOREIGN KEY ("tedi_id") REFERENCES "tedis"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "tedi_runtime_leases" ADD CONSTRAINT "tedi_runtime_leases_tedi_id_tedis_id_fk" FOREIGN KEY ("tedi_id") REFERENCES "tedis"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "tedi_runtime_snapshots" ADD CONSTRAINT "tedi_runtime_snapshots_tedi_id_tedis_id_fk" FOREIGN KEY ("tedi_id") REFERENCES "tedis"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "tedi_secrets" ADD CONSTRAINT "tedi_secrets_tedi_id_tedis_id_fk" FOREIGN KEY ("tedi_id") REFERENCES "tedis"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "tedi_session_states" ADD CONSTRAINT "tedi_session_states_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "tedi_session_states" ADD CONSTRAINT "tedi_session_states_tedi_id_tedis_id_fk" FOREIGN KEY ("tedi_id") REFERENCES "tedis"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "tedi_tasks" ADD CONSTRAINT "tedi_tasks_objective_id_tedi_objectives_id_fk" FOREIGN KEY ("objective_id") REFERENCES "tedi_objectives"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "tedi_tasks" ADD CONSTRAINT "tedi_tasks_tedi_id_tedis_id_fk" FOREIGN KEY ("tedi_id") REFERENCES "tedis"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "tedi_tasks" ADD CONSTRAINT "tedi_tasks_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "tedi_usage_events" ADD CONSTRAINT "tedi_usage_events_tedi_id_tedis_id_fk" FOREIGN KEY ("tedi_id") REFERENCES "tedis"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "tedis" ADD CONSTRAINT "tedis_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "tedis" ADD CONSTRAINT "tedis_runtime_profile_id_runtime_profiles_id_fk" FOREIGN KEY ("runtime_profile_id") REFERENCES "runtime_profiles"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "tedis" ADD CONSTRAINT "tedis_policy_pack_id_policy_packs_id_fk" FOREIGN KEY ("policy_pack_id") REFERENCES "policy_packs"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "tedis" ADD CONSTRAINT "tedis_workspace_template_set_id_workspace_template_sets_id_fk" FOREIGN KEY ("workspace_template_set_id") REFERENCES "workspace_template_sets"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "tenant_behavioral_eval_assertion_results" ADD CONSTRAINT "tenant_behavioral_eval_assertion_results_case_run_id_tenant_behavioral_eval_case_runs_id_fk" FOREIGN KEY ("case_run_id") REFERENCES "tenant_behavioral_eval_case_runs"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "tenant_behavioral_eval_case_attempts" ADD CONSTRAINT "tenant_behavioral_eval_case_attempts_case_run_id_tenant_behavioral_eval_case_runs_id_fk" FOREIGN KEY ("case_run_id") REFERENCES "tenant_behavioral_eval_case_runs"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "tenant_behavioral_eval_case_runs" ADD CONSTRAINT "tenant_behavioral_eval_case_runs_run_id_tenant_behavioral_eval_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "tenant_behavioral_eval_runs"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "tenant_behavioral_eval_definitions" ADD CONSTRAINT "tenant_behavioral_eval_definitions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "tenant_behavioral_eval_definitions" ADD CONSTRAINT "tenant_behavioral_eval_definitions_tedi_id_tedis_id_fk" FOREIGN KEY ("tedi_id") REFERENCES "tedis"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "tenant_behavioral_eval_revisions" ADD CONSTRAINT "tenant_behavioral_eval_revisions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "tenant_behavioral_eval_revisions" ADD CONSTRAINT "tenant_behavioral_eval_revisions_definition_id_tenant_behavioral_eval_definitions_id_fk" FOREIGN KEY ("definition_id") REFERENCES "tenant_behavioral_eval_definitions"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "tenant_behavioral_eval_revisions" ADD CONSTRAINT "fk_tbe_revision_definition_org" FOREIGN KEY ("definition_id","organization_id") REFERENCES "tenant_behavioral_eval_definitions"("id","organization_id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "tenant_behavioral_eval_runs" ADD CONSTRAINT "tenant_behavioral_eval_runs_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "tenant_behavioral_eval_runs" ADD CONSTRAINT "tenant_behavioral_eval_runs_definition_id_tenant_behavioral_eval_definitions_id_fk" FOREIGN KEY ("definition_id") REFERENCES "tenant_behavioral_eval_definitions"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "tenant_behavioral_eval_runs" ADD CONSTRAINT "tenant_behavioral_eval_runs_revision_id_tenant_behavioral_eval_revisions_id_fk" FOREIGN KEY ("revision_id") REFERENCES "tenant_behavioral_eval_revisions"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "tenant_behavioral_eval_runs" ADD CONSTRAINT "tenant_behavioral_eval_runs_tedi_id_tedis_id_fk" FOREIGN KEY ("tedi_id") REFERENCES "tedis"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "tenant_behavioral_eval_runs" ADD CONSTRAINT "fk_tbe_run_definition_org" FOREIGN KEY ("definition_id","organization_id") REFERENCES "tenant_behavioral_eval_definitions"("id","organization_id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "tenant_behavioral_eval_runs" ADD CONSTRAINT "fk_tbe_run_revision_org" FOREIGN KEY ("revision_id","organization_id") REFERENCES "tenant_behavioral_eval_revisions"("id","organization_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "tenant_provider_identity_preparations" ADD CONSTRAINT "tenant_provider_identity_preparations_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "tenant_provider_identity_profiles" ADD CONSTRAINT "tenant_provider_identity_profiles_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "tenant_tool_policies" ADD CONSTRAINT "tenant_tool_policies_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "tenant_tool_policies" ADD CONSTRAINT "tenant_tool_policies_tool_row_id_app_tools_id_fk" FOREIGN KEY ("tool_row_id") REFERENCES "app_tools"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "tenant_tool_policy_mount_revisions" ADD CONSTRAINT "tenant_tool_policy_mount_revisions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "tenant_tool_policy_preparations" ADD CONSTRAINT "tenant_tool_policy_preparations_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "tenant_tool_policy_resource_generations" ADD CONSTRAINT "tenant_tool_policy_resource_generations_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "trace_bundles" ADD CONSTRAINT "trace_bundles_tedi_id_tedis_id_fk" FOREIGN KEY ("tedi_id") REFERENCES "tedis"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "trace_bundles" ADD CONSTRAINT "trace_bundles_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "upstream_drift_reports" ADD CONSTRAINT "upstream_drift_reports_catalog_app_id_app_catalog_id_fk" FOREIGN KEY ("catalog_app_id") REFERENCES "app_catalog"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "widget_events" ADD CONSTRAINT "widget_events_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "widget_events" ADD CONSTRAINT "widget_events_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "apps"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "widget_events" ADD CONSTRAINT "widget_events_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "items"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "work_admissions" ADD CONSTRAINT "work_admissions_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "work_admissions" ADD CONSTRAINT "fk_work_admission_item" FOREIGN KEY ("org_id","work_item_id") REFERENCES "work_items"("org_id","id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "work_agent_sessions" ADD CONSTRAINT "work_agent_sessions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "work_approval_decisions" ADD CONSTRAINT "work_approval_decisions_proposal_id_work_approval_proposals_id_fk" FOREIGN KEY ("proposal_id") REFERENCES "work_approval_proposals"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "work_approval_executions" ADD CONSTRAINT "work_approval_executions_proposal_id_work_approval_proposals_id_fk" FOREIGN KEY ("proposal_id") REFERENCES "work_approval_proposals"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "work_approval_executions" ADD CONSTRAINT "work_approval_executions_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "work_approval_proposals" ADD CONSTRAINT "work_approval_proposals_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "work_approval_proposals" ADD CONSTRAINT "fk_work_approval_proposal_item" FOREIGN KEY ("org_id","work_item_id") REFERENCES "work_items"("org_id","id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "work_attempt_messages" ADD CONSTRAINT "work_attempt_messages_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "work_attempt_steps" ADD CONSTRAINT "work_attempt_steps_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "work_attempts" ADD CONSTRAINT "work_attempts_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "work_attempts" ADD CONSTRAINT "fk_work_attempt_item_org" FOREIGN KEY ("org_id","work_item_id") REFERENCES "work_items"("org_id","id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "work_budget_envelopes" ADD CONSTRAINT "work_budget_envelopes_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "work_budget_reservations" ADD CONSTRAINT "fk_work_budget_reservation_admission" FOREIGN KEY ("org_id","work_item_id","admission_id") REFERENCES "work_admissions"("org_id","work_item_id","id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "work_budget_reservations" ADD CONSTRAINT "fk_work_budget_reservation_envelope" FOREIGN KEY ("org_id","envelope_id") REFERENCES "work_budget_envelopes"("org_id","id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "work_case_dependencies" ADD CONSTRAINT "work_case_dependencies_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "work_case_dependencies" ADD CONSTRAINT "fk_work_case_dependency_from" FOREIGN KEY ("org_id","prerequisite_case_id") REFERENCES "work_cases"("org_id","id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "work_case_dependencies" ADD CONSTRAINT "fk_work_case_dependency_to" FOREIGN KEY ("org_id","dependent_case_id") REFERENCES "work_cases"("org_id","id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "work_case_items" ADD CONSTRAINT "fk_work_case_item_case" FOREIGN KEY ("org_id","case_id") REFERENCES "work_cases"("org_id","id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "work_case_items" ADD CONSTRAINT "fk_work_case_item_work" FOREIGN KEY ("org_id","work_item_id") REFERENCES "work_items"("org_id","id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "work_cases" ADD CONSTRAINT "work_cases_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "work_cases" ADD CONSTRAINT "fk_work_case_project" FOREIGN KEY ("org_id","project_id") REFERENCES "projects"("org_id","id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "work_events" ADD CONSTRAINT "work_events_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "work_events" ADD CONSTRAINT "work_events_attempt_id_work_attempts_id_fk" FOREIGN KEY ("attempt_id") REFERENCES "work_attempts"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "work_events" ADD CONSTRAINT "fk_work_event_item_org" FOREIGN KEY ("org_id","work_item_id") REFERENCES "work_items"("org_id","id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "work_evidence" ADD CONSTRAINT "work_evidence_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "work_evidence" ADD CONSTRAINT "work_evidence_attempt_id_work_attempts_id_fk" FOREIGN KEY ("attempt_id") REFERENCES "work_attempts"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "work_evidence" ADD CONSTRAINT "fk_work_evidence_item_org" FOREIGN KEY ("org_id","work_item_id") REFERENCES "work_items"("org_id","id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "work_evidence_verifications" ADD CONSTRAINT "work_evidence_verifications_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "work_evidence_verifications" ADD CONSTRAINT "work_evidence_verifications_evidence_id_work_evidence_id_fk" FOREIGN KEY ("evidence_id") REFERENCES "work_evidence"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "work_evidence_verifications" ADD CONSTRAINT "fk_work_evidence_verification_item_org" FOREIGN KEY ("org_id","work_item_id") REFERENCES "work_items"("org_id","id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "work_interaction_attention" ADD CONSTRAINT "work_interaction_attention_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "work_interaction_attention" ADD CONSTRAINT "fk_work_interaction_attention_request" FOREIGN KEY ("org_id","interaction_id") REFERENCES "work_interactions"("org_id","id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "work_interaction_card_presentations" ADD CONSTRAINT "work_interaction_card_presentations_org_id_interaction_id_work_interactions_org_id_id_fk" FOREIGN KEY ("org_id","interaction_id") REFERENCES "work_interactions"("org_id","id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "work_interaction_card_revisions" ADD CONSTRAINT "work_interaction_card_revisions_org_id_request_id_work_interactions_org_id_id_fk" FOREIGN KEY ("org_id","request_id") REFERENCES "work_interactions"("org_id","id");--> statement-breakpoint
ALTER TABLE "work_interaction_decision_history" ADD CONSTRAINT "work_interaction_decision_history_response_id_work_interaction_responses_id_fk" FOREIGN KEY ("response_id") REFERENCES "work_interaction_responses"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "work_interaction_decision_history" ADD CONSTRAINT "work_interaction_decision_history_org_id_interaction_id_work_interactions_org_id_id_fk" FOREIGN KEY ("org_id","interaction_id") REFERENCES "work_interactions"("org_id","id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "work_interaction_deliveries" ADD CONSTRAINT "work_interaction_deliveries_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "work_interaction_deliveries" ADD CONSTRAINT "work_interaction_deliveries_response_id_work_interaction_responses_id_fk" FOREIGN KEY ("response_id") REFERENCES "work_interaction_responses"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "work_interaction_deliveries" ADD CONSTRAINT "fk_work_interaction_delivery_request" FOREIGN KEY ("org_id","interaction_id") REFERENCES "work_interactions"("org_id","id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "work_interaction_reply_drafts" ADD CONSTRAINT "work_interaction_reply_drafts_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "work_interaction_reply_drafts" ADD CONSTRAINT "fk_work_interaction_reply_draft_request" FOREIGN KEY ("org_id","interaction_id") REFERENCES "work_interactions"("org_id","id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "work_interaction_responses" ADD CONSTRAINT "work_interaction_responses_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "work_interaction_responses" ADD CONSTRAINT "fk_work_interaction_response_request" FOREIGN KEY ("org_id","interaction_id") REFERENCES "work_interactions"("org_id","id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "work_interactions" ADD CONSTRAINT "work_interactions_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "work_interactions" ADD CONSTRAINT "fk_work_interaction_item" FOREIGN KEY ("org_id","work_item_id") REFERENCES "work_items"("org_id","id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "work_interactions" ADD CONSTRAINT "fk_work_interaction_case" FOREIGN KEY ("org_id","case_id") REFERENCES "work_cases"("org_id","id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "work_interactions" ADD CONSTRAINT "fk_work_interaction_project" FOREIGN KEY ("org_id","project_id") REFERENCES "projects"("org_id","id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "work_item_comments" ADD CONSTRAINT "work_item_comments_work_item_id_work_items_id_fk" FOREIGN KEY ("work_item_id") REFERENCES "work_items"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "work_item_comments" ADD CONSTRAINT "work_item_comments_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "work_item_corroborations" ADD CONSTRAINT "work_item_corroborations_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "work_item_corroborations" ADD CONSTRAINT "work_item_corroborations_work_item_id_work_items_id_fk" FOREIGN KEY ("work_item_id") REFERENCES "work_items"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "work_item_corroborations" ADD CONSTRAINT "fk_work_item_corroboration_item_org" FOREIGN KEY ("org_id","work_item_id") REFERENCES "work_items"("org_id","id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "work_item_org_counts" ADD CONSTRAINT "work_item_org_counts_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "work_item_projections" ADD CONSTRAINT "work_item_projections_work_item_id_work_items_id_fk" FOREIGN KEY ("work_item_id") REFERENCES "work_items"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "work_item_projections" ADD CONSTRAINT "work_item_projections_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "work_item_relations" ADD CONSTRAINT "work_item_relations_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "work_item_relations" ADD CONSTRAINT "work_item_relations_from_work_item_id_work_items_id_fk" FOREIGN KEY ("from_work_item_id") REFERENCES "work_items"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "work_item_relations" ADD CONSTRAINT "work_item_relations_to_work_item_id_work_items_id_fk" FOREIGN KEY ("to_work_item_id") REFERENCES "work_items"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "work_item_sources" ADD CONSTRAINT "work_item_sources_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "work_item_sources" ADD CONSTRAINT "work_item_sources_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "work_items" ADD CONSTRAINT "work_items_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "work_items" ADD CONSTRAINT "work_items_objective_id_tedi_objectives_id_fk" FOREIGN KEY ("objective_id") REFERENCES "tedi_objectives"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "work_items" ADD CONSTRAINT "work_items_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "work_project_health_judgments" ADD CONSTRAINT "work_project_health_judgments_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "work_project_health_judgments" ADD CONSTRAINT "fk_work_project_health_project" FOREIGN KEY ("org_id","project_id") REFERENCES "projects"("org_id","id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "work_resource_pools" ADD CONSTRAINT "work_resource_pools_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "work_resource_requirements" ADD CONSTRAINT "fk_work_resource_requirement_item" FOREIGN KEY ("org_id","work_item_id") REFERENCES "work_items"("org_id","id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "work_resource_requirements" ADD CONSTRAINT "fk_work_resource_requirement_pool" FOREIGN KEY ("org_id","resource_key") REFERENCES "work_resource_pools"("org_id","resource_key") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "work_resource_reservations" ADD CONSTRAINT "fk_work_resource_reservation_admission" FOREIGN KEY ("org_id","work_item_id","admission_id") REFERENCES "work_admissions"("org_id","work_item_id","id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "work_resource_reservations" ADD CONSTRAINT "fk_work_resource_reservation_pool" FOREIGN KEY ("org_id","pool_id") REFERENCES "work_resource_pools"("org_id","id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "workspace_activity" ADD CONSTRAINT "workspace_activity_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "workspace_feed_cursors" ADD CONSTRAINT "workspace_feed_cursors_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "workspace_feed_ledger" ADD CONSTRAINT "workspace_feed_ledger_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "workspace_output_index" ADD CONSTRAINT "workspace_output_index_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "workspace_template_sets" ADD CONSTRAINT "workspace_template_sets_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "workspace_template_sets" ADD CONSTRAINT "workspace_template_sets_supersedes_revision_id_workspace_template_sets_id_fk" FOREIGN KEY ("supersedes_revision_id") REFERENCES "workspace_template_sets"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "workspace_template_sets" ADD CONSTRAINT "workspace_template_sets_rollback_of_revision_id_workspace_template_sets_id_fk" FOREIGN KEY ("rollback_of_revision_id") REFERENCES "workspace_template_sets"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "workspace_work_links" ADD CONSTRAINT "workspace_work_links_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "workstation_leases" ADD CONSTRAINT "workstation_leases_workstation_id_workstations_id_fk" FOREIGN KEY ("workstation_id") REFERENCES "workstations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "workstation_leases" ADD CONSTRAINT "workstation_leases_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "workstation_leases" ADD CONSTRAINT "workstation_leases_work_item_id_work_items_id_fk" FOREIGN KEY ("work_item_id") REFERENCES "work_items"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "workstation_participants" ADD CONSTRAINT "workstation_participants_lease_id_workstation_leases_id_fk" FOREIGN KEY ("lease_id") REFERENCES "workstation_leases"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "workstation_participants" ADD CONSTRAINT "workstation_participants_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "workstation_participants" ADD CONSTRAINT "workstation_participants_tedi_id_tedis_id_fk" FOREIGN KEY ("tedi_id") REFERENCES "tedis"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "workstation_sessions" ADD CONSTRAINT "workstation_sessions_lease_id_workstation_leases_id_fk" FOREIGN KEY ("lease_id") REFERENCES "workstation_leases"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "workstation_sessions" ADD CONSTRAINT "workstation_sessions_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "workstation_sessions" ADD CONSTRAINT "workstation_sessions_participant_id_workstation_participants_id_fk" FOREIGN KEY ("participant_id") REFERENCES "workstation_participants"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "workstations" ADD CONSTRAINT "workstations_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE;