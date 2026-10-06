CREATE TABLE `app_adapters` (
	`id` text PRIMARY KEY,
	`app_id` text NOT NULL,
	`name` text NOT NULL,
	`display_name` text,
	`adapter_type` text NOT NULL,
	`config` text,
	`field_mappings` text,
	`verticals` text,
	`enabled` integer DEFAULT true,
	`priority` integer DEFAULT 0,
	`created_at` text DEFAULT (CURRENT_TIMESTAMP),
	`updated_at` text DEFAULT (CURRENT_TIMESTAMP),
	CONSTRAINT `fk_app_adapters_app_id_apps_id_fk` FOREIGN KEY (`app_id`) REFERENCES `apps`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `mcp_tool_calls` (
	`id` text PRIMARY KEY,
	`organization_id` text NOT NULL,
	`app_id` text NOT NULL,
	`session_id` text NOT NULL,
	`tool_name` text NOT NULL,
	`duration_ms` integer,
	`tokens_used` integer,
	`tool_input_size` integer,
	`tool_output_size` integer,
	`success` integer DEFAULT true,
	`error_code` text,
	`error_message` text,
	`created_at` text DEFAULT (CURRENT_TIMESTAMP),
	CONSTRAINT `fk_mcp_tool_calls_organization_id_organizations_id_fk` FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_mcp_tool_calls_app_id_apps_id_fk` FOREIGN KEY (`app_id`) REFERENCES `apps`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `session_metrics` (
	`id` text PRIMARY KEY,
	`organization_id` text NOT NULL,
	`app_id` text NOT NULL,
	`session_id` text NOT NULL,
	`messages_per_session` integer DEFAULT 0,
	`avg_response_time_ms` real,
	`total_tokens_used` integer DEFAULT 0,
	`error_count` integer DEFAULT 0,
	`success_rate` real,
	`session_duration_ms` integer,
	`session_started_at` text NOT NULL,
	`session_ended_at` text,
	`created_at` text DEFAULT (CURRENT_TIMESTAMP),
	CONSTRAINT `fk_session_metrics_organization_id_organizations_id_fk` FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_session_metrics_app_id_apps_id_fk` FOREIGN KEY (`app_id`) REFERENCES `apps`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `widget_events` (
	`id` text PRIMARY KEY,
	`organization_id` text NOT NULL,
	`app_id` text NOT NULL,
	`session_id` text NOT NULL,
	`event_type` text NOT NULL,
	`item_id` text,
	`item_position` integer,
	`widget_key` text,
	`display_mode` text,
	`metadata` text,
	`created_at` text DEFAULT (CURRENT_TIMESTAMP),
	CONSTRAINT `fk_widget_events_organization_id_organizations_id_fk` FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_widget_events_app_id_apps_id_fk` FOREIGN KEY (`app_id`) REFERENCES `apps`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_widget_events_item_id_items_id_fk` FOREIGN KEY (`item_id`) REFERENCES `items`(`id`) ON DELETE SET NULL
);
--> statement-breakpoint
CREATE TABLE `api_keys` (
	`id` text PRIMARY KEY,
	`organization_id` text NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`key_hash` text NOT NULL,
	`key_preview` text NOT NULL,
	`scopes` text,
	`environment` text DEFAULT 'test',
	`last_used_at` text,
	`requests_this_month` integer DEFAULT 0,
	`total_requests` integer DEFAULT 0,
	`ip_allowlist` text,
	`expires_at` text,
	`rate_limit` integer,
	`status` text DEFAULT 'active',
	`rotated_at` text,
	`rotation_schedule_days` integer,
	`previous_key_hash` text,
	`previous_key_expires_at` text,
	`revoked_at` text,
	`revoked_by` text,
	`revoke_reason` text,
	`metadata` text,
	`created_by` text,
	`created_at` text DEFAULT (CURRENT_TIMESTAMP),
	`updated_at` text DEFAULT (CURRENT_TIMESTAMP),
	CONSTRAINT `fk_api_keys_organization_id_organizations_id_fk` FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `app_adapter_secret_bindings` (
	`id` text PRIMARY KEY,
	`adapter_id` text NOT NULL,
	`app_id` text NOT NULL,
	`config_path` text NOT NULL,
	`secret_id` text NOT NULL,
	`secret_scope` text NOT NULL,
	`created_at` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL,
	`updated_at` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL,
	CONSTRAINT `fk_app_adapter_secret_bindings_adapter_id_app_adapters_id_fk` FOREIGN KEY (`adapter_id`) REFERENCES `app_adapters`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_app_adapter_secret_bindings_app_id_apps_id_fk` FOREIGN KEY (`app_id`) REFERENCES `apps`(`id`) ON DELETE CASCADE,
	CONSTRAINT `adapter_binding_unique` UNIQUE(`adapter_id`,`config_path`)
);
--> statement-breakpoint
CREATE TABLE `app_config_versions` (
	`id` text PRIMARY KEY DEFAULT (lower(
    hex(randomblob(4)) || '-' ||
    hex(randomblob(2)) || '-' ||
    '4' || substr(hex(randomblob(2)), 2) || '-' ||
    substr('89ab', 1 + (abs(random()) % 4), 1) || substr(hex(randomblob(2)), 2) || '-' ||
    hex(randomblob(6))
  )),
	`app_id` text NOT NULL,
	`version` integer NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`config` text NOT NULL,
	`change_summary` text,
	`published_at` text,
	`published_by` text,
	`activated_at` text,
	`activated_by` text,
	`created_by` text,
	`created_at` text DEFAULT (CURRENT_TIMESTAMP),
	`updated_at` text DEFAULT (CURRENT_TIMESTAMP),
	CONSTRAINT `fk_app_config_versions_app_id_apps_id_fk` FOREIGN KEY (`app_id`) REFERENCES `apps`(`id`) ON DELETE CASCADE,
	CONSTRAINT `uniq_app_config_versions_app_version` UNIQUE(`app_id`,`version`)
);
--> statement-breakpoint
CREATE TABLE `app_secrets` (
	`id` text PRIMARY KEY,
	`app_id` text NOT NULL,
	`name` text NOT NULL,
	`encrypted_value` text NOT NULL,
	`hint` text,
	`key_version` integer DEFAULT 1 NOT NULL,
	`created_by` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	CONSTRAINT `fk_app_secrets_app_id_apps_id_fk` FOREIGN KEY (`app_id`) REFERENCES `apps`(`id`) ON DELETE CASCADE,
	CONSTRAINT `app_secret_unique` UNIQUE(`app_id`,`name`)
);
--> statement-breakpoint
CREATE TABLE `app_snapshots` (
	`id` text PRIMARY KEY DEFAULT (lower(
    hex(randomblob(4)) || '-' ||
    hex(randomblob(2)) || '-' ||
    '4' || substr(hex(randomblob(2)), 2) || '-' ||
    substr('89ab', 1 + (abs(random()) % 4), 1) || substr(hex(randomblob(2)), 2) || '-' ||
    hex(randomblob(6))
  )),
	`app_id` text NOT NULL,
	`name` text NOT NULL,
	`version_tag` text,
	`description` text,
	`snapshot` text,
	`created_at` text DEFAULT (CURRENT_TIMESTAMP),
	CONSTRAINT `fk_app_snapshots_app_id_apps_id_fk` FOREIGN KEY (`app_id`) REFERENCES `apps`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `app_submission_assets` (
	`id` text PRIMARY KEY,
	`submission_id` text NOT NULL,
	`asset_type` text NOT NULL,
	`order_index` integer,
	`storage_key` text,
	`cdn_url` text,
	`filename` text,
	`mime_type` text,
	`file_size` integer,
	`width` integer,
	`height` integer,
	`user_prompt` text,
	`upload_status` text DEFAULT 'pending',
	`created_at` text DEFAULT (CURRENT_TIMESTAMP),
	CONSTRAINT `fk_app_submission_assets_submission_id_app_submissions_id_fk` FOREIGN KEY (`submission_id`) REFERENCES `app_submissions`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `app_submission_status_history` (
	`id` text PRIMARY KEY,
	`submission_id` text NOT NULL,
	`previous_status` text,
	`new_status` text NOT NULL,
	`changed_by` text,
	`change_reason` text,
	`metadata` text,
	`created_at` text DEFAULT (CURRENT_TIMESTAMP),
	CONSTRAINT `fk_app_submission_status_history_submission_id_app_submissions_id_fk` FOREIGN KEY (`submission_id`) REFERENCES `app_submissions`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `app_submission_test_cases` (
	`id` text PRIMARY KEY,
	`submission_id` text NOT NULL,
	`test_type` text NOT NULL,
	`order_index` integer NOT NULL,
	`description` text NOT NULL,
	`user_prompt` text NOT NULL,
	`tools_triggered` text,
	`expected_output` text,
	`created_at` text DEFAULT (CURRENT_TIMESTAMP),
	`updated_at` text DEFAULT (CURRENT_TIMESTAMP),
	CONSTRAINT `fk_app_submission_test_cases_submission_id_app_submissions_id_fk` FOREIGN KEY (`submission_id`) REFERENCES `app_submissions`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `app_submission_tool_justifications` (
	`id` text PRIMARY KEY,
	`submission_id` text NOT NULL,
	`tool_name` text NOT NULL,
	`read_only_hint` integer DEFAULT true,
	`open_world_hint` integer DEFAULT false,
	`destructive_hint` integer DEFAULT false,
	`read_only_justification` text,
	`open_world_justification` text,
	`destructive_justification` text,
	`csp_connect_domains` text,
	`csp_resource_domains` text,
	`created_at` text DEFAULT (CURRENT_TIMESTAMP),
	`updated_at` text DEFAULT (CURRENT_TIMESTAMP),
	CONSTRAINT `fk_app_submission_tool_justifications_submission_id_app_submissions_id_fk` FOREIGN KEY (`submission_id`) REFERENCES `app_submissions`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `app_submissions` (
	`id` text PRIMARY KEY,
	`app_id` text NOT NULL,
	`version` text DEFAULT '1.0.0' NOT NULL,
	`version_notes` text,
	`logo_icon_light` text,
	`logo_icon_dark` text,
	`app_name` text NOT NULL,
	`subtitle` text,
	`description` text,
	`category` text DEFAULT 'shopping',
	`developer_name` text,
	`developer_email` text,
	`website_url` text,
	`support_url` text,
	`privacy_policy_url` text,
	`terms_of_service_url` text,
	`demo_recording_url` text,
	`commerce_links_out` integer DEFAULT false,
	`commerce_no_digital_goods` integer DEFAULT true,
	`commerce_not_prohibited` integer DEFAULT true,
	`commerce_compliant` integer DEFAULT true,
	`commerce_links_description` text,
	`mcp_endpoint` text,
	`domain_verification_token` text,
	`domain_verified` integer DEFAULT false,
	`mcp_auth_type` text DEFAULT 'none',
	`mcp_oauth_config` text,
	`test_instructions` text,
	`test_credentials` text,
	`reviewer_notes` text,
	`allowed_countries_mode` text DEFAULT 'ALLOW_ALL',
	`blocked_countries` text,
	`global_availability` integer DEFAULT true,
	`available_regions` text,
	`supported_languages` text,
	`content_rating` text DEFAULT 'everyone',
	`release_notes` text,
	`entity_type` text DEFAULT 'business',
	`intended_audience` text DEFAULT 'all_ages',
	`policy_agreed_to_terms` integer DEFAULT false,
	`policy_in_compliance` integer DEFAULT false,
	`policy_legal_compliance` integer DEFAULT false,
	`policy_no_money_transfers` integer DEFAULT false,
	`policy_no_advertisements` integer DEFAULT false,
	`policy_third_party_rights` integer DEFAULT false,
	`policy_not_for_children` integer DEFAULT false,
	`status` text DEFAULT 'draft',
	`submitted_at` text,
	`review_started_at` text,
	`review_completed_at` text,
	`review_feedback` text,
	`openai_app_id` text,
	`created_by` text,
	`updated_by` text,
	`created_at` text DEFAULT (CURRENT_TIMESTAMP),
	`updated_at` text DEFAULT (CURRENT_TIMESTAMP),
	`previous_version_id` text,
	CONSTRAINT `fk_app_submissions_app_id_apps_id_fk` FOREIGN KEY (`app_id`) REFERENCES `apps`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `apps` (
	`id` text PRIMARY KEY,
	`organization_id` text NOT NULL,
	`name` text NOT NULL,
	`slug` text NOT NULL,
	`description` text,
	`custom_mcp_domain` text,
	`openai_challenge_token` text,
	`openai_app_id` text,
	`app_store_status` text DEFAULT 'draft',
	`discovery_status` text DEFAULT 'pending',
	`primary_domain` text,
	`visibility` text DEFAULT 'private',
	`logo_url` text,
	`template_slug` text DEFAULT 'tedix',
	`metadata` text,
	`gating_metadata` text,
	`source_app_id` text,
	`catalog_app_id` text,
	`active_config_version_id` text,
	`latest_config_version` integer DEFAULT 0 NOT NULL,
	`extracted_at` text,
	`ai_search_synced_at` text,
	`created_at` text DEFAULT (CURRENT_TIMESTAMP),
	`updated_at` text DEFAULT (CURRENT_TIMESTAMP),
	CONSTRAINT `fk_apps_organization_id_organizations_id_fk` FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_apps_source_app_id_apps_id_fk` FOREIGN KEY (`source_app_id`) REFERENCES `apps`(`id`) ON DELETE SET NULL,
	CONSTRAINT `fk_apps_catalog_app_id_app_catalog_id_fk` FOREIGN KEY (`catalog_app_id`) REFERENCES `app_catalog`(`id`) ON DELETE SET NULL,
	CONSTRAINT `uniq_app_org_slug` UNIQUE(`organization_id`,`slug`)
);
--> statement-breakpoint
CREATE TABLE `capability_links` (
	`id` text PRIMARY KEY,
	`capability_id` text NOT NULL,
	`organization_id` text NOT NULL,
	`entity_kind` text NOT NULL,
	`entity_id` text NOT NULL,
	`created_at` text NOT NULL,
	CONSTRAINT `fk_capability_links_capability_id_org_capabilities_id_fk` FOREIGN KEY (`capability_id`) REFERENCES `org_capabilities`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_capability_links_organization_id_organizations_id_fk` FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `org_capabilities` (
	`id` text PRIMARY KEY,
	`organization_id` text NOT NULL,
	`parent_id` text,
	`name` text NOT NULL,
	`slug` text NOT NULL,
	`description` text,
	`value_stream` text,
	`pace_layer` text NOT NULL,
	`maturity_score` real,
	`status` text DEFAULT 'active' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text,
	`archived_at` text,
	CONSTRAINT `fk_org_capabilities_organization_id_organizations_id_fk` FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_org_capabilities_parent_id_org_capabilities_id_fk` FOREIGN KEY (`parent_id`) REFERENCES `org_capabilities`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `app_catalog` (
	`id` text PRIMARY KEY,
	`slug` text,
	`name` text NOT NULL,
	`description` text,
	`model_description` text,
	`base_url` text,
	`mcp_endpoint_normalized` text,
	`mcp_endpoint_hash` text,
	`connector_type` text NOT NULL,
	`distribution_channel` text,
	`developer_type` text,
	`status` text DEFAULT 'ENABLED',
	`category` text,
	`developer` text,
	`website` text,
	`privacy_policy` text,
	`terms_of_service` text,
	`is_discoverable` integer DEFAULT true,
	`service` text,
	`logo_url` text,
	`logo_url_dark` text,
	`keywords_for_discovery` text,
	`keywords_for_triggering` text,
	`version` text,
	`version_id` text,
	`version_notes` text,
	`review_status` text,
	`seo_description` text,
	`screenshots` text,
	`categories` text,
	`sub_categories` text,
	`has_writes` integer DEFAULT false,
	`has_interactive` integer DEFAULT false,
	`has_file_search` integer DEFAULT false,
	`has_deep_research` integer DEFAULT false,
	`has_sync` integer DEFAULT false,
	`auth_types` text,
	`supports_full_actions` integer,
	`mcp_tool_count` integer DEFAULT 0,
	`mcp_resource_count` integer DEFAULT 0,
	`mcp_prompt_count` integer DEFAULT 0,
	`protocol_version` text,
	`supports_resources` integer DEFAULT false,
	`supports_prompts` integer DEFAULT false,
	`supports_sampling` integer DEFAULT false,
	`supports_roots` integer DEFAULT false,
	`health_status` text DEFAULT 'unknown',
	`safety_status` text,
	`mcp_metadata` text,
	`health_data` text,
	`scores` text,
	`system_hints` text,
	`first_seen` text,
	`rich_content` text,
	`documentation_url` text,
	`support_url` text,
	`scan_auth_headers` text,
	`scan_connection_id` text,
	`scan_connection_header` text,
	`scan_connection_template` text,
	`scan_organization_id` text,
	`scan_client_credentials_token_url` text,
	`raw_data` text,
	`source_created_at` text,
	`last_synced_at` text NOT NULL,
	`sync_source` text DEFAULT 'api',
	`tool_source` text DEFAULT 'upstream_mcp' NOT NULL,
	`created_at` text DEFAULT (CURRENT_TIMESTAMP),
	`updated_at` text DEFAULT (CURRENT_TIMESTAMP)
);
--> statement-breakpoint
CREATE TABLE `app_catalog_changes` (
	`id` text PRIMARY KEY,
	`catalog_app_id` text NOT NULL,
	`change_type` text NOT NULL,
	`field_name` text,
	`old_value` text,
	`new_value` text,
	`version_before` text,
	`version_after` text,
	`detected_at` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL,
	`sync_log_id` text,
	CONSTRAINT `fk_app_catalog_changes_catalog_app_id_app_catalog_id_fk` FOREIGN KEY (`catalog_app_id`) REFERENCES `app_catalog`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `app_catalog_health_history` (
	`id` text PRIMARY KEY,
	`catalog_app_id` text NOT NULL,
	`checked_at` text NOT NULL,
	`status` text NOT NULL,
	`connect_time_ms` integer,
	`total_time_ms` integer,
	`transport_used` text,
	`auth_state` text,
	`server_version` text,
	`tool_count` integer,
	`resource_count` integer,
	`prompt_count` integer,
	`error_message` text,
	`error_class` text,
	CONSTRAINT `fk_app_catalog_health_history_catalog_app_id_app_catalog_id_fk` FOREIGN KEY (`catalog_app_id`) REFERENCES `app_catalog`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `app_catalog_mcp_prompts` (
	`id` text PRIMARY KEY,
	`catalog_app_id` text NOT NULL,
	`prompt_name` text NOT NULL,
	`description` text,
	`arguments` text,
	`detected_at` text NOT NULL,
	`removed_at` text,
	`last_seen_at` text NOT NULL,
	CONSTRAINT `fk_app_catalog_mcp_prompts_catalog_app_id_app_catalog_id_fk` FOREIGN KEY (`catalog_app_id`) REFERENCES `app_catalog`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `app_catalog_mcp_resource_templates` (
	`id` text PRIMARY KEY,
	`catalog_app_id` text NOT NULL,
	`name` text NOT NULL,
	`title` text,
	`uri_template` text NOT NULL,
	`description` text,
	`mime_type` text,
	`icons` text,
	`annotations` text,
	`meta` text,
	`detected_at` text NOT NULL,
	`removed_at` text,
	`last_seen_at` text NOT NULL,
	CONSTRAINT `fk_app_catalog_mcp_resource_templates_catalog_app_id_app_catalog_id_fk` FOREIGN KEY (`catalog_app_id`) REFERENCES `app_catalog`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `app_catalog_mcp_resources` (
	`id` text PRIMARY KEY,
	`catalog_app_id` text NOT NULL,
	`uri` text NOT NULL,
	`name` text,
	`title` text,
	`description` text,
	`mime_type` text,
	`icons` text,
	`annotations` text,
	`meta` text,
	`detected_at` text NOT NULL,
	`removed_at` text,
	`last_seen_at` text NOT NULL,
	CONSTRAINT `fk_app_catalog_mcp_resources_catalog_app_id_app_catalog_id_fk` FOREIGN KEY (`catalog_app_id`) REFERENCES `app_catalog`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `app_catalog_mcp_tools` (
	`id` text PRIMARY KEY,
	`catalog_app_id` text NOT NULL,
	`tool_name` text NOT NULL,
	`title` text,
	`description` text,
	`input_schema` text DEFAULT '{"type":"object","properties":{},"additionalProperties":false}' NOT NULL,
	`output_schema` text,
	`icons` text,
	`execution_task_support` text,
	`annotations` text,
	`meta` text,
	`schema_dialect` text,
	`schema_source` text,
	`schema_source_ref` text,
	`schema_source_hash` text,
	`schema_synced_at` text,
	`detected_at` text NOT NULL,
	`removed_at` text,
	`last_seen_at` text NOT NULL,
	`last_tested_at` text,
	`last_test_success` integer,
	`test_success_rate` real,
	`avg_latency_ms` integer,
	`test_count` integer DEFAULT 0,
	`example_input` text,
	`example_output` text,
	`ai_clarity_score` real,
	CONSTRAINT `fk_app_catalog_mcp_tools_catalog_app_id_app_catalog_id_fk` FOREIGN KEY (`catalog_app_id`) REFERENCES `app_catalog`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `app_catalog_store_listings` (
	`id` text PRIMARY KEY,
	`catalog_app_id` text NOT NULL,
	`source` text NOT NULL,
	`source_app_id` text NOT NULL,
	`regions` text,
	`store_url` text,
	`review_status` text,
	`auth_required` integer DEFAULT false,
	`store_logo_url` text,
	`store_description` text,
	`popularity_score` integer,
	`trending_score` integer,
	`rank` integer,
	`works_with` text,
	`last_synced_at` text NOT NULL,
	`raw_data` text,
	`created_at` text DEFAULT (CURRENT_TIMESTAMP),
	CONSTRAINT `fk_app_catalog_store_listings_catalog_app_id_app_catalog_id_fk` FOREIGN KEY (`catalog_app_id`) REFERENCES `app_catalog`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `app_catalog_sync_logs` (
	`id` text PRIMARY KEY,
	`sync_type` text NOT NULL,
	`source` text,
	`started_at` text NOT NULL,
	`completed_at` text,
	`apps_discovered` integer DEFAULT 0,
	`apps_updated` integer DEFAULT 0,
	`apps_removed` integer DEFAULT 0,
	`apps_failed` integer DEFAULT 0,
	`status` text DEFAULT 'running',
	`error` text,
	`details` text
);
--> statement-breakpoint
CREATE TABLE `app_catalog_tool_tests` (
	`id` text PRIMARY KEY,
	`catalog_app_id` text NOT NULL,
	`tool_name` text NOT NULL,
	`tested_at` text NOT NULL,
	`test_type` text NOT NULL,
	`input_source` text NOT NULL,
	`success` integer NOT NULL,
	`latency_ms` integer,
	`error_message` text,
	`error_class` text,
	`input_used` text,
	`output_received` text,
	`output_valid` integer,
	`ai_model` text,
	`ai_prompt_used` text,
	`ai_tool_selection_correct` integer,
	`ai_output_quality_score` real,
	`ai_tokens_used` integer,
	CONSTRAINT `fk_app_catalog_tool_tests_catalog_app_id_app_catalog_id_fk` FOREIGN KEY (`catalog_app_id`) REFERENCES `app_catalog`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `upstream_drift_reports` (
	`id` text PRIMARY KEY,
	`catalog_app_id` text NOT NULL,
	`catalog_app_name` text NOT NULL,
	`added_tools` integer DEFAULT 0 NOT NULL,
	`removed_tools` integer DEFAULT 0 NOT NULL,
	`changed_tools` integer DEFAULT 0 NOT NULL,
	`drifts` text NOT NULL,
	`summary` text NOT NULL,
	`checked_at` text NOT NULL,
	`resolved_at` text,
	CONSTRAINT `fk_upstream_drift_reports_catalog_app_id_app_catalog_id_fk` FOREIGN KEY (`catalog_app_id`) REFERENCES `app_catalog`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `app_tool_csp_domains` (
	`id` text PRIMARY KEY DEFAULT (lower(
    hex(randomblob(4)) || '-' ||
    hex(randomblob(2)) || '-' ||
    '4' || substr(hex(randomblob(2)), 2) || '-' ||
    substr('89ab', 1 + (abs(random()) % 4), 1) || substr(hex(randomblob(2)), 2) || '-' ||
    hex(randomblob(6))
  )),
	`app_tool_id` text NOT NULL,
	`domain_type` text NOT NULL,
	`domain_url` text NOT NULL,
	`active` integer DEFAULT true,
	`created_at` text DEFAULT (CURRENT_TIMESTAMP),
	CONSTRAINT `fk_app_tool_csp_domains_app_tool_id_app_tools_id_fk` FOREIGN KEY (`app_tool_id`) REFERENCES `app_tools`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `connection_providers` (
	`id` text PRIMARY KEY,
	`name` text NOT NULL,
	`description` text NOT NULL,
	`icon` text NOT NULL,
	`category` text NOT NULL,
	`type` text NOT NULL,
	`descope_app_id` text,
	`descope_app_aliases` text,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`recommended_scope` text NOT NULL,
	`supported_scopes` text NOT NULL,
	`required_scopes` text NOT NULL,
	`credential_profile` text,
	`oauth_config` text,
	`created_at` text DEFAULT (CURRENT_TIMESTAMP),
	`updated_at` text DEFAULT (CURRENT_TIMESTAMP)
);
--> statement-breakpoint
CREATE TABLE `external_agent_attributions` (
	`id` text PRIMARY KEY,
	`organization_id` text NOT NULL,
	`principal_id` text NOT NULL,
	`session_id` text NOT NULL,
	`target_type` text NOT NULL,
	`target_id` text NOT NULL,
	`role` text NOT NULL,
	`work_item_id` text,
	`metadata` text DEFAULT '{}' NOT NULL,
	`occurred_at` text NOT NULL,
	CONSTRAINT `fk_external_agent_attributions_organization_id_organizations_id_fk` FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_external_agent_attribution_session_org` FOREIGN KEY (`organization_id`,`principal_id`,`session_id`) REFERENCES `external_agent_sessions`(`organization_id`,`principal_id`,`id`) ON DELETE RESTRICT,
	CONSTRAINT `fk_external_agent_attribution_work_item_org` FOREIGN KEY (`organization_id`,`work_item_id`) REFERENCES `work_items`(`org_id`,`id`) ON DELETE RESTRICT,
	CONSTRAINT "chk_external_agent_attribution_target" CHECK(length("target_id") > 0)
);
--> statement-breakpoint
CREATE TABLE `external_agent_mcp_credentials` (
	`id` text PRIMARY KEY,
	`organization_id` text NOT NULL,
	`principal_id` text NOT NULL,
	`session_id` text NOT NULL,
	`client_record_id` text NOT NULL,
	`mcp_server_id` text NOT NULL,
	`mcp_server_url` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`issued_at` text NOT NULL,
	`expires_at` text NOT NULL,
	`revoked_at` text,
	CONSTRAINT `fk_external_agent_mcp_credentials_organization_id_organizations_id_fk` FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_external_agent_mcp_credential_session_org` FOREIGN KEY (`organization_id`,`principal_id`,`session_id`) REFERENCES `external_agent_sessions`(`organization_id`,`principal_id`,`id`) ON DELETE RESTRICT,
	CONSTRAINT "chk_external_agent_mcp_credential_state" CHECK(("status" = 'active' AND "revoked_at" IS NULL) OR ("status" = 'revoked' AND "revoked_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE `external_agent_principals` (
	`id` text PRIMARY KEY,
	`organization_id` text NOT NULL,
	`key` text NOT NULL,
	`display_name` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`credential_binding_type` text NOT NULL,
	`credential_binding_id` text NOT NULL,
	`created_by_type` text NOT NULL,
	`created_by_id` text NOT NULL,
	`metadata` text DEFAULT '{}' NOT NULL,
	`created_at` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL,
	`updated_at` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL,
	CONSTRAINT `fk_external_agent_principals_organization_id_organizations_id_fk` FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON DELETE CASCADE,
	CONSTRAINT "chk_external_agent_principal_key" CHECK(length("key") > 0),
	CONSTRAINT "chk_external_agent_principal_binding" CHECK(length("credential_binding_id") > 0)
);
--> statement-breakpoint
CREATE TABLE `external_agent_review_evidence` (
	`id` text PRIMARY KEY,
	`organization_id` text NOT NULL,
	`execution_attribution_id` text NOT NULL,
	`subject_principal_id` text NOT NULL,
	`subject_session_id` text NOT NULL,
	`reviewer_principal_type` text NOT NULL,
	`reviewer_principal_id` text NOT NULL,
	`reviewer_session_id` text,
	`target_type` text NOT NULL,
	`target_id` text NOT NULL,
	`work_item_id` text,
	`task_family` text NOT NULL,
	`repository_key` text NOT NULL,
	`repository_version` text NOT NULL,
	`risk_level` text NOT NULL,
	`environment` text NOT NULL,
	`outcome` text NOT NULL,
	`score` real NOT NULL,
	`policy_violation_severity` integer DEFAULT 0 NOT NULL,
	`review_method` text NOT NULL,
	`evidence_refs` text NOT NULL,
	`context_hash` text NOT NULL,
	`resolution_status` text DEFAULT 'open' NOT NULL,
	`resolution_evidence_ref` text,
	`resolved_by_type` text,
	`resolved_by_id` text,
	`resolved_at` text,
	`occurred_at` text NOT NULL,
	`created_at` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL,
	CONSTRAINT `fk_external_agent_review_evidence_organization_id_organizations_id_fk` FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_external_agent_review_execution_org` FOREIGN KEY (`organization_id`,`execution_attribution_id`) REFERENCES `external_agent_attributions`(`organization_id`,`id`) ON DELETE RESTRICT,
	CONSTRAINT `fk_external_agent_review_subject_session` FOREIGN KEY (`organization_id`,`subject_principal_id`,`subject_session_id`) REFERENCES `external_agent_sessions`(`organization_id`,`principal_id`,`id`) ON DELETE RESTRICT,
	CONSTRAINT `fk_external_agent_review_reviewer_session` FOREIGN KEY (`organization_id`,`reviewer_principal_id`,`reviewer_session_id`) REFERENCES `external_agent_sessions`(`organization_id`,`principal_id`,`id`) ON DELETE RESTRICT,
	CONSTRAINT `fk_external_agent_review_work_item_org` FOREIGN KEY (`organization_id`,`work_item_id`) REFERENCES `work_items`(`org_id`,`id`) ON DELETE RESTRICT,
	CONSTRAINT "chk_external_agent_review_principal_type" CHECK("reviewer_principal_type" IN ('user', 'certification_service', 'external_agent')),
	CONSTRAINT "chk_external_agent_review_no_self_review" CHECK("reviewer_principal_type" != 'external_agent' OR "reviewer_principal_id" != "subject_principal_id"),
	CONSTRAINT "chk_external_agent_review_session_shape" CHECK(("reviewer_principal_type" = 'external_agent' AND "reviewer_session_id" IS NOT NULL) OR ("reviewer_principal_type" != 'external_agent' AND "reviewer_session_id" IS NULL)),
	CONSTRAINT "chk_external_agent_review_score" CHECK("score" >= 0 AND "score" <= 1 AND "policy_violation_severity" >= 0 AND "policy_violation_severity" <= 10),
	CONSTRAINT "chk_external_agent_review_outcome_coherence" CHECK(("outcome" = 'success' AND "score" >= 0.5 AND "policy_violation_severity" = 0) OR ("outcome" = 'partial' AND "policy_violation_severity" = 0) OR ("outcome" = 'failure' AND "score" <= 0.5 AND "policy_violation_severity" = 0) OR ("outcome" = 'policy_violation' AND "score" <= 0.5 AND "policy_violation_severity" >= 1)),
	CONSTRAINT "chk_external_agent_review_context" CHECK(length("task_family") > 0 AND length("repository_key") > 0 AND length("repository_version") > 0 AND length("environment") > 0 AND json_array_length("evidence_refs") > 0),
	CONSTRAINT "chk_external_agent_review_resolution" CHECK(("resolution_status" = 'open' AND "resolution_evidence_ref" IS NULL AND "resolved_by_type" IS NULL AND "resolved_by_id" IS NULL AND "resolved_at" IS NULL) OR ("resolution_status" = 'remediated' AND "resolution_evidence_ref" IS NOT NULL AND "resolved_by_type" IS NOT NULL AND "resolved_by_id" IS NOT NULL AND "resolved_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE `external_agent_sessions` (
	`id` text PRIMARY KEY,
	`organization_id` text NOT NULL,
	`principal_id` text NOT NULL,
	`external_session_key` text NOT NULL,
	`harness` text NOT NULL,
	`harness_version` text NOT NULL,
	`model_provider` text NOT NULL,
	`model_id` text NOT NULL,
	`model_version` text NOT NULL,
	`identity_source` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`credit_eligible` integer DEFAULT true NOT NULL,
	`started_at` text NOT NULL,
	`last_seen_at` text NOT NULL,
	`ended_at` text,
	`metadata` text DEFAULT '{}' NOT NULL,
	CONSTRAINT `fk_external_agent_sessions_organization_id_organizations_id_fk` FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_external_agent_session_principal_org` FOREIGN KEY (`organization_id`,`principal_id`) REFERENCES `external_agent_principals`(`organization_id`,`id`) ON DELETE RESTRICT,
	CONSTRAINT "chk_external_agent_session_key" CHECK(length("external_session_key") > 0),
	CONSTRAINT "chk_external_agent_session_derived_credit" CHECK("identity_source" != 'derived' OR "credit_eligible" = 0),
	CONSTRAINT "chk_external_agent_session_end_state" CHECK(("status" = 'active' AND "ended_at" IS NULL) OR ("status" = 'ended' AND "ended_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE `generated_widget_artifacts` (
	`id` text PRIMARY KEY,
	`organization_id` text NOT NULL,
	`app_id` text NOT NULL,
	`app_slug` text NOT NULL,
	`app_tool_id` text,
	`tool_id` text,
	`tool_name` text,
	`kind` text DEFAULT 'json_render_layout' NOT NULL,
	`source` text DEFAULT 'tedi_generated' NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`title` text NOT NULL,
	`description` text,
	`layout_spec` text,
	`input_snapshot` text,
	`output_snapshot` text,
	`resource_uri` text,
	`widget_url` text,
	`preview_url` text,
	`screenshot_url` text,
	`widget_test_run_id` text,
	`workflow_id` text,
	`progress_message` text,
	`qa_summary` text,
	`metadata` text,
	`created_by` text,
	`published_at` text,
	`created_at` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL,
	`updated_at` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL,
	CONSTRAINT `fk_generated_widget_artifacts_organization_id_organizations_id_fk` FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_generated_widget_artifacts_app_id_apps_id_fk` FOREIGN KEY (`app_id`) REFERENCES `apps`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_generated_widget_artifacts_app_tool_id_app_tools_id_fk` FOREIGN KEY (`app_tool_id`) REFERENCES `app_tools`(`id`) ON DELETE SET NULL,
	CONSTRAINT `fk_generated_widget_artifacts_widget_test_run_id_widget_test_runs_id_fk` FOREIGN KEY (`widget_test_run_id`) REFERENCES `widget_test_runs`(`id`) ON DELETE SET NULL
);
--> statement-breakpoint
CREATE TABLE `items` (
	`id` text PRIMARY KEY,
	`app_id` text NOT NULL,
	`external_id` text,
	`vertical` text NOT NULL,
	`title` text NOT NULL,
	`subtitle` text,
	`description` text,
	`image` text,
	`images` text,
	`price_amount` real,
	`price_currency` text DEFAULT 'EUR',
	`price_original` real,
	`price_formatted` text,
	`rating_value` real,
	`rating_count` text,
	`rating_max` real,
	`badge_text` text,
	`badge_variant` text,
	`location_lat` real,
	`location_lng` real,
	`location_address` text,
	`location_city` text,
	`location_country` text,
	`seller_id` text,
	`seller_name` text,
	`seller_avatar` text,
	`seller_verified` text,
	`seller_rating` real,
	`features` text,
	`actions` text,
	`url` text,
	`metadata` text,
	`created_at` text DEFAULT (CURRENT_TIMESTAMP),
	`updated_at` text DEFAULT (CURRENT_TIMESTAMP),
	CONSTRAINT `fk_items_app_id_apps_id_fk` FOREIGN KEY (`app_id`) REFERENCES `apps`(`id`) ON DELETE CASCADE,
	CONSTRAINT `uq_items_app_url` UNIQUE(`app_id`,`url`)
);
--> statement-breakpoint
CREATE TABLE `jobs` (
	`id` text PRIMARY KEY,
	`type` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`app_id` text NOT NULL,
	`payload` text,
	`result` text,
	`error` text,
	`progress` text,
	`created_at` text DEFAULT (CURRENT_TIMESTAMP),
	`started_at` text,
	`completed_at` text,
	`updated_at` text DEFAULT (CURRENT_TIMESTAMP),
	CONSTRAINT `fk_jobs_app_id_apps_id_fk` FOREIGN KEY (`app_id`) REFERENCES `apps`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `learning_feedback_attributions` (
	`id` text PRIMARY KEY,
	`organization_id` text NOT NULL,
	`client_attribution_id` text NOT NULL,
	`feedback_event_id` text NOT NULL,
	`subject_kind` text NOT NULL,
	`subject_id` text NOT NULL,
	`change_kind` text NOT NULL,
	`rationale` text,
	`evidence_refs` text NOT NULL,
	`metadata` text,
	`occurred_at` text NOT NULL,
	`created_at` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL,
	CONSTRAINT `fk_learning_feedback_attributions_organization_id_organizations_id_fk` FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_learning_feedback_attributions_feedback_event_id_learning_interaction_events_id_fk` FOREIGN KEY (`feedback_event_id`) REFERENCES `learning_interaction_events`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `learning_feedback_measurements` (
	`id` text PRIMARY KEY,
	`organization_id` text NOT NULL,
	`client_measurement_id` text NOT NULL,
	`attribution_id` text NOT NULL,
	`window_kind` text NOT NULL,
	`window_start` text NOT NULL,
	`window_end` text NOT NULL,
	`opportunity_count` integer NOT NULL,
	`recurrence_count` integer NOT NULL,
	`success_count` integer DEFAULT 0 NOT NULL,
	`metadata` text,
	`created_at` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL,
	CONSTRAINT `fk_learning_feedback_measurements_organization_id_organizations_id_fk` FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_learning_feedback_measurements_attribution_id_learning_feedback_attributions_id_fk` FOREIGN KEY (`attribution_id`) REFERENCES `learning_feedback_attributions`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `learning_improvement_proposals` (
	`id` text PRIMARY KEY,
	`organization_id` text NOT NULL,
	`client_proposal_id` text NOT NULL,
	`tedi_id` text,
	`scope_kind` text NOT NULL,
	`scope_id` text NOT NULL,
	`issue_key` text NOT NULL,
	`subject_kind` text NOT NULL,
	`subject_id` text NOT NULL,
	`status` text DEFAULT 'proposed' NOT NULL,
	`promotion_route` text NOT NULL,
	`recommendation` text NOT NULL,
	`evidence_event_ids` text NOT NULL,
	`attribution_id` text,
	`baseline_measurement_id` text,
	`followup_measurement_id` text,
	`certification_evidence_refs` text NOT NULL,
	`evaluation_note` text,
	`review_reason` text,
	`proposed_by_type` text NOT NULL,
	`proposed_by_id` text,
	`reviewed_by_id` text,
	`created_at` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL,
	`updated_at` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL,
	`reviewed_at` text,
	CONSTRAINT `fk_learning_improvement_proposals_organization_id_organizations_id_fk` FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_learning_improvement_proposals_tedi_id_tedis_id_fk` FOREIGN KEY (`tedi_id`) REFERENCES `tedis`(`id`) ON DELETE SET NULL,
	CONSTRAINT `fk_learning_improvement_proposals_attribution_id_learning_feedback_attributions_id_fk` FOREIGN KEY (`attribution_id`) REFERENCES `learning_feedback_attributions`(`id`) ON DELETE SET NULL,
	CONSTRAINT `fk_learning_improvement_proposals_baseline_measurement_id_learning_feedback_measurements_id_fk` FOREIGN KEY (`baseline_measurement_id`) REFERENCES `learning_feedback_measurements`(`id`) ON DELETE SET NULL,
	CONSTRAINT `fk_learning_improvement_proposals_followup_measurement_id_learning_feedback_measurements_id_fk` FOREIGN KEY (`followup_measurement_id`) REFERENCES `learning_feedback_measurements`(`id`) ON DELETE SET NULL
);
--> statement-breakpoint
CREATE TABLE `learning_interaction_events` (
	`id` text PRIMARY KEY,
	`organization_id` text NOT NULL,
	`actor_type` text NOT NULL,
	`actor_id` text,
	`tedi_id` text,
	`client_event_id` text NOT NULL,
	`signal_class` text DEFAULT 'quality' NOT NULL,
	`event_kind` text NOT NULL,
	`scope_kind` text NOT NULL,
	`scope_id` text NOT NULL,
	`issue_key` text,
	`surface` text NOT NULL,
	`target_type` text,
	`target_id` text,
	`thread_id` text,
	`run_id` text,
	`metadata` text,
	`occurred_at` text NOT NULL,
	`created_at` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL,
	CONSTRAINT `fk_learning_interaction_events_organization_id_organizations_id_fk` FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_learning_interaction_events_tedi_id_tedis_id_fk` FOREIGN KEY (`tedi_id`) REFERENCES `tedis`(`id`) ON DELETE SET NULL
);
--> statement-breakpoint
CREATE TABLE `organization_members` (
	`id` text PRIMARY KEY,
	`organization_id` text NOT NULL,
	`descope_user_id` text NOT NULL,
	`email` text NOT NULL,
	`name` text,
	`avatar_url` text,
	`role` text DEFAULT 'member' NOT NULL,
	`custom_permissions` text,
	`status` text DEFAULT 'active',
	`invited_at` text,
	`invite_accepted_at` text,
	`invited_by` text,
	`last_active_at` text,
	`created_at` text DEFAULT (CURRENT_TIMESTAMP),
	`updated_at` text DEFAULT (CURRENT_TIMESTAMP),
	CONSTRAINT `fk_organization_members_organization_id_organizations_id_fk` FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON DELETE CASCADE,
	CONSTRAINT `uniq_org_member` UNIQUE(`organization_id`,`descope_user_id`)
);
--> statement-breakpoint
CREATE TABLE `organization_purpose_charters` (
	`id` text PRIMARY KEY,
	`org_id` text NOT NULL,
	`version` integer NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`purpose` text NOT NULL,
	`principles` text DEFAULT '[]' NOT NULL,
	`strategic_theses` text DEFAULT '[]' NOT NULL,
	`non_goals` text DEFAULT '[]' NOT NULL,
	`evidence_refs` text DEFAULT '[]' NOT NULL,
	`review_cadence_days` integer DEFAULT 30 NOT NULL,
	`revision_reason` text NOT NULL,
	`created_by_user_id` text,
	`created_at` text NOT NULL,
	`activated_at` text NOT NULL,
	`superseded_at` text,
	CONSTRAINT `fk_organization_purpose_charters_org_id_organizations_id_fk` FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `organization_secrets` (
	`id` text PRIMARY KEY,
	`organization_id` text NOT NULL,
	`name` text NOT NULL,
	`encrypted_value` text NOT NULL,
	`hint` text,
	`key_version` integer DEFAULT 1 NOT NULL,
	`created_by` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	CONSTRAINT `fk_organization_secrets_organization_id_organizations_id_fk` FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON DELETE CASCADE,
	CONSTRAINT `org_secret_unique` UNIQUE(`organization_id`,`name`)
);
--> statement-breakpoint
CREATE TABLE `organizations` (
	`id` text PRIMARY KEY,
	`name` text NOT NULL,
	`slug` text NOT NULL,
	`type` text DEFAULT 'organization' NOT NULL,
	`descope_tenant_id` text,
	`logo_url` text,
	`description` text,
	`subscription_status` text DEFAULT 'trial',
	`subscription_tier` text DEFAULT 'starter',
	`stripe_customer_id` text,
	`stripe_subscription_id` text,
	`apps_count` integer DEFAULT 0,
	`features` text,
	`metadata` text,
	`trial_ends_at` text,
	`created_at` text DEFAULT (CURRENT_TIMESTAMP),
	`updated_at` text DEFAULT (CURRENT_TIMESTAMP)
);
--> statement-breakpoint
CREATE TABLE `tedi_plugin_events` (
	`id` text PRIMARY KEY,
	`org_id` text NOT NULL,
	`plugin_id` text NOT NULL,
	`tedi_id` text,
	`event_type` text NOT NULL,
	`payload` text,
	`status` text DEFAULT 'pending',
	`created_at` text DEFAULT (CURRENT_TIMESTAMP),
	`processed_at` text,
	CONSTRAINT `fk_tedi_plugin_events_org_id_organizations_id_fk` FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_tedi_plugin_events_plugin_id_tedi_plugins_id_fk` FOREIGN KEY (`plugin_id`) REFERENCES `tedi_plugins`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_tedi_plugin_events_tedi_id_tedis_id_fk` FOREIGN KEY (`tedi_id`) REFERENCES `tedis`(`id`) ON DELETE SET NULL
);
--> statement-breakpoint
CREATE TABLE `tedi_plugin_installs` (
	`id` text PRIMARY KEY,
	`org_id` text NOT NULL,
	`plugin_id` text NOT NULL,
	`tedi_id` text,
	`config` text,
	`permissions_granted` text,
	`status` text DEFAULT 'installed',
	`installed_at` text DEFAULT (CURRENT_TIMESTAMP),
	`updated_at` text DEFAULT (CURRENT_TIMESTAMP),
	CONSTRAINT `fk_tedi_plugin_installs_org_id_organizations_id_fk` FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_tedi_plugin_installs_plugin_id_tedi_plugins_id_fk` FOREIGN KEY (`plugin_id`) REFERENCES `tedi_plugins`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_tedi_plugin_installs_tedi_id_tedis_id_fk` FOREIGN KEY (`tedi_id`) REFERENCES `tedis`(`id`) ON DELETE SET NULL
);
--> statement-breakpoint
CREATE TABLE `tedi_plugins` (
	`id` text PRIMARY KEY,
	`slug` text NOT NULL UNIQUE,
	`name` text NOT NULL,
	`description` text,
	`type` text NOT NULL,
	`version` text NOT NULL,
	`manifest` text,
	`status` text DEFAULT 'draft',
	`author_org_id` text,
	`created_at` text DEFAULT (CURRENT_TIMESTAMP),
	`updated_at` text DEFAULT (CURRENT_TIMESTAMP),
	CONSTRAINT `fk_tedi_plugins_author_org_id_organizations_id_fk` FOREIGN KEY (`author_org_id`) REFERENCES `organizations`(`id`) ON DELETE SET NULL
);
--> statement-breakpoint
CREATE TABLE `projects` (
	`id` text PRIMARY KEY,
	`org_id` text NOT NULL,
	`key` text NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`status` text DEFAULT 'active' NOT NULL,
	`lead_tedi_id` text,
	`owner_user_id` text,
	`objective_id` text,
	`target_date` text,
	`metadata` text DEFAULT '{}',
	`created_at` text NOT NULL,
	`updated_at` text,
	`archived_at` text,
	CONSTRAINT `fk_projects_org_id_organizations_id_fk` FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_projects_lead_tedi_id_tedis_id_fk` FOREIGN KEY (`lead_tedi_id`) REFERENCES `tedis`(`id`) ON DELETE SET NULL,
	CONSTRAINT `fk_projects_objective_id_tedi_objectives_id_fk` FOREIGN KEY (`objective_id`) REFERENCES `tedi_objectives`(`id`) ON DELETE SET NULL
);
--> statement-breakpoint
CREATE TABLE `role_templates` (
	`id` text PRIMARY KEY,
	`org_id` text,
	`key` text NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`persona` text NOT NULL,
	`standing_objectives` text DEFAULT '[]' NOT NULL,
	`tags` text DEFAULT '[]' NOT NULL,
	`capability_profile` text DEFAULT 'standard' NOT NULL,
	`cron_template_names` text DEFAULT '[]' NOT NULL,
	`metadata` text DEFAULT '{}' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text,
	`archived_at` text,
	CONSTRAINT `fk_role_templates_org_id_organizations_id_fk` FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `tedi_email_addresses` (
	`id` text PRIMARY KEY,
	`organization_id` text NOT NULL,
	`tedi_id` text NOT NULL,
	`address` text NOT NULL CONSTRAINT `uniq_tedi_email_address` UNIQUE,
	`local_part` text NOT NULL,
	`domain` text NOT NULL,
	`kind` text DEFAULT 'primary' NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`routing_policy` text,
	`created_by` text,
	`created_at` text DEFAULT (CURRENT_TIMESTAMP),
	`updated_at` text DEFAULT (CURRENT_TIMESTAMP),
	CONSTRAINT `fk_tedi_email_addresses_organization_id_organizations_id_fk` FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_tedi_email_addresses_tedi_id_tedis_id_fk` FOREIGN KEY (`tedi_id`) REFERENCES `tedis`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `tedi_email_attachments` (
	`id` text PRIMARY KEY,
	`message_id` text NOT NULL,
	`filename` text,
	`content_type` text,
	`size` integer,
	`r2_key` text,
	`content_id` text,
	`disposition` text,
	`created_at` text DEFAULT (CURRENT_TIMESTAMP),
	CONSTRAINT `fk_tedi_email_attachments_message_id_tedi_email_messages_id_fk` FOREIGN KEY (`message_id`) REFERENCES `tedi_email_messages`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `tedi_email_events` (
	`id` text PRIMARY KEY,
	`message_id` text,
	`thread_id` text,
	`organization_id` text NOT NULL,
	`tedi_id` text NOT NULL,
	`event_type` text NOT NULL,
	`provider` text,
	`payload_json` text,
	`created_at` text DEFAULT (CURRENT_TIMESTAMP),
	CONSTRAINT `fk_tedi_email_events_message_id_tedi_email_messages_id_fk` FOREIGN KEY (`message_id`) REFERENCES `tedi_email_messages`(`id`) ON DELETE SET NULL,
	CONSTRAINT `fk_tedi_email_events_thread_id_tedi_email_threads_id_fk` FOREIGN KEY (`thread_id`) REFERENCES `tedi_email_threads`(`id`) ON DELETE SET NULL,
	CONSTRAINT `fk_tedi_email_events_organization_id_organizations_id_fk` FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_tedi_email_events_tedi_id_tedis_id_fk` FOREIGN KEY (`tedi_id`) REFERENCES `tedis`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `tedi_email_messages` (
	`id` text PRIMARY KEY,
	`thread_id` text NOT NULL,
	`organization_id` text NOT NULL,
	`tedi_id` text NOT NULL,
	`direction` text NOT NULL,
	`from_addr` text NOT NULL,
	`from_json` text,
	`to_json` text NOT NULL,
	`cc_json` text,
	`bcc_json` text,
	`reply_to_json` text,
	`subject` text NOT NULL,
	`body_preview` text,
	`text_body` text,
	`html_r2_key` text,
	`raw_r2_key` text,
	`message_id_header` text,
	`in_reply_to` text,
	`references_json` text,
	`provider_message_id` text,
	`received_at` text,
	`sent_at` text,
	`read_at` text,
	`archived_at` text,
	`spam_score` real,
	`status` text NOT NULL,
	`created_at` text DEFAULT (CURRENT_TIMESTAMP),
	`updated_at` text DEFAULT (CURRENT_TIMESTAMP),
	CONSTRAINT `fk_tedi_email_messages_thread_id_tedi_email_threads_id_fk` FOREIGN KEY (`thread_id`) REFERENCES `tedi_email_threads`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_tedi_email_messages_organization_id_organizations_id_fk` FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_tedi_email_messages_tedi_id_tedis_id_fk` FOREIGN KEY (`tedi_id`) REFERENCES `tedis`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `tedi_email_threads` (
	`id` text PRIMARY KEY,
	`organization_id` text NOT NULL,
	`tedi_id` text NOT NULL,
	`subject_norm` text NOT NULL,
	`participants_json` text,
	`last_message_at` text NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`labels_json` text,
	`unread_count` integer DEFAULT 0 NOT NULL,
	`created_at` text DEFAULT (CURRENT_TIMESTAMP),
	`updated_at` text DEFAULT (CURRENT_TIMESTAMP),
	CONSTRAINT `fk_tedi_email_threads_organization_id_organizations_id_fk` FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_tedi_email_threads_tedi_id_tedis_id_fk` FOREIGN KEY (`tedi_id`) REFERENCES `tedis`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `tedi_secrets` (
	`id` text PRIMARY KEY,
	`tedi_id` text NOT NULL,
	`name` text NOT NULL,
	`encrypted_value` text NOT NULL,
	`hint` text,
	`key_version` integer DEFAULT 1 NOT NULL,
	`created_by` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	CONSTRAINT `fk_tedi_secrets_tedi_id_tedis_id_fk` FOREIGN KEY (`tedi_id`) REFERENCES `tedis`(`id`) ON DELETE CASCADE,
	CONSTRAINT `tedi_secret_unique` UNIQUE(`tedi_id`,`name`)
);
--> statement-breakpoint
CREATE TABLE `tedi_session_states` (
	`id` text PRIMARY KEY,
	`organization_id` text NOT NULL,
	`tedi_id` text NOT NULL,
	`user_id` text NOT NULL,
	`session_key` text NOT NULL,
	`title` text,
	`pinned_at` text,
	`deleted_at` text,
	`last_seen_at` integer,
	`created_at` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL,
	`updated_at` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL,
	CONSTRAINT `fk_tedi_session_states_organization_id_organizations_id_fk` FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_tedi_session_states_tedi_id_tedis_id_fk` FOREIGN KEY (`tedi_id`) REFERENCES `tedis`(`id`) ON DELETE CASCADE,
	CONSTRAINT `tedi_session_states_scope_unique` UNIQUE(`organization_id`,`tedi_id`,`user_id`,`session_key`)
);
--> statement-breakpoint
CREATE TABLE `gateway_log_ingestion_cursors` (
	`gateway_id` text PRIMARY KEY,
	`last_log_created_at` text NOT NULL,
	`last_log_id` text NOT NULL,
	`updated_at` text DEFAULT (CURRENT_TIMESTAMP)
);
--> statement-breakpoint
CREATE TABLE `tedi_call_costs` (
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
	`session_key_hash` text,
	`session_type` text DEFAULT 'unattributed' NOT NULL,
	`source` text DEFAULT 'ai-gateway-log' NOT NULL,
	`input_tokens` integer DEFAULT 0 NOT NULL,
	`output_tokens` integer DEFAULT 0 NOT NULL,
	`cache_read_tokens` integer DEFAULT 0 NOT NULL,
	`cache_write_tokens` integer DEFAULT 0 NOT NULL,
	`total_tokens` integer DEFAULT 0 NOT NULL,
	`estimated_cost_usd` real DEFAULT 0 NOT NULL,
	`session_count` integer DEFAULT 0 NOT NULL,
	`success` integer DEFAULT true NOT NULL,
	`cached` integer DEFAULT false NOT NULL,
	`data_quality` text DEFAULT 'ok' NOT NULL,
	`created_at` text DEFAULT (CURRENT_TIMESTAMP),
	CONSTRAINT `fk_tedi_call_costs_tedi_id_tedis_id_fk` FOREIGN KEY (`tedi_id`) REFERENCES `tedis`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_tedi_call_costs_org_id_organizations_id_fk` FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `tedi_custom_domains` (
	`id` text PRIMARY KEY,
	`tedi_id` text NOT NULL,
	`hostname` text NOT NULL CONSTRAINT `uniq_custom_domain_hostname` UNIQUE,
	`status` text DEFAULT 'pending',
	`ssl_status` text DEFAULT 'pending',
	`created_at` text DEFAULT (CURRENT_TIMESTAMP),
	`updated_at` text DEFAULT (CURRENT_TIMESTAMP),
	CONSTRAINT `fk_tedi_custom_domains_tedi_id_tedis_id_fk` FOREIGN KEY (`tedi_id`) REFERENCES `tedis`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `tedi_devices` (
	`id` text PRIMARY KEY,
	`tedi_id` text NOT NULL,
	`device_id` text NOT NULL,
	`display_name` text,
	`platform` text,
	`channel` text,
	`status` text DEFAULT 'pending',
	`paired_at` text,
	`revoked_at` text,
	`created_at` text DEFAULT (CURRENT_TIMESTAMP),
	CONSTRAINT `fk_tedi_devices_tedi_id_tedis_id_fk` FOREIGN KEY (`tedi_id`) REFERENCES `tedis`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `tedi_runtime_leases` (
	`id` text PRIMARY KEY,
	`tedi_id` text NOT NULL,
	`name` text NOT NULL,
	`owner` text NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL,
	`updated_at` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL,
	CONSTRAINT `fk_tedi_runtime_leases_tedi_id_tedis_id_fk` FOREIGN KEY (`tedi_id`) REFERENCES `tedis`(`id`) ON DELETE CASCADE,
	CONSTRAINT `tedi_runtime_leases_scope_unique` UNIQUE(`tedi_id`,`name`)
);
--> statement-breakpoint
CREATE TABLE `tedi_runtime_snapshots` (
	`id` text PRIMARY KEY,
	`tedi_id` text NOT NULL,
	`source` text DEFAULT 'tedi-runtime-admin' NOT NULL,
	`runtime_status` text,
	`runtime_version` text,
	`channel_status` text,
	`device_status` text,
	`observed_at` text NOT NULL,
	`created_at` text DEFAULT (CURRENT_TIMESTAMP),
	CONSTRAINT `fk_tedi_runtime_snapshots_tedi_id_tedis_id_fk` FOREIGN KEY (`tedi_id`) REFERENCES `tedis`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `tedi_usage_events` (
	`id` text PRIMARY KEY,
	`tedi_id` text NOT NULL,
	`event_type` text NOT NULL,
	`started_at` text NOT NULL,
	`ended_at` text,
	`duration_ms` integer,
	`units` real,
	`metadata` text,
	`created_at` text DEFAULT (CURRENT_TIMESTAMP),
	CONSTRAINT `fk_tedi_usage_events_tedi_id_tedis_id_fk` FOREIGN KEY (`tedi_id`) REFERENCES `tedis`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `tedis` (
	`id` text PRIMARY KEY,
	`organization_id` text NOT NULL,
	`owner_user_id` text,
	`scope` text DEFAULT 'personal',
	`name` text NOT NULL,
	`slug` text NOT NULL CONSTRAINT `uniq_tedi_slug` UNIQUE,
	`display_name` text,
	`descope_user_id` text,
	`descope_mcp_resource_id` text,
	`external_ref` text,
	`tags` text,
	`personality` text,
	`avatar` text,
	`timezone` text,
	`language` text,
	`installed_skills` text,
	`installed_plugins` text,
	`status` text DEFAULT 'provisioning',
	`billing_state` text DEFAULT 'cold',
	`worker_name` text,
	`r2_bucket_name` text,
	`mcp_capability_profile` text DEFAULT 'standard' NOT NULL,
	`tool_policy` text,
	`self_improvement_policy` text,
	`budgets` text,
	`quiet_hours` text,
	`governance_override` text,
	`runtime_profile_id` text,
	`policy_pack_id` text,
	`workspace_template_set_id` text,
	`runtime_overrides` text,
	`channels` text,
	`cron_jobs` text,
	`repo_config` text,
	`runtime_state` text DEFAULT 'standby' NOT NULL,
	`last_activity_at` text,
	`last_heartbeat_at` text,
	`idle_since` text,
	`runtime_status` text DEFAULT 'unknown',
	`last_seen_at` text,
	`last_sync_at` text,
	`last_sync_result` text,
	`last_backup_handles` text,
	`placement_id` text,
	`body_generation_id` text,
	`body_generation_kind` text,
	`body_generation_status` text,
	`body_generation_token_hash` text,
	`body_generation_token_expires_at` text,
	`body_generation_external_id` text,
	`body_generation_heartbeat_at` text,
	`runtime_kind` text DEFAULT 'agent' NOT NULL,
	`isolate_agent_id` text,
	`created_at` text DEFAULT (CURRENT_TIMESTAMP),
	`updated_at` text DEFAULT (CURRENT_TIMESTAMP),
	CONSTRAINT `fk_tedis_organization_id_organizations_id_fk` FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_tedis_runtime_profile_id_runtime_profiles_id_fk` FOREIGN KEY (`runtime_profile_id`) REFERENCES `runtime_profiles`(`id`) ON DELETE SET NULL,
	CONSTRAINT `fk_tedis_policy_pack_id_policy_packs_id_fk` FOREIGN KEY (`policy_pack_id`) REFERENCES `policy_packs`(`id`) ON DELETE SET NULL,
	CONSTRAINT `fk_tedis_workspace_template_set_id_workspace_template_sets_id_fk` FOREIGN KEY (`workspace_template_set_id`) REFERENCES `workspace_template_sets`(`id`) ON DELETE SET NULL,
	CONSTRAINT `uniq_tedi_org_slug` UNIQUE(`organization_id`,`slug`)
);
--> statement-breakpoint
CREATE TABLE `app_templates` (
	`id` text PRIMARY KEY,
	`version` integer DEFAULT 1 NOT NULL,
	`name` text NOT NULL,
	`slug` text NOT NULL UNIQUE,
	`description` text,
	`vertical` text NOT NULL,
	`capabilities` text,
	`adapters` text,
	`tools` text,
	`field_mappings` text,
	`extraction_config` text,
	`required_fields` text,
	`optional_fields` text,
	`is_active` integer DEFAULT true NOT NULL,
	`created_at` text DEFAULT (CURRENT_TIMESTAMP),
	`updated_at` text DEFAULT (CURRENT_TIMESTAMP)
);
--> statement-breakpoint
CREATE TABLE `app_tools` (
	`id` text PRIMARY KEY,
	`app_id` text NOT NULL,
	`tool_type_id` text,
	`tool_id` text NOT NULL,
	`title` text NOT NULL,
	`description` text,
	`input_schema` text DEFAULT '{"type":"object","properties":{},"additionalProperties":false}' NOT NULL,
	`output_schema` text,
	`adapter_scope` text DEFAULT 'primary',
	`result_strategy` text DEFAULT 'merge',
	`output_template` text,
	`widget_route` text,
	`widget_key` text,
	`widget_accessible` integer DEFAULT true,
	`auth_required` integer DEFAULT false,
	`visibility` text DEFAULT 'public',
	`icons` text,
	`execution_task_support` text,
	`annotations` text,
	`meta` text,
	`invocation_status` text,
	`file_params` text,
	`widget_description` text,
	`widget_prefers_border` integer DEFAULT true,
	`widget_domain` text,
	`config` text,
	`schema_dialect` text,
	`schema_source` text,
	`schema_source_ref` text,
	`schema_source_hash` text,
	`schema_synced_at` text,
	`enabled` integer DEFAULT true,
	`sort_order` integer DEFAULT 0,
	`created_at` text DEFAULT (CURRENT_TIMESTAMP),
	`updated_at` text DEFAULT (CURRENT_TIMESTAMP),
	CONSTRAINT `fk_app_tools_app_id_apps_id_fk` FOREIGN KEY (`app_id`) REFERENCES `apps`(`id`) ON DELETE CASCADE,
	CONSTRAINT `idx_app_tool_unique` UNIQUE(`app_id`,`tool_id`)
);
--> statement-breakpoint
CREATE TABLE `user_configs` (
	`id` text PRIMARY KEY DEFAULT (lower(
    hex(randomblob(4)) || '-' ||
    hex(randomblob(2)) || '-' ||
    '4' || substr(hex(randomblob(2)), 2) || '-' ||
    substr('89ab', 1 + (abs(random()) % 4), 1) || substr(hex(randomblob(2)), 2) || '-' ||
    hex(randomblob(6))
  )),
	`user_id` text NOT NULL,
	`namespace` text NOT NULL,
	`key` text NOT NULL,
	`value` text NOT NULL,
	`created_at` text DEFAULT (CURRENT_TIMESTAMP),
	`updated_at` text DEFAULT (CURRENT_TIMESTAMP),
	CONSTRAINT `uniq_user_configs_user_namespace_key` UNIQUE(`user_id`,`namespace`,`key`)
);
--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY,
	`email` text NOT NULL CONSTRAINT `uniq_users_email` UNIQUE,
	`name` text,
	`avatar_url` text,
	`metadata` text,
	`last_login_at` text,
	`created_at` text DEFAULT (CURRENT_TIMESTAMP),
	`updated_at` text DEFAULT (CURRENT_TIMESTAMP)
);
--> statement-breakpoint
CREATE TABLE `work_item_checkouts` (
	`id` text PRIMARY KEY,
	`work_item_id` text NOT NULL,
	`org_id` text NOT NULL,
	`tedi_id` text NOT NULL,
	`run_id` text,
	`status` text DEFAULT 'active' NOT NULL,
	`claimed_at` text NOT NULL,
	`expires_at` text,
	`released_at` text,
	`release_reason` text,
	`metadata` text DEFAULT '{}',
	CONSTRAINT `fk_work_item_checkouts_work_item_id_work_items_id_fk` FOREIGN KEY (`work_item_id`) REFERENCES `work_items`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_work_item_checkouts_org_id_organizations_id_fk` FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_work_item_checkouts_tedi_id_tedis_id_fk` FOREIGN KEY (`tedi_id`) REFERENCES `tedis`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `work_item_comments` (
	`id` text PRIMARY KEY,
	`work_item_id` text NOT NULL,
	`org_id` text NOT NULL,
	`author_type` text NOT NULL,
	`author_id` text,
	`body` text NOT NULL,
	`event_type` text DEFAULT 'comment' NOT NULL,
	`metadata` text DEFAULT '{}',
	`created_at` text NOT NULL,
	CONSTRAINT `fk_work_item_comments_work_item_id_work_items_id_fk` FOREIGN KEY (`work_item_id`) REFERENCES `work_items`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_work_item_comments_org_id_organizations_id_fk` FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `work_item_corroborations` (
	`id` text PRIMARY KEY,
	`org_id` text NOT NULL,
	`work_item_id` text NOT NULL,
	`principal_type` text NOT NULL,
	`principal_id` text NOT NULL,
	`session_id` text,
	`evidence_ref` text NOT NULL,
	`body` text NOT NULL,
	`occurred_at` text NOT NULL,
	`created_at` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL,
	CONSTRAINT `fk_work_item_corroborations_org_id_organizations_id_fk` FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_work_item_corroborations_work_item_id_work_items_id_fk` FOREIGN KEY (`work_item_id`) REFERENCES `work_items`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_work_item_corroboration_item_org` FOREIGN KEY (`org_id`,`work_item_id`) REFERENCES `work_items`(`org_id`,`id`) ON DELETE CASCADE,
	CONSTRAINT "chk_work_item_corroboration_principal_type" CHECK("principal_type" IN ('user', 'organization', 'tedi', 'external_agent')),
	CONSTRAINT "chk_work_item_corroboration_identity" CHECK(length("principal_id") > 0 AND length("evidence_ref") > 0)
);
--> statement-breakpoint
CREATE TABLE `work_item_executor_checkouts` (
	`id` text PRIMARY KEY,
	`work_item_id` text NOT NULL,
	`org_id` text NOT NULL,
	`executor_type` text NOT NULL,
	`executor_id` text NOT NULL,
	`executor_session_id` text,
	`run_id` text,
	`status` text DEFAULT 'active' NOT NULL,
	`claimed_at` text NOT NULL,
	`expires_at` text,
	`released_at` text,
	`release_reason` text,
	`metadata` text DEFAULT '{}' NOT NULL,
	CONSTRAINT `fk_work_item_executor_checkouts_org_id_organizations_id_fk` FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_work_item_executor_checkout_item_org` FOREIGN KEY (`org_id`,`work_item_id`) REFERENCES `work_items`(`org_id`,`id`) ON DELETE CASCADE,
	CONSTRAINT "chk_work_item_executor_checkout_identity" CHECK(("executor_type" = 'tedi' AND "executor_session_id" IS NULL) OR ("executor_type" = 'external_agent' AND "executor_session_id" IS NOT NULL)),
	CONSTRAINT "chk_work_item_executor_checkout_id" CHECK(length("executor_id") > 0),
	CONSTRAINT "chk_work_item_executor_checkout_release_state" CHECK(("status" = 'active' AND "released_at" IS NULL) OR ("status" != 'active' AND "released_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE `work_item_lease_sweep_cursors` (
	`scope_key` text PRIMARY KEY,
	`legacy_sort_at` text,
	`legacy_checkout_id` text,
	`executor_sort_at` text,
	`executor_checkout_id` text,
	`updated_at` text NOT NULL,
	CONSTRAINT "chk_work_item_lease_sweep_legacy_cursor" CHECK(("legacy_sort_at" IS NULL AND "legacy_checkout_id" IS NULL) OR ("legacy_sort_at" IS NOT NULL AND "legacy_checkout_id" IS NOT NULL)),
	CONSTRAINT "chk_work_item_lease_sweep_executor_cursor" CHECK(("executor_sort_at" IS NULL AND "executor_checkout_id" IS NULL) OR ("executor_sort_at" IS NOT NULL AND "executor_checkout_id" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE `work_item_projections` (
	`id` text PRIMARY KEY,
	`work_item_id` text NOT NULL,
	`org_id` text NOT NULL,
	`provider` text NOT NULL,
	`direction` text DEFAULT 'projection' NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`external_id` text,
	`external_url` text,
	`external_project_id` text,
	`external_section_id` text,
	`last_synced_at` text,
	`last_error` text,
	`sync_cursor` text,
	`provider_state` text DEFAULT '{}',
	`created_at` text NOT NULL,
	`updated_at` text,
	CONSTRAINT `fk_work_item_projections_work_item_id_work_items_id_fk` FOREIGN KEY (`work_item_id`) REFERENCES `work_items`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_work_item_projections_org_id_organizations_id_fk` FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `work_item_relations` (
	`id` text PRIMARY KEY,
	`org_id` text NOT NULL,
	`from_work_item_id` text NOT NULL,
	`to_work_item_id` text NOT NULL,
	`relation_type` text NOT NULL,
	`metadata` text DEFAULT '{}',
	`created_at` text NOT NULL,
	CONSTRAINT `fk_work_item_relations_org_id_organizations_id_fk` FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_work_item_relations_from_work_item_id_work_items_id_fk` FOREIGN KEY (`from_work_item_id`) REFERENCES `work_items`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_work_item_relations_to_work_item_id_work_items_id_fk` FOREIGN KEY (`to_work_item_id`) REFERENCES `work_items`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `work_items` (
	`id` text PRIMARY KEY,
	`org_id` text NOT NULL,
	`title` text NOT NULL,
	`description` text,
	`item_type` text DEFAULT 'work_item' NOT NULL,
	`status` text DEFAULT 'accepted' NOT NULL,
	`priority` text DEFAULT 'medium' NOT NULL,
	`owner_type` text,
	`owner_id` text,
	`assignee_tedi_id` text,
	`assignee_user_id` text,
	`objective_id` text,
	`work_class` text,
	`purpose_exception_expires_at` text,
	`internal_task_id` text,
	`project_key` text,
	`project_id` text,
	`parent_work_item_id` text,
	`source_session_key` text,
	`source_intent_id` text,
	`active_flow_id` text,
	`active_task_id` text,
	`checkout_run_id` text,
	`claimed_by_tedi_id` text,
	`claimed_by_executor_type` text,
	`claimed_by_executor_id` text,
	`claimed_by_executor_session_id` text,
	`claimed_at` text,
	`due_date` text,
	`deadline` text,
	`provenance` text DEFAULT '{}',
	`metadata` text DEFAULT '{}',
	`created_at` text NOT NULL,
	`updated_at` text,
	`completed_at` text,
	CONSTRAINT `fk_work_items_org_id_organizations_id_fk` FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_work_items_assignee_tedi_id_tedis_id_fk` FOREIGN KEY (`assignee_tedi_id`) REFERENCES `tedis`(`id`) ON DELETE SET NULL,
	CONSTRAINT `fk_work_items_objective_id_tedi_objectives_id_fk` FOREIGN KEY (`objective_id`) REFERENCES `tedi_objectives`(`id`) ON DELETE SET NULL,
	CONSTRAINT `fk_work_items_internal_task_id_tedi_tasks_id_fk` FOREIGN KEY (`internal_task_id`) REFERENCES `tedi_tasks`(`id`) ON DELETE SET NULL,
	CONSTRAINT `fk_work_items_project_id_projects_id_fk` FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON DELETE SET NULL,
	CONSTRAINT `fk_work_items_claimed_by_tedi_id_tedis_id_fk` FOREIGN KEY (`claimed_by_tedi_id`) REFERENCES `tedis`(`id`) ON DELETE SET NULL
);
--> statement-breakpoint
CREATE TABLE `workstation_leases` (
	`id` text PRIMARY KEY,
	`workstation_id` text NOT NULL,
	`profile_id` text NOT NULL,
	`org_id` text,
	`work_item_id` text,
	`kernel_run_id` text,
	`trace_bundle_id` text,
	`status` text NOT NULL,
	`capabilities` text DEFAULT '[]' NOT NULL,
	`adapters` text DEFAULT '[]' NOT NULL,
	`approval_ids` text DEFAULT '[]' NOT NULL,
	`artifact_refs` text DEFAULT '[]' NOT NULL,
	`metadata` text DEFAULT '{}' NOT NULL,
	`body_generation_id` text,
	`body_generation_kind` text,
	`body_generation_status` text,
	`body_generation_token_hash` text,
	`body_generation_token_expires_at` text,
	`body_generation_external_id` text,
	`body_generation_heartbeat_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`expires_at` text,
	`released_at` text,
	CONSTRAINT `fk_workstation_leases_workstation_id_workstations_id_fk` FOREIGN KEY (`workstation_id`) REFERENCES `workstations`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_workstation_leases_org_id_organizations_id_fk` FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_workstation_leases_work_item_id_work_items_id_fk` FOREIGN KEY (`work_item_id`) REFERENCES `work_items`(`id`) ON DELETE SET NULL
);
--> statement-breakpoint
CREATE TABLE `workstation_participants` (
	`id` text PRIMARY KEY,
	`lease_id` text NOT NULL,
	`org_id` text,
	`tedi_id` text NOT NULL,
	`slug` text,
	`role` text NOT NULL,
	`status` text NOT NULL,
	`permission_scopes` text DEFAULT '[]' NOT NULL,
	`joined_at` text NOT NULL,
	`left_at` text,
	`metadata` text DEFAULT '{}' NOT NULL,
	CONSTRAINT `fk_workstation_participants_lease_id_workstation_leases_id_fk` FOREIGN KEY (`lease_id`) REFERENCES `workstation_leases`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_workstation_participants_org_id_organizations_id_fk` FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_workstation_participants_tedi_id_tedis_id_fk` FOREIGN KEY (`tedi_id`) REFERENCES `tedis`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `workstation_sessions` (
	`id` text PRIMARY KEY,
	`lease_id` text NOT NULL,
	`org_id` text,
	`participant_id` text,
	`kind` text NOT NULL,
	`adapter` text NOT NULL,
	`status` text NOT NULL,
	`session_key` text,
	`external_id` text,
	`artifact_refs` text DEFAULT '[]' NOT NULL,
	`started_at` text NOT NULL,
	`ended_at` text,
	`metadata` text DEFAULT '{}' NOT NULL,
	CONSTRAINT `fk_workstation_sessions_lease_id_workstation_leases_id_fk` FOREIGN KEY (`lease_id`) REFERENCES `workstation_leases`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_workstation_sessions_org_id_organizations_id_fk` FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_workstation_sessions_participant_id_workstation_participants_id_fk` FOREIGN KEY (`participant_id`) REFERENCES `workstation_participants`(`id`) ON DELETE SET NULL
);
--> statement-breakpoint
CREATE TABLE `workstations` (
	`id` text PRIMARY KEY,
	`profile_id` text NOT NULL,
	`org_id` text,
	`status` text NOT NULL,
	`seats` text DEFAULT '[]' NOT NULL,
	`capabilities` text DEFAULT '[]' NOT NULL,
	`adapters` text DEFAULT '[]' NOT NULL,
	`artifact_refs` text DEFAULT '[]' NOT NULL,
	`metadata` text DEFAULT '{}' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	CONSTRAINT `fk_workstations_org_id_organizations_id_fk` FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `tedi_approval_requests` (
	`id` text PRIMARY KEY,
	`tedi_id` text NOT NULL,
	`org_id` text NOT NULL,
	`action_type` text NOT NULL,
	`description` text NOT NULL,
	`payload` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`created_at` text NOT NULL,
	`expires_at` text NOT NULL,
	`resolved_at` text,
	`resolved_by` text,
	`resolution` text,
	`workflow_id` text,
	CONSTRAINT `fk_tedi_approval_requests_tedi_id_tedis_id_fk` FOREIGN KEY (`tedi_id`) REFERENCES `tedis`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_tedi_approval_requests_org_id_organizations_id_fk` FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `audit_events` (
	`id` text PRIMARY KEY,
	`organization_id` text NOT NULL,
	`actor_id` text NOT NULL,
	`actor_type` text NOT NULL,
	`action` text NOT NULL,
	`resource_type` text NOT NULL,
	`resource_id` text,
	`metadata` text,
	`ip_address` text,
	`user_agent` text,
	`timestamp` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `knowledge_entries` (
	`id` text PRIMARY KEY,
	`organization_id` text NOT NULL,
	`tedi_id` text,
	`domain_id` text,
	`title` text NOT NULL,
	`content` text NOT NULL,
	`entry_type` text NOT NULL,
	`source_fact_ids` text,
	`source_count` integer DEFAULT 0 NOT NULL,
	`confidence` real DEFAULT 0.8 NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL,
	`revision_reasoning` text,
	`supersedes_id` text,
	`visibility` text DEFAULT 'private' NOT NULL,
	`tags` text,
	`last_validated_at` text,
	`created_at` text DEFAULT (CURRENT_TIMESTAMP),
	`updated_at` text DEFAULT (CURRENT_TIMESTAMP),
	CONSTRAINT `fk_knowledge_entries_organization_id_organizations_id_fk` FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_knowledge_entries_tedi_id_tedis_id_fk` FOREIGN KEY (`tedi_id`) REFERENCES `tedis`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_knowledge_entries_domain_id_memory_domains_id_fk` FOREIGN KEY (`domain_id`) REFERENCES `memory_domains`(`id`) ON DELETE SET NULL
);
--> statement-breakpoint
CREATE TABLE `skill_entries` (
	`id` text PRIMARY KEY,
	`organization_id` text NOT NULL,
	`tedi_id` text,
	`domain_id` text,
	`title` text NOT NULL,
	`slug` text,
	`description` text,
	`content` text NOT NULL,
	`files` text,
	`input_schema` text,
	`success_count` integer DEFAULT 0 NOT NULL,
	`failure_count` integer DEFAULT 0 NOT NULL,
	`last_used_at` text,
	`avg_duration_ms` integer,
	`revision` integer DEFAULT 1 NOT NULL,
	`revision_reasoning` text,
	`supersedes_id` text,
	`source_skill_id` text,
	`source_revision` integer,
	`visibility` text DEFAULT 'private' NOT NULL,
	`agent_skills_format` text,
	`r2_path` text,
	`app_id` text,
	`tool_ids` text,
	`summary` text,
	`tags` text,
	`audience` text,
	`preconditions` text,
	`lifecycle_state` text DEFAULT 'draft',
	`review_flagged_at` text,
	`review_flag_reason` text,
	`pace_layer` text,
	`proposed_by_tedi_id` text,
	`created_at` text DEFAULT (CURRENT_TIMESTAMP),
	`updated_at` text DEFAULT (CURRENT_TIMESTAMP),
	CONSTRAINT `fk_skill_entries_organization_id_organizations_id_fk` FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_skill_entries_tedi_id_tedis_id_fk` FOREIGN KEY (`tedi_id`) REFERENCES `tedis`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_skill_entries_domain_id_memory_domains_id_fk` FOREIGN KEY (`domain_id`) REFERENCES `memory_domains`(`id`) ON DELETE SET NULL,
	CONSTRAINT `fk_skill_entries_source_skill_id_skill_entries_id_fk` FOREIGN KEY (`source_skill_id`) REFERENCES `skill_entries`(`id`) ON DELETE SET NULL,
	CONSTRAINT `fk_skill_entries_app_id_apps_id_fk` FOREIGN KEY (`app_id`) REFERENCES `apps`(`id`) ON DELETE SET NULL
);
--> statement-breakpoint
CREATE TABLE `skill_run_artifacts` (
	`id` text PRIMARY KEY,
	`run_id` text NOT NULL,
	`path` text NOT NULL,
	`mime_type` text DEFAULT 'application/json' NOT NULL,
	`size_bytes` integer DEFAULT 0 NOT NULL,
	`content_inline` text,
	`content_r2_key` text,
	`sha256` text,
	`attempt` integer DEFAULT 1 NOT NULL,
	`outcome` text DEFAULT 'success' NOT NULL,
	`created_at` text DEFAULT (CURRENT_TIMESTAMP),
	CONSTRAINT `fk_skill_run_artifacts_run_id_skill_runs_id_fk` FOREIGN KEY (`run_id`) REFERENCES `skill_runs`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `skill_runs` (
	`id` text PRIMARY KEY,
	`organization_id` text NOT NULL,
	`skill_id` text NOT NULL,
	`tedi_id` text NOT NULL,
	`workflow_instance_id` text NOT NULL,
	`execution_epoch` integer DEFAULT 0 NOT NULL,
	`restart_requested_at` text,
	`restart_command_id` text,
	`workflow_retired_at` text,
	`runtime_environment` text,
	`last_reconciled_at` text,
	`status` text DEFAULT 'queued' NOT NULL,
	`params` text,
	`result` text,
	`error` text,
	`capability_manifest` text,
	`cost_summary` text,
	`workflow_source` text,
	`skill_doc` text,
	`skill_revision` integer,
	`skill_slug` text,
	`started_at` text DEFAULT (CURRENT_TIMESTAMP),
	`completed_at` text,
	`paused_at` text,
	`created_by` text,
	CONSTRAINT `fk_skill_runs_organization_id_organizations_id_fk` FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_skill_runs_skill_id_skill_entries_id_fk` FOREIGN KEY (`skill_id`) REFERENCES `skill_entries`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_skill_runs_tedi_id_tedis_id_fk` FOREIGN KEY (`tedi_id`) REFERENCES `tedis`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `skill_schedules` (
	`id` text PRIMARY KEY,
	`organization_id` text NOT NULL,
	`skill_id` text NOT NULL,
	`tedi_id` text NOT NULL,
	`cron` text NOT NULL,
	`params` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`next_fire_at` text NOT NULL,
	`last_fire_at` text,
	`last_run_id` text,
	`last_error` text,
	`created_at` text DEFAULT (CURRENT_TIMESTAMP),
	`updated_at` text DEFAULT (CURRENT_TIMESTAMP),
	CONSTRAINT `fk_skill_schedules_organization_id_organizations_id_fk` FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_skill_schedules_skill_id_skill_entries_id_fk` FOREIGN KEY (`skill_id`) REFERENCES `skill_entries`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_skill_schedules_tedi_id_tedis_id_fk` FOREIGN KEY (`tedi_id`) REFERENCES `tedis`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `skill_usage_events` (
	`id` text PRIMARY KEY,
	`organization_id` text NOT NULL,
	`tedi_id` text,
	`skill_id` text NOT NULL,
	`run_id` text NOT NULL,
	`execution_epoch` integer DEFAULT 0 NOT NULL,
	`source` text NOT NULL,
	`outcome` text NOT NULL,
	`error` text,
	`started_at` text,
	`finished_at` text,
	`duration_ms` integer,
	`created_at` text DEFAULT (CURRENT_TIMESTAMP),
	CONSTRAINT `fk_skill_usage_events_organization_id_organizations_id_fk` FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_skill_usage_events_tedi_id_tedis_id_fk` FOREIGN KEY (`tedi_id`) REFERENCES `tedis`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_skill_usage_events_skill_id_skill_entries_id_fk` FOREIGN KEY (`skill_id`) REFERENCES `skill_entries`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `tedi_muscle_memory` (
	`id` text PRIMARY KEY,
	`tedi_id` text NOT NULL,
	`organization_id` text NOT NULL,
	`kind` text NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`r2_path` text,
	`usage_count` integer DEFAULT 0 NOT NULL,
	`success_count` integer DEFAULT 0 NOT NULL,
	`failure_count` integer DEFAULT 0 NOT NULL,
	`last_used_at` text,
	`origin` text NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`source_skill_id` text,
	`code_module` text,
	`allowed_namespaces` text,
	`created_at` text DEFAULT (CURRENT_TIMESTAMP),
	`updated_at` text DEFAULT (CURRENT_TIMESTAMP),
	CONSTRAINT `fk_tedi_muscle_memory_tedi_id_tedis_id_fk` FOREIGN KEY (`tedi_id`) REFERENCES `tedis`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_tedi_muscle_memory_organization_id_organizations_id_fk` FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_tedi_muscle_memory_source_skill_id_skill_entries_id_fk` FOREIGN KEY (`source_skill_id`) REFERENCES `skill_entries`(`id`) ON DELETE SET NULL
);
--> statement-breakpoint
CREATE TABLE `tedi_workspace_edits` (
	`id` text PRIMARY KEY,
	`tedi_id` text NOT NULL,
	`organization_id` text NOT NULL,
	`filename` text NOT NULL,
	`generated_hash` text NOT NULL,
	`live_hash` text NOT NULL,
	`added_sections` text,
	`removed_sections` text,
	`added_line_count` integer DEFAULT 0 NOT NULL,
	`removed_line_count` integer DEFAULT 0 NOT NULL,
	`category` text DEFAULT 'unknown' NOT NULL,
	`detected_at` text DEFAULT (CURRENT_TIMESTAMP),
	CONSTRAINT `fk_tedi_workspace_edits_tedi_id_tedis_id_fk` FOREIGN KEY (`tedi_id`) REFERENCES `tedis`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_tedi_workspace_edits_organization_id_organizations_id_fk` FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `chat_dispatch_idempotency` (
	`idempotency_key` text PRIMARY KEY,
	`tedi_id` text NOT NULL,
	`organization_id` text,
	`conversation_id` text NOT NULL,
	`run_id` text,
	`status` text DEFAULT 'queued' NOT NULL,
	`created_at` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL,
	`mapped_at` text
);
--> statement-breakpoint
CREATE TABLE `kernel_conversation_grants` (
	`id` text PRIMARY KEY,
	`organization_id` text NOT NULL,
	`conversation_id` text NOT NULL,
	`grantee_descope_user_id` text NOT NULL,
	`access` text NOT NULL,
	`created_by_descope_user_id` text,
	`created_at` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL,
	`updated_at` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL,
	CONSTRAINT `fk_kernel_conversation_grants_organization_id_organizations_id_fk` FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `kernel_conversations` (
	`id` text PRIMARY KEY,
	`organization_id` text NOT NULL,
	`conversation_id` text NOT NULL,
	`title` text,
	`title_source` text,
	`channel` text,
	`last_message_at` text NOT NULL,
	`message_count` integer DEFAULT 0 NOT NULL,
	`deleted_at` text,
	`pinned_at` text,
	`created_at` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL,
	`updated_at` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL,
	CONSTRAINT `fk_kernel_conversations_organization_id_organizations_id_fk` FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `kernel_home_approval_mirrors` (
	`id` text PRIMARY KEY,
	`organization_id` text NOT NULL,
	`parent_conversation_id` text NOT NULL,
	`child_run_id` text NOT NULL,
	`approval_request_id` text NOT NULL,
	`delegated_tedi_id` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`blocked_at` text NOT NULL,
	`escalate_at` integer NOT NULL,
	`escalated_at` text,
	`cleared_at` text,
	`created_at` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL,
	`updated_at` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL,
	CONSTRAINT `fk_kernel_home_approval_mirrors_organization_id_organizations_id_fk` FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_kernel_home_approval_mirrors_approval_request_id_tedi_approval_requests_id_fk` FOREIGN KEY (`approval_request_id`) REFERENCES `tedi_approval_requests`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_kernel_home_approval_mirrors_delegated_tedi_id_tedis_id_fk` FOREIGN KEY (`delegated_tedi_id`) REFERENCES `tedis`(`id`) ON DELETE SET NULL
);
--> statement-breakpoint
CREATE TABLE `kernel_runtime_events` (
	`id` text PRIMARY KEY,
	`organization_id` text NOT NULL,
	`kind` text NOT NULL,
	`conversation_id` text NOT NULL,
	`run_id` text,
	`message_id` text,
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
	`created_at` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL,
	CONSTRAINT `fk_kernel_runtime_events_organization_id_organizations_id_fk` FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_kernel_runtime_events_delegated_tedi_id_tedis_id_fk` FOREIGN KEY (`delegated_tedi_id`) REFERENCES `tedis`(`id`) ON DELETE SET NULL
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
	CONSTRAINT `fk_kernel_runtime_runs_organization_id_organizations_id_fk` FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_kernel_runtime_runs_delegated_tedi_id_tedis_id_fk` FOREIGN KEY (`delegated_tedi_id`) REFERENCES `tedis`(`id`) ON DELETE SET NULL
);
--> statement-breakpoint
CREATE TABLE `kernel_wake_queue` (
	`id` text PRIMARY KEY,
	`organization_id` text NOT NULL,
	`parent_conversation_id` text NOT NULL,
	`child_run_id` text NOT NULL,
	`child_status` text NOT NULL,
	`queued_at` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL,
	`acked_at` text,
	`wake_kind` text DEFAULT 'child_completed' NOT NULL,
	CONSTRAINT `fk_kernel_wake_queue_organization_id_organizations_id_fk` FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON DELETE CASCADE
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
	`created_at` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL,
	CONSTRAINT `fk_tedi_artifacts_organization_id_organizations_id_fk` FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_tedi_artifacts_tedi_id_tedis_id_fk` FOREIGN KEY (`tedi_id`) REFERENCES `tedis`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `tedi_runtime_events` (
	`id` text PRIMARY KEY,
	`organization_id` text NOT NULL,
	`tedi_id` text NOT NULL,
	`kind` text NOT NULL,
	`conversation_id` text,
	`run_id` text,
	`message_id` text,
	`tool_call_id` text,
	`approval_request_id` text,
	`artifact_id` text,
	`sequence` integer,
	`delta` text,
	`payload` text,
	`runtime_backend` text NOT NULL,
	`runtime_external_id` text,
	`runtime_external_url` text,
	`runtime_metadata` text,
	`trace_id` text,
	`created_at` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL,
	CONSTRAINT `fk_tedi_runtime_events_organization_id_organizations_id_fk` FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_tedi_runtime_events_tedi_id_tedis_id_fk` FOREIGN KEY (`tedi_id`) REFERENCES `tedis`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `content_sources` (
	`id` text PRIMARY KEY,
	`app_id` text NOT NULL,
	`source_type` text NOT NULL,
	`source_url` text NOT NULL,
	`title` text,
	`last_ingested_at` text,
	`last_ingest_status` text DEFAULT 'pending',
	`document_count` integer DEFAULT 0,
	`config` text,
	`last_error` text,
	`created_at` text DEFAULT (CURRENT_TIMESTAMP),
	`updated_at` text DEFAULT (CURRENT_TIMESTAMP),
	CONSTRAINT `fk_content_sources_app_id_apps_id_fk` FOREIGN KEY (`app_id`) REFERENCES `apps`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `policy_packs` (
	`id` text PRIMARY KEY DEFAULT (lower(
    hex(randomblob(4)) || '-' ||
    hex(randomblob(2)) || '-' ||
    '4' || substr(hex(randomblob(2)), 2) || '-' ||
    substr('89ab', 1 + (abs(random()) % 4), 1) || substr(hex(randomblob(2)), 2) || '-' ||
    hex(randomblob(6))
  )),
	`organization_id` text,
	`name` text NOT NULL,
	`slug` text NOT NULL,
	`description` text,
	`scope` text DEFAULT 'organization' NOT NULL,
	`target` text DEFAULT 'shared' NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`definition` text NOT NULL,
	`created_at` text DEFAULT (CURRENT_TIMESTAMP),
	`updated_at` text DEFAULT (CURRENT_TIMESTAMP),
	CONSTRAINT `fk_policy_packs_organization_id_organizations_id_fk` FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON DELETE CASCADE,
	CONSTRAINT `uniq_policy_packs_scope_slug` UNIQUE(`scope`,`slug`)
);
--> statement-breakpoint
CREATE TABLE `runtime_profiles` (
	`id` text PRIMARY KEY DEFAULT (lower(
    hex(randomblob(4)) || '-' ||
    hex(randomblob(2)) || '-' ||
    '4' || substr(hex(randomblob(2)), 2) || '-' ||
    substr('89ab', 1 + (abs(random()) % 4), 1) || substr(hex(randomblob(2)), 2) || '-' ||
    hex(randomblob(6))
  )),
	`organization_id` text,
	`name` text NOT NULL,
	`slug` text NOT NULL,
	`description` text,
	`scope` text DEFAULT 'organization' NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`config` text NOT NULL,
	`created_at` text DEFAULT (CURRENT_TIMESTAMP),
	`updated_at` text DEFAULT (CURRENT_TIMESTAMP),
	CONSTRAINT `fk_runtime_profiles_organization_id_organizations_id_fk` FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON DELETE CASCADE,
	CONSTRAINT `uniq_runtime_profiles_scope_slug` UNIQUE(`scope`,`slug`)
);
--> statement-breakpoint
CREATE TABLE `workspace_template_sets` (
	`id` text PRIMARY KEY DEFAULT (lower(
    hex(randomblob(4)) || '-' ||
    hex(randomblob(2)) || '-' ||
    '4' || substr(hex(randomblob(2)), 2) || '-' ||
    substr('89ab', 1 + (abs(random()) % 4), 1) || substr(hex(randomblob(2)), 2) || '-' ||
    hex(randomblob(6))
  )),
	`organization_id` text,
	`name` text NOT NULL,
	`slug` text NOT NULL,
	`description` text,
	`scope` text DEFAULT 'organization' NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`templates` text NOT NULL,
	`created_at` text DEFAULT (CURRENT_TIMESTAMP),
	`updated_at` text DEFAULT (CURRENT_TIMESTAMP),
	CONSTRAINT `fk_workspace_template_sets_organization_id_organizations_id_fk` FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON DELETE CASCADE,
	CONSTRAINT `uniq_workspace_template_sets_scope_slug` UNIQUE(`scope`,`slug`)
);
--> statement-breakpoint
CREATE TABLE `tedi_cron_executions` (
	`id` text PRIMARY KEY,
	`tedi_id` text NOT NULL,
	`org_id` text NOT NULL,
	`cron_name` text NOT NULL,
	`fire_key` text NOT NULL,
	`run_id` text,
	`status` text DEFAULT 'running' NOT NULL,
	`started_at` text NOT NULL,
	`finished_at` text,
	`transitions` text,
	`error` text,
	`created_at` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL,
	CONSTRAINT `fk_tedi_cron_executions_tedi_id_tedis_id_fk` FOREIGN KEY (`tedi_id`) REFERENCES `tedis`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_tedi_cron_executions_org_id_organizations_id_fk` FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `competency_observation_attestations` (
	`id` text PRIMARY KEY,
	`organization_id` text NOT NULL,
	`observation_id` text NOT NULL,
	`principal_type` text NOT NULL,
	`principal_id` text NOT NULL,
	`verdict` text NOT NULL,
	`verification_method` text NOT NULL,
	`independence_verified` integer NOT NULL,
	`authenticated_at` text NOT NULL,
	`created_at` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL,
	CONSTRAINT `fk_competency_observation_attestations_organization_id_organizations_id_fk` FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_competency_observation_attestations_observation_id_competency_observations_id_fk` FOREIGN KEY (`observation_id`) REFERENCES `competency_observations`(`id`) ON DELETE CASCADE,
	CONSTRAINT "chk_competency_attestation_principal" CHECK("principal_type" IN ('user', 'api_key', 'certification_service', 'external_agent')),
	CONSTRAINT "chk_competency_attestation_verdict" CHECK("verdict" IN ('supports', 'rejects')),
	CONSTRAINT "chk_competency_attestation_independence" CHECK("independence_verified" IN (0, 1))
);
--> statement-breakpoint
CREATE TABLE `competency_observations` (
	`id` text PRIMARY KEY,
	`organization_id` text NOT NULL,
	`tedi_id` text NOT NULL,
	`executor_type` text NOT NULL,
	`executor_id` text NOT NULL,
	`activity_id` text NOT NULL,
	`client_observation_id` text NOT NULL,
	`input_hash` text NOT NULL,
	`execution_opportunity_id` text NOT NULL,
	`work_item_id` text,
	`source_kind` text NOT NULL,
	`source_id` text NOT NULL,
	`trace_bundle_id` text,
	`rationale_id` text,
	`task_family` text NOT NULL,
	`risk_level` text NOT NULL,
	`environment` text NOT NULL,
	`rubric_version` integer NOT NULL,
	`harness` text NOT NULL,
	`harness_version` text NOT NULL,
	`model_provider` text NOT NULL,
	`model_id` text NOT NULL,
	`model_version` text NOT NULL,
	`outcome` text NOT NULL,
	`complexity` real NOT NULL,
	`non_trivial` integer NOT NULL,
	`held_out` integer NOT NULL,
	`calibration_score` real NOT NULL,
	`escalation_quality` real NOT NULL,
	`learning_transfer` integer NOT NULL,
	`evidence_refs` text NOT NULL,
	`eligibility_status` text DEFAULT 'pending' NOT NULL,
	`evaluator_type` text,
	`evaluator_id` text,
	`classification_method` text NOT NULL,
	`evaluation_run_id` text,
	`proof_verified_at` text,
	`cost_minor_units` integer,
	`cost_currency` text,
	`duration_ms` integer,
	`owner_review_minutes` real,
	`policy_violation_severity` integer DEFAULT 0 NOT NULL,
	`confidence` real NOT NULL,
	`metadata` text,
	`occurred_at` text NOT NULL,
	`created_at` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL,
	CONSTRAINT `fk_competency_observations_organization_id_organizations_id_fk` FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_competency_observations_tedi_id_tedis_id_fk` FOREIGN KEY (`tedi_id`) REFERENCES `tedis`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_competency_observations_activity_id_entrustable_activities_id_fk` FOREIGN KEY (`activity_id`) REFERENCES `entrustable_activities`(`id`) ON DELETE RESTRICT,
	CONSTRAINT `fk_competency_observations_work_item_id_work_items_id_fk` FOREIGN KEY (`work_item_id`) REFERENCES `work_items`(`id`) ON DELETE SET NULL,
	CONSTRAINT "chk_competency_observation_rubric" CHECK("rubric_version" > 0),
	CONSTRAINT "chk_competency_observation_outcome" CHECK("outcome" IN ('success', 'partial', 'failure', 'unverified')),
	CONSTRAINT "chk_competency_observation_executor" CHECK("executor_type" IN ('tedi', 'external_agent', 'service')),
	CONSTRAINT "chk_competency_observation_risk" CHECK("risk_level" IN ('low', 'medium', 'high', 'critical')),
	CONSTRAINT "chk_competency_observation_eligibility" CHECK("eligibility_status" IN ('pending', 'eligible', 'ineligible')),
	CONSTRAINT "chk_competency_observation_scores" CHECK("complexity" >= 0 AND "complexity" <= 1 AND "confidence" >= 0 AND "confidence" <= 1 AND "calibration_score" >= 0 AND "calibration_score" <= 1 AND "escalation_quality" >= 0 AND "escalation_quality" <= 1),
	CONSTRAINT "chk_competency_observation_booleans" CHECK("non_trivial" IN (0, 1) AND "held_out" IN (0, 1) AND "learning_transfer" IN (0, 1)),
	CONSTRAINT "chk_competency_observation_nonnegative" CHECK(("cost_minor_units" IS NULL OR "cost_minor_units" >= 0) AND ("duration_ms" IS NULL OR "duration_ms" >= 0) AND ("owner_review_minutes" IS NULL OR "owner_review_minutes" >= 0) AND "policy_violation_severity" >= 0),
	CONSTRAINT "chk_competency_observation_currency" CHECK(("cost_minor_units" IS NULL AND "cost_currency" IS NULL) OR ("cost_minor_units" IS NOT NULL AND "cost_currency" IS NOT NULL AND length("cost_currency") = 3)),
	CONSTRAINT "chk_competency_observation_eligible_proof" CHECK("eligibility_status" != 'eligible' OR (json_array_length("evidence_refs") > 0 AND "proof_verified_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE `delegation_value_claims` (
	`id` text PRIMARY KEY,
	`organization_id` text NOT NULL,
	`tedi_id` text NOT NULL,
	`observation_id` text NOT NULL,
	`work_item_id` text NOT NULL,
	`evaluation_run_id` text NOT NULL,
	`executor_type` text DEFAULT 'tedi' NOT NULL,
	`executor_id` text NOT NULL,
	`value_event_id` text NOT NULL,
	`value_evidence_ref` text NOT NULL,
	`value_minor_units` integer NOT NULL,
	`currency` text NOT NULL,
	`created_at` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL,
	CONSTRAINT `fk_delegation_value_claims_organization_id_organizations_id_fk` FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_delegation_value_claims_tedi_id_tedis_id_fk` FOREIGN KEY (`tedi_id`) REFERENCES `tedis`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_delegation_value_claims_observation_id_competency_observations_id_fk` FOREIGN KEY (`observation_id`) REFERENCES `competency_observations`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_delegation_value_claims_work_item_id_work_items_id_fk` FOREIGN KEY (`work_item_id`) REFERENCES `work_items`(`id`) ON DELETE RESTRICT,
	CONSTRAINT "chk_delegation_value_claim_executor" CHECK("executor_type" = 'tedi' AND "executor_id" = "tedi_id"),
	CONSTRAINT "chk_delegation_value_claim_value" CHECK("value_minor_units" >= 0 AND "value_minor_units" <= 9000000000),
	CONSTRAINT "chk_delegation_value_claim_currency" CHECK(length("currency") = 3 AND "currency" = upper("currency")),
	CONSTRAINT "chk_delegation_value_claim_identity" CHECK(length("value_event_id") > 0 AND length("value_event_id") <= 200 AND length("value_evidence_ref") > 0 AND length("value_evidence_ref") <= 500)
);
--> statement-breakpoint
CREATE TABLE `earned_delegation_evidence_revisions` (
	`organization_id` text NOT NULL,
	`tedi_id` text NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL,
	`updated_at` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL,
	CONSTRAINT `earned_delegation_evidence_revisions_pk` PRIMARY KEY(`organization_id`, `tedi_id`),
	CONSTRAINT `fk_earned_delegation_evidence_revisions_organization_id_organizations_id_fk` FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_earned_delegation_evidence_revisions_tedi_id_tedis_id_fk` FOREIGN KEY (`tedi_id`) REFERENCES `tedis`(`id`) ON DELETE CASCADE,
	CONSTRAINT "chk_earned_delegation_evidence_revision" CHECK("revision" > 0)
);
--> statement-breakpoint
CREATE TABLE `entrustable_activities` (
	`id` text PRIMARY KEY,
	`organization_id` text,
	`key` text NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`supersedes_id` text,
	`role_template_id` text,
	`name` text NOT NULL,
	`description` text,
	`status` text DEFAULT 'active' NOT NULL,
	`task_family` text NOT NULL,
	`risk_level` text NOT NULL,
	`maximum_level` text NOT NULL,
	`action_patterns` text NOT NULL,
	`tool_ids` text NOT NULL,
	`rubric` text NOT NULL,
	`rubric_hash` text NOT NULL,
	`evidence_policy` text NOT NULL,
	`evidence_policy_hash` text NOT NULL,
	`created_at` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL,
	`updated_at` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL,
	CONSTRAINT `fk_entrustable_activities_organization_id_organizations_id_fk` FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_entrustable_activities_supersedes_id_entrustable_activities_id_fk` FOREIGN KEY (`supersedes_id`) REFERENCES `entrustable_activities`(`id`) ON DELETE RESTRICT,
	CONSTRAINT `fk_entrustable_activities_role_template_id_role_templates_id_fk` FOREIGN KEY (`role_template_id`) REFERENCES `role_templates`(`id`) ON DELETE SET NULL,
	CONSTRAINT "chk_entrustable_activity_version" CHECK("version" > 0),
	CONSTRAINT "chk_entrustable_activity_status" CHECK("status" IN ('active', 'retired')),
	CONSTRAINT "chk_entrustable_activity_risk" CHECK("risk_level" IN ('low', 'medium', 'high', 'critical')),
	CONSTRAINT "chk_entrustable_activity_max_level" CHECK("maximum_level" IN ('observe', 'recommend', 'execute_preapproved', 'execute_reviewed', 'autonomous', 'delegate'))
);
--> statement-breakpoint
CREATE TABLE `promotion_decision_observations` (
	`id` text PRIMARY KEY,
	`organization_id` text NOT NULL,
	`decision_id` text NOT NULL,
	`observation_id` text NOT NULL,
	`created_at` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL,
	CONSTRAINT `fk_promotion_decision_observations_organization_id_organizations_id_fk` FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_promotion_decision_observations_decision_id_promotion_decisions_id_fk` FOREIGN KEY (`decision_id`) REFERENCES `promotion_decisions`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_promotion_decision_observations_observation_id_competency_observations_id_fk` FOREIGN KEY (`observation_id`) REFERENCES `competency_observations`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `promotion_decisions` (
	`id` text PRIMARY KEY,
	`organization_id` text NOT NULL,
	`client_proposal_id` text NOT NULL,
	`input_hash` text NOT NULL,
	`tedi_id` text NOT NULL,
	`role_assignment_id` text,
	`activity_id` text,
	`kind` text NOT NULL,
	`status` text DEFAULT 'proposed' NOT NULL,
	`from_career_stage` text,
	`to_career_stage` text,
	`from_entrustment_level` text,
	`from_entrustment_status` text,
	`to_entrustment_level` text,
	`target_role_template_id` text,
	`target_role_key` text,
	`target_role_name` text,
	`target_scope` text,
	`target_expires_at` text,
	`target_next_review_at` text,
	`expected_role_revision` integer,
	`expected_entrustment_revision` integer,
	`evidence_observation_ids` text NOT NULL,
	`evidence_refs` text NOT NULL,
	`evidence_snapshot` text NOT NULL,
	`proposed_by_type` text NOT NULL,
	`proposed_by_id` text NOT NULL,
	`decided_by_type` text,
	`decided_by_id` text,
	`reason` text,
	`created_at` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL,
	`updated_at` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL,
	`proposal_expires_at` text NOT NULL,
	`decided_at` text,
	`applied_at` text,
	CONSTRAINT `fk_promotion_decisions_organization_id_organizations_id_fk` FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_promotion_decisions_tedi_id_tedis_id_fk` FOREIGN KEY (`tedi_id`) REFERENCES `tedis`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_promotion_decisions_role_assignment_id_tedi_role_assignments_id_fk` FOREIGN KEY (`role_assignment_id`) REFERENCES `tedi_role_assignments`(`id`) ON DELETE RESTRICT,
	CONSTRAINT `fk_promotion_decisions_activity_id_entrustable_activities_id_fk` FOREIGN KEY (`activity_id`) REFERENCES `entrustable_activities`(`id`) ON DELETE RESTRICT,
	CONSTRAINT "chk_promotion_decision_kind" CHECK("kind" IN ('promote', 'demote', 'grant', 'raise', 'restrict', 'revoke', 'recertify', 'reinstate', 'role_change')),
	CONSTRAINT "chk_promotion_decision_status" CHECK("status" IN ('proposed', 'approved', 'rejected', 'applied', 'cancelled')),
	CONSTRAINT "chk_promotion_decision_from_entrustment_status" CHECK(("kind" IN ('promote', 'demote', 'grant', 'role_change') AND "from_entrustment_status" IS NULL) OR ("kind" = 'raise' AND "from_entrustment_status" = 'active') OR ("kind" = 'recertify' AND "from_entrustment_status" = 'active') OR ("kind" = 'reinstate' AND "from_entrustment_status" IN ('restricted', 'expired')) OR ("kind" = 'restrict' AND "from_entrustment_status" = 'active') OR ("kind" = 'revoke' AND "from_entrustment_status" IN ('active', 'restricted', 'expired'))),
	CONSTRAINT "chk_promotion_decision_proposer" CHECK("proposed_by_type" IN ('user', 'tedi', 'service', 'api_key', 'external_agent')),
	CONSTRAINT "chk_promotion_decision_disposer" CHECK("decided_by_type" IS NULL OR "decided_by_type" IN ('user', 'api_key', 'certification_service')),
	CONSTRAINT "chk_promotion_decision_evidence" CHECK(json_array_length("evidence_refs") > 0),
	CONSTRAINT "chk_promotion_decision_promote_shape" CHECK("kind" != 'promote' OR ("role_assignment_id" IS NOT NULL AND "activity_id" IS NULL AND "from_career_stage" IS NOT NULL AND "to_career_stage" IS NOT NULL AND "from_entrustment_level" IS NULL AND "to_entrustment_level" IS NULL AND json_array_length("evidence_observation_ids") > 0 AND (CASE "to_career_stage" WHEN 'shadow' THEN 0 WHEN 'apprentice' THEN 1 WHEN 'operator' THEN 2 WHEN 'specialist' THEN 3 WHEN 'lead' THEN 4 WHEN 'executive' THEN 5 END) = (CASE "from_career_stage" WHEN 'shadow' THEN 0 WHEN 'apprentice' THEN 1 WHEN 'operator' THEN 2 WHEN 'specialist' THEN 3 WHEN 'lead' THEN 4 WHEN 'executive' THEN 5 END) + 1)),
	CONSTRAINT "chk_promotion_decision_demote_shape" CHECK("kind" != 'demote' OR ("role_assignment_id" IS NOT NULL AND "activity_id" IS NULL AND "from_career_stage" IS NOT NULL AND "to_career_stage" IS NOT NULL AND "from_entrustment_level" IS NULL AND "to_entrustment_level" IS NULL AND (CASE "to_career_stage" WHEN 'shadow' THEN 0 WHEN 'apprentice' THEN 1 WHEN 'operator' THEN 2 WHEN 'specialist' THEN 3 WHEN 'lead' THEN 4 WHEN 'executive' THEN 5 END) < (CASE "from_career_stage" WHEN 'shadow' THEN 0 WHEN 'apprentice' THEN 1 WHEN 'operator' THEN 2 WHEN 'specialist' THEN 3 WHEN 'lead' THEN 4 WHEN 'executive' THEN 5 END))),
	CONSTRAINT "chk_promotion_decision_grant_shape" CHECK("kind" != 'grant' OR ("activity_id" IS NOT NULL AND "from_entrustment_level" IS NULL AND "to_entrustment_level" IS NOT NULL AND "target_scope" IS NOT NULL AND "target_expires_at" IS NOT NULL AND "target_next_review_at" IS NOT NULL AND "from_career_stage" IS NULL AND "to_career_stage" IS NULL AND json_array_length("evidence_observation_ids") > 0)),
	CONSTRAINT "chk_promotion_decision_raise_shape" CHECK("kind" != 'raise' OR ("activity_id" IS NOT NULL AND "from_entrustment_level" IS NOT NULL AND "to_entrustment_level" IS NOT NULL AND "target_scope" IS NOT NULL AND "target_expires_at" IS NOT NULL AND "target_next_review_at" IS NOT NULL AND "from_career_stage" IS NULL AND "to_career_stage" IS NULL AND json_array_length("evidence_observation_ids") > 0 AND (CASE "to_entrustment_level" WHEN 'observe' THEN 0 WHEN 'recommend' THEN 1 WHEN 'execute_preapproved' THEN 2 WHEN 'execute_reviewed' THEN 3 WHEN 'autonomous' THEN 4 WHEN 'delegate' THEN 5 END) > (CASE "from_entrustment_level" WHEN 'observe' THEN 0 WHEN 'recommend' THEN 1 WHEN 'execute_preapproved' THEN 2 WHEN 'execute_reviewed' THEN 3 WHEN 'autonomous' THEN 4 WHEN 'delegate' THEN 5 END))),
	CONSTRAINT "chk_promotion_decision_recertify_shape" CHECK("kind" NOT IN ('recertify', 'reinstate') OR ("activity_id" IS NOT NULL AND "from_entrustment_level" IS NOT NULL AND "to_entrustment_level" = "from_entrustment_level" AND "target_scope" IS NOT NULL AND "target_expires_at" IS NOT NULL AND "target_next_review_at" IS NOT NULL AND "from_career_stage" IS NULL AND "to_career_stage" IS NULL AND json_array_length("evidence_observation_ids") > 0)),
	CONSTRAINT "chk_promotion_decision_incident_shape" CHECK("kind" NOT IN ('restrict', 'revoke') OR ("activity_id" IS NOT NULL AND "from_entrustment_level" IS NOT NULL AND "to_entrustment_level" IS NULL AND "target_scope" IS NULL AND "target_expires_at" IS NULL AND "target_next_review_at" IS NULL AND "from_career_stage" IS NULL AND "to_career_stage" IS NULL)),
	CONSTRAINT "chk_promotion_decision_role_change_shape" CHECK("kind" != 'role_change' OR ("role_assignment_id" IS NOT NULL AND "activity_id" IS NULL AND "target_role_key" IS NOT NULL AND "target_role_name" IS NOT NULL AND "from_career_stage" IS NULL AND "to_career_stage" IS NULL AND "from_entrustment_level" IS NULL AND "to_entrustment_level" IS NULL)),
	CONSTRAINT "chk_promotion_decision_target_role_fields" CHECK("kind" = 'role_change' OR ("target_role_template_id" IS NULL AND "target_role_key" IS NULL AND "target_role_name" IS NULL)),
	CONSTRAINT "chk_promotion_decision_target_scope_fields" CHECK("kind" IN ('grant', 'raise', 'recertify', 'reinstate') OR ("target_scope" IS NULL AND "target_expires_at" IS NULL AND "target_next_review_at" IS NULL)),
	CONSTRAINT "chk_promotion_decision_settlement" CHECK("status" IN ('proposed', 'cancelled') OR ("decided_by_type" IS NOT NULL AND "decided_by_id" IS NOT NULL AND "decided_at" IS NOT NULL)),
	CONSTRAINT "chk_promotion_decision_application" CHECK("status" != 'applied' OR "applied_at" IS NOT NULL),
	CONSTRAINT "chk_promotion_decision_independence" CHECK("decided_by_id" IS NULL OR "decided_by_type" != "proposed_by_type" OR "decided_by_id" != "proposed_by_id")
);
--> statement-breakpoint
CREATE TABLE `tedi_entrustment_grants` (
	`id` text PRIMARY KEY,
	`organization_id` text NOT NULL,
	`tedi_id` text NOT NULL,
	`role_assignment_id` text,
	`activity_id` text NOT NULL,
	`level` text DEFAULT 'observe' NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`scope` text NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL,
	`last_certified_at` text,
	`expires_at` text,
	`next_review_at` text NOT NULL,
	`restricted_at` text,
	`reason` text,
	`last_decision_id` text NOT NULL,
	`activity_version` integer NOT NULL,
	`rubric_hash` text NOT NULL,
	`evidence_policy_hash` text NOT NULL,
	`evidence_snapshot_hash` text NOT NULL,
	`granted_by_type` text NOT NULL,
	`granted_by_id` text NOT NULL,
	`created_at` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL,
	`updated_at` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL,
	CONSTRAINT `fk_tedi_entrustment_grants_organization_id_organizations_id_fk` FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_tedi_entrustment_grants_tedi_id_tedis_id_fk` FOREIGN KEY (`tedi_id`) REFERENCES `tedis`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_tedi_entrustment_grants_role_assignment_id_tedi_role_assignments_id_fk` FOREIGN KEY (`role_assignment_id`) REFERENCES `tedi_role_assignments`(`id`) ON DELETE RESTRICT,
	CONSTRAINT `fk_tedi_entrustment_grants_activity_id_entrustable_activities_id_fk` FOREIGN KEY (`activity_id`) REFERENCES `entrustable_activities`(`id`) ON DELETE RESTRICT,
	CONSTRAINT `fk_tedi_entrustment_grants_last_decision_id_promotion_decisions_id_fk` FOREIGN KEY (`last_decision_id`) REFERENCES `promotion_decisions`(`id`) ON DELETE RESTRICT,
	CONSTRAINT "chk_tedi_entrustment_grant_level" CHECK("level" IN ('observe', 'recommend', 'execute_preapproved', 'execute_reviewed', 'autonomous', 'delegate')),
	CONSTRAINT "chk_tedi_entrustment_grant_status" CHECK("status" IN ('active', 'restricted', 'expired', 'revoked')),
	CONSTRAINT "chk_tedi_entrustment_grant_revision" CHECK("revision" > 0 AND "activity_version" > 0),
	CONSTRAINT "chk_tedi_entrustment_grant_authority" CHECK("granted_by_type" IN ('user', 'api_key', 'certification_service'))
);
--> statement-breakpoint
CREATE TABLE `tedi_role_assignments` (
	`id` text PRIMARY KEY,
	`organization_id` text NOT NULL,
	`tedi_id` text NOT NULL,
	`role_template_id` text,
	`role_key` text NOT NULL,
	`role_name` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`career_stage` text DEFAULT 'shadow' NOT NULL,
	`assigned_at` text NOT NULL,
	`stage_changed_at` text NOT NULL,
	`ended_at` text,
	`revision` integer DEFAULT 1 NOT NULL,
	`last_decision_id` text,
	`evidence_snapshot_hash` text,
	`metadata` text,
	`created_at` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL,
	`updated_at` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL,
	CONSTRAINT `fk_tedi_role_assignments_organization_id_organizations_id_fk` FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_tedi_role_assignments_tedi_id_tedis_id_fk` FOREIGN KEY (`tedi_id`) REFERENCES `tedis`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_tedi_role_assignments_role_template_id_role_templates_id_fk` FOREIGN KEY (`role_template_id`) REFERENCES `role_templates`(`id`) ON DELETE SET NULL,
	CONSTRAINT "chk_tedi_role_assignment_status" CHECK("status" IN ('active', 'ended')),
	CONSTRAINT "chk_tedi_role_assignment_stage" CHECK("career_stage" IN ('shadow', 'apprentice', 'operator', 'specialist', 'lead', 'executive')),
	CONSTRAINT "chk_tedi_role_assignment_revision" CHECK("revision" > 0),
	CONSTRAINT "chk_tedi_role_assignment_end" CHECK(("status" = 'active' AND "ended_at" IS NULL) OR ("status" = 'ended' AND "ended_at" IS NOT NULL)),
	CONSTRAINT "chk_tedi_role_assignment_earned_stage" CHECK("career_stage" = 'shadow' OR ("last_decision_id" IS NOT NULL AND "evidence_snapshot_hash" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE `xai_flywheel_snapshots` (
	`id` text PRIMARY KEY,
	`tedi_id` text NOT NULL,
	`org_id` text NOT NULL,
	`bucket_start` text NOT NULL,
	`bucket_end` text NOT NULL,
	`bucket_hours` integer NOT NULL,
	`score` real NOT NULL,
	`direction` text NOT NULL,
	`snapshot` text NOT NULL,
	`created_at` text DEFAULT (CURRENT_TIMESTAMP),
	`updated_at` text DEFAULT (CURRENT_TIMESTAMP),
	CONSTRAINT `fk_xai_flywheel_snapshots_tedi_id_tedis_id_fk` FOREIGN KEY (`tedi_id`) REFERENCES `tedis`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_xai_flywheel_snapshots_org_id_organizations_id_fk` FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `harness_eval_results` (
	`id` text PRIMARY KEY,
	`harness_version_id` text NOT NULL,
	`tedi_id` text NOT NULL,
	`org_id` text,
	`score` real NOT NULL,
	`gates` text DEFAULT '{}' NOT NULL,
	`passed` integer DEFAULT false NOT NULL,
	`lane` text,
	`task_set_id` text,
	`metadata` text,
	`created_at` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL,
	CONSTRAINT `fk_harness_eval_results_tedi_id_tedis_id_fk` FOREIGN KEY (`tedi_id`) REFERENCES `tedis`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_harness_eval_results_org_id_organizations_id_fk` FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `harness_eval_runs` (
	`id` text PRIMARY KEY,
	`harness_version_id` text NOT NULL,
	`tedi_id` text NOT NULL,
	`org_id` text,
	`lane` text NOT NULL,
	`task_set_id` text NOT NULL,
	`total` integer DEFAULT 0 NOT NULL,
	`passed` integer DEFAULT 0 NOT NULL,
	`failed` integer DEFAULT 0 NOT NULL,
	`mean_score` real DEFAULT 0 NOT NULL,
	`eligible` integer DEFAULT false NOT NULL,
	`metadata` text,
	`created_at` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL,
	CONSTRAINT `fk_harness_eval_runs_tedi_id_tedis_id_fk` FOREIGN KEY (`tedi_id`) REFERENCES `tedis`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_harness_eval_runs_org_id_organizations_id_fk` FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `harness_subject_eval_results` (
	`id` text PRIMARY KEY,
	`subject_kind` text NOT NULL,
	`subject_id` text NOT NULL,
	`tedi_id` text,
	`org_id` text,
	`harness_version_id` text NOT NULL,
	`score` real NOT NULL,
	`gates` text DEFAULT '{}' NOT NULL,
	`passed` integer DEFAULT false NOT NULL,
	`lane` text,
	`task_set_id` text,
	`metadata` text,
	`created_at` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL,
	CONSTRAINT `fk_harness_subject_eval_results_org_id_organizations_id_fk` FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `harness_subject_eval_runs` (
	`id` text PRIMARY KEY,
	`subject_kind` text NOT NULL,
	`subject_id` text NOT NULL,
	`tedi_id` text,
	`org_id` text,
	`harness_version_id` text NOT NULL,
	`lane` text NOT NULL,
	`task_set_id` text NOT NULL,
	`total` integer DEFAULT 0 NOT NULL,
	`passed` integer DEFAULT 0 NOT NULL,
	`failed` integer DEFAULT 0 NOT NULL,
	`mean_score` real DEFAULT 0 NOT NULL,
	`eligible` integer DEFAULT false NOT NULL,
	`metadata` text,
	`created_at` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL,
	CONSTRAINT `fk_harness_subject_eval_runs_org_id_organizations_id_fk` FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `harness_subject_trace_bundles` (
	`id` text PRIMARY KEY,
	`subject_kind` text NOT NULL,
	`subject_id` text NOT NULL,
	`tedi_id` text,
	`org_id` text,
	`conversation_id` text,
	`run_id` text NOT NULL,
	`harness_version_id` text NOT NULL,
	`event_ids` text DEFAULT '[]' NOT NULL,
	`rationale_record_ids` text DEFAULT '[]' NOT NULL,
	`artifact_ids` text DEFAULT '[]' NOT NULL,
	`eval_result_id` text,
	`bundle_uri` text,
	`summary` text,
	`outcome` text,
	`metadata` text,
	`created_at` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL,
	CONSTRAINT `fk_harness_subject_trace_bundles_tedi_id_tedis_id_fk` FOREIGN KEY (`tedi_id`) REFERENCES `tedis`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_harness_subject_trace_bundles_org_id_organizations_id_fk` FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `harness_subject_versions` (
	`id` text PRIMARY KEY,
	`subject_kind` text NOT NULL,
	`subject_id` text NOT NULL,
	`tedi_id` text,
	`org_id` text,
	`version` text NOT NULL,
	`runtime_kind` text,
	`components` text DEFAULT '{}' NOT NULL,
	`parent_version_id` text,
	`reason` text,
	`artifact_commit_sha` text,
	`trace_safety_policy_id` text,
	`promotion_status` text DEFAULT 'proposed' NOT NULL,
	`metadata` text,
	`created_at` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL,
	CONSTRAINT `fk_harness_subject_versions_tedi_id_tedis_id_fk` FOREIGN KEY (`tedi_id`) REFERENCES `tedis`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_harness_subject_versions_org_id_organizations_id_fk` FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `harness_versions` (
	`id` text PRIMARY KEY,
	`tedi_id` text NOT NULL,
	`org_id` text,
	`version` text NOT NULL,
	`runtime_kind` text,
	`components` text DEFAULT '{}' NOT NULL,
	`parent_version_id` text,
	`reason` text,
	`artifact_commit_sha` text,
	`trace_safety_policy_id` text,
	`promotion_status` text DEFAULT 'proposed' NOT NULL,
	`metadata` text,
	`created_at` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL,
	CONSTRAINT `fk_harness_versions_tedi_id_tedis_id_fk` FOREIGN KEY (`tedi_id`) REFERENCES `tedis`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_harness_versions_org_id_organizations_id_fk` FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `trace_bundles` (
	`id` text PRIMARY KEY,
	`tedi_id` text NOT NULL,
	`org_id` text,
	`conversation_id` text,
	`run_id` text NOT NULL,
	`harness_version_id` text NOT NULL,
	`event_ids` text DEFAULT '[]' NOT NULL,
	`rationale_record_ids` text DEFAULT '[]' NOT NULL,
	`artifact_ids` text DEFAULT '[]' NOT NULL,
	`eval_result_id` text,
	`bundle_uri` text,
	`summary` text,
	`outcome` text,
	`metadata` text,
	`created_at` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL,
	CONSTRAINT `fk_trace_bundles_tedi_id_tedis_id_fk` FOREIGN KEY (`tedi_id`) REFERENCES `tedis`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_trace_bundles_org_id_organizations_id_fk` FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `mcp_tool_approval_grants` (
	`id` text PRIMARY KEY DEFAULT (lower(
    hex(randomblob(4)) || '-' ||
    hex(randomblob(2)) || '-' ||
    '4' || substr(hex(randomblob(2)), 2) || '-' ||
    substr('89ab', 1 + (abs(random()) % 4), 1) || substr(hex(randomblob(2)), 2) || '-' ||
    hex(randomblob(6))
  )),
	`organization_id` text NOT NULL,
	`subject_id` text NOT NULL,
	`tool_id` text NOT NULL,
	`grant_kind` text NOT NULL,
	`consumed_at` text,
	`expires_at` text,
	`reason` text,
	`created_at` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL,
	CONSTRAINT `fk_mcp_tool_approval_grants_organization_id_organizations_id_fk` FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `mcp_payment_accounts` (
	`id` text PRIMARY KEY DEFAULT (lower(
    hex(randomblob(4)) || '-' ||
    hex(randomblob(2)) || '-' ||
    '4' || substr(hex(randomblob(2)), 2) || '-' ||
    substr('89ab', 1 + (abs(random()) % 4), 1) || substr(hex(randomblob(2)), 2) || '-' ||
    hex(randomblob(6))
  )),
	`organization_id` text NOT NULL,
	`tedi_id` text,
	`app_slug` text,
	`label` text NOT NULL,
	`network` text DEFAULT 'solana-devnet' NOT NULL,
	`asset` text DEFAULT 'USDC' NOT NULL,
	`public_address` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`custody_mode` text DEFAULT 'mock' NOT NULL,
	`signer_provider` text DEFAULT 'mock' NOT NULL,
	`metadata` text,
	`created_by` text,
	`updated_by` text,
	`created_at` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL,
	`updated_at` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL,
	CONSTRAINT `fk_mcp_payment_accounts_organization_id_organizations_id_fk` FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_mcp_payment_accounts_tedi_id_tedis_id_fk` FOREIGN KEY (`tedi_id`) REFERENCES `tedis`(`id`) ON DELETE CASCADE,
	CONSTRAINT `uniq_mcp_payment_account_target` UNIQUE(`organization_id`,`tedi_id`,`app_slug`,`network`,`asset`,`public_address`)
);
--> statement-breakpoint
CREATE TABLE `mcp_payment_events` (
	`id` text PRIMARY KEY,
	`requirement_id` text NOT NULL,
	`event_type` text NOT NULL,
	`status` text NOT NULL,
	`protocol` text DEFAULT 'x402' NOT NULL,
	`mode` text DEFAULT 'mock' NOT NULL,
	`network` text NOT NULL,
	`asset` text,
	`currency` text,
	`amount` text NOT NULL,
	`recipient` text NOT NULL,
	`resource` text,
	`app_id` text,
	`app_slug` text NOT NULL,
	`organization_id` text,
	`tool_row_id` text,
	`tool_id` text NOT NULL,
	`tedi_id` text,
	`user_id` text,
	`client_id` text,
	`auth_type` text,
	`trace_id` text,
	`tool_args_hash` text,
	`settled` integer DEFAULT false NOT NULL,
	`requirements` text,
	`payment_proof` text,
	`payment_response` text,
	`budget_policy` text,
	`budget_decision` text,
	`decision_rationale` text,
	`audit_event_id` text,
	`rationale_record_id` text,
	`created_at` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL,
	CONSTRAINT `fk_mcp_payment_events_app_id_apps_id_fk` FOREIGN KEY (`app_id`) REFERENCES `apps`(`id`) ON DELETE SET NULL,
	CONSTRAINT `fk_mcp_payment_events_organization_id_organizations_id_fk` FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON DELETE SET NULL,
	CONSTRAINT `fk_mcp_payment_events_tedi_id_tedis_id_fk` FOREIGN KEY (`tedi_id`) REFERENCES `tedis`(`id`) ON DELETE SET NULL
);
--> statement-breakpoint
CREATE TABLE `mcp_payment_policies` (
	`id` text PRIMARY KEY DEFAULT (lower(
    hex(randomblob(4)) || '-' ||
    hex(randomblob(2)) || '-' ||
    '4' || substr(hex(randomblob(2)), 2) || '-' ||
    substr('89ab', 1 + (abs(random()) % 4), 1) || substr(hex(randomblob(2)), 2) || '-' ||
    hex(randomblob(6))
  )),
	`organization_id` text NOT NULL,
	`tedi_id` text,
	`app_slug` text,
	`tool_id` text,
	`currency` text DEFAULT 'USDC' NOT NULL,
	`network` text DEFAULT 'solana-devnet' NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`max_amount` text NOT NULL,
	`window_seconds` integer DEFAULT 86400 NOT NULL,
	`mode` text DEFAULT 'enforce' NOT NULL,
	`created_by` text,
	`updated_by` text,
	`created_at` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL,
	`updated_at` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL,
	CONSTRAINT `fk_mcp_payment_policies_organization_id_organizations_id_fk` FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_mcp_payment_policies_tedi_id_tedis_id_fk` FOREIGN KEY (`tedi_id`) REFERENCES `tedis`(`id`) ON DELETE CASCADE,
	CONSTRAINT `uniq_mcp_payment_policy_target` UNIQUE(`organization_id`,`tedi_id`,`app_slug`,`tool_id`,`currency`,`network`)
);
--> statement-breakpoint
CREATE TABLE `mcp_payment_reservations` (
	`id` text PRIMARY KEY DEFAULT (lower(
    hex(randomblob(4)) || '-' ||
    hex(randomblob(2)) || '-' ||
    '4' || substr(hex(randomblob(2)), 2) || '-' ||
    substr('89ab', 1 + (abs(random()) % 4), 1) || substr(hex(randomblob(2)), 2) || '-' ||
    hex(randomblob(6))
  )),
	`requirement_id` text NOT NULL CONSTRAINT `uniq_mcp_payment_reservation_requirement` UNIQUE,
	`organization_id` text NOT NULL,
	`tedi_id` text,
	`app_slug` text NOT NULL,
	`tool_id` text NOT NULL,
	`account_id` text,
	`policy_id` text,
	`status` text DEFAULT 'reserved' NOT NULL,
	`protocol` text DEFAULT 'x402' NOT NULL,
	`mode` text DEFAULT 'mock' NOT NULL,
	`network` text NOT NULL,
	`asset` text,
	`currency` text,
	`amount` text NOT NULL,
	`recipient` text NOT NULL,
	`resource` text,
	`expires_at` text NOT NULL,
	`settled_event_id` text,
	`metadata` text,
	`created_at` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL,
	`updated_at` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL,
	CONSTRAINT `fk_mcp_payment_reservations_organization_id_organizations_id_fk` FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_mcp_payment_reservations_tedi_id_tedis_id_fk` FOREIGN KEY (`tedi_id`) REFERENCES `tedis`(`id`) ON DELETE SET NULL,
	CONSTRAINT `fk_mcp_payment_reservations_account_id_mcp_payment_accounts_id_fk` FOREIGN KEY (`account_id`) REFERENCES `mcp_payment_accounts`(`id`) ON DELETE SET NULL,
	CONSTRAINT `fk_mcp_payment_reservations_policy_id_mcp_payment_policies_id_fk` FOREIGN KEY (`policy_id`) REFERENCES `mcp_payment_policies`(`id`) ON DELETE SET NULL
);
--> statement-breakpoint
CREATE TABLE `mcp_tasks` (
	`id` text PRIMARY KEY,
	`task_id` text NOT NULL,
	`org_id` text NOT NULL,
	`app_id` text NOT NULL,
	`tool_id` text,
	`tool_name` text NOT NULL,
	`request_id` text,
	`method` text DEFAULT 'tools/call' NOT NULL,
	`status` text DEFAULT 'working' NOT NULL,
	`ttl_ms` integer,
	`poll_interval_ms` integer,
	`input_requests` text,
	`input_responses` text,
	`result` text,
	`error` text,
	`workflow_id` text,
	`cancel_requested_at` text,
	`created_at` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL,
	`updated_at` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL,
	`expires_at` text
);
--> statement-breakpoint
CREATE TABLE `mcp_telemetry_events` (
	`id` text PRIMARY KEY,
	`tedi_id` text,
	`organization_id` text,
	`event_type` text NOT NULL,
	`server_id` text,
	`server_url` text,
	`tool_name` text,
	`native_name` text,
	`success` integer,
	`latency_ms` real,
	`error` text,
	`metadata` text,
	`event_timestamp` text,
	`created_at` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL,
	CONSTRAINT `fk_mcp_telemetry_events_tedi_id_tedis_id_fk` FOREIGN KEY (`tedi_id`) REFERENCES `tedis`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_mcp_telemetry_events_organization_id_organizations_id_fk` FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `memory_domains` (
	`id` text PRIMARY KEY,
	`organization_id` text NOT NULL,
	`name` text NOT NULL,
	`parent_id` text,
	`description` text,
	`created_at` text DEFAULT (CURRENT_TIMESTAMP),
	CONSTRAINT `fk_memory_domains_organization_id_organizations_id_fk` FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON DELETE CASCADE,
	CONSTRAINT `uniq_domain_org_name` UNIQUE(`organization_id`,`name`)
);
--> statement-breakpoint
CREATE TABLE `memory_edges` (
	`id` text PRIMARY KEY,
	`source_fact_id` text NOT NULL,
	`target_fact_id` text NOT NULL,
	`relation_type` text NOT NULL,
	`strength` real DEFAULT 0.5 NOT NULL,
	`context` text,
	`created_at` text DEFAULT (CURRENT_TIMESTAMP),
	CONSTRAINT `fk_memory_edges_source_fact_id_memory_facts_id_fk` FOREIGN KEY (`source_fact_id`) REFERENCES `memory_facts`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_memory_edges_target_fact_id_memory_facts_id_fk` FOREIGN KEY (`target_fact_id`) REFERENCES `memory_facts`(`id`) ON DELETE CASCADE,
	CONSTRAINT `uniq_edge` UNIQUE(`source_fact_id`,`target_fact_id`,`relation_type`)
);
--> statement-breakpoint
CREATE TABLE `memory_facts` (
	`id` text PRIMARY KEY,
	`organization_id` text NOT NULL,
	`tedi_id` text,
	`domain_id` text,
	`content` text NOT NULL,
	`summary` text,
	`fact_type` text NOT NULL,
	`confidence` real DEFAULT 0.8 NOT NULL,
	`valid_from` text DEFAULT (CURRENT_TIMESTAMP),
	`valid_to` text,
	`status` text DEFAULT 'active',
	`source` text,
	`source_session_id` text,
	`source_url` text,
	`source_hash` text,
	`embedding_id` text,
	`topic_key` text,
	`memory_scope` text DEFAULT 'tedi',
	`use_policy` text DEFAULT 'can_use_as_evidence',
	`review_status` text DEFAULT 'pending',
	`metadata` text,
	`priority` text DEFAULT 'active',
	`visibility` text DEFAULT 'private',
	`promoted_from` text,
	`promoted_at` text,
	`last_verified_at` text,
	`last_accessed_at` text,
	`access_count` integer DEFAULT 0 NOT NULL,
	`usage_count` integer DEFAULT 0 NOT NULL,
	`archived_at` text,
	`created_at` text DEFAULT (CURRENT_TIMESTAMP),
	`updated_at` text DEFAULT (CURRENT_TIMESTAMP),
	CONSTRAINT `fk_memory_facts_organization_id_organizations_id_fk` FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_memory_facts_tedi_id_tedis_id_fk` FOREIGN KEY (`tedi_id`) REFERENCES `tedis`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_memory_facts_domain_id_memory_domains_id_fk` FOREIGN KEY (`domain_id`) REFERENCES `memory_domains`(`id`) ON DELETE SET NULL
);
--> statement-breakpoint
CREATE TABLE `tedi_curiosity_queue` (
	`id` text PRIMARY KEY,
	`tedi_id` text NOT NULL,
	`organization_id` text NOT NULL,
	`topic` text NOT NULL,
	`domain` text NOT NULL,
	`reason` text NOT NULL,
	`priority` real DEFAULT 0.5 NOT NULL,
	`source` text NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`facts_learned` integer DEFAULT 0 NOT NULL,
	`gaps_found` integer DEFAULT 0 NOT NULL,
	`completed_at` text,
	`created_at` text DEFAULT (CURRENT_TIMESTAMP),
	`updated_at` text DEFAULT (CURRENT_TIMESTAMP),
	CONSTRAINT `fk_tedi_curiosity_queue_tedi_id_tedis_id_fk` FOREIGN KEY (`tedi_id`) REFERENCES `tedis`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_tedi_curiosity_queue_organization_id_organizations_id_fk` FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `tedi_expertise` (
	`id` text PRIMARY KEY,
	`tedi_id` text NOT NULL,
	`domain_id` text NOT NULL,
	`fact_count` integer DEFAULT 0 NOT NULL,
	`avg_confidence` real DEFAULT 0 NOT NULL,
	`expertise_level` text DEFAULT 'novice' NOT NULL,
	`last_activity_at` text,
	`created_at` text DEFAULT (CURRENT_TIMESTAMP),
	`updated_at` text DEFAULT (CURRENT_TIMESTAMP),
	CONSTRAINT `fk_tedi_expertise_tedi_id_tedis_id_fk` FOREIGN KEY (`tedi_id`) REFERENCES `tedis`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_tedi_expertise_domain_id_memory_domains_id_fk` FOREIGN KEY (`domain_id`) REFERENCES `memory_domains`(`id`),
	CONSTRAINT `uniq_tedi_domain` UNIQUE(`tedi_id`,`domain_id`)
);
--> statement-breakpoint
CREATE TABLE `tedi_optimization_signals` (
	`id` text PRIMARY KEY,
	`tedi_id` text NOT NULL,
	`organization_id` text NOT NULL,
	`type` text NOT NULL,
	`source` text NOT NULL,
	`domain` text NOT NULL,
	`evidence` text NOT NULL,
	`suggested_action` text NOT NULL,
	`estimated_impact` real DEFAULT 0.5 NOT NULL,
	`estimated_effort` real DEFAULT 0.5 NOT NULL,
	`roi` real DEFAULT 1 NOT NULL,
	`status` text DEFAULT 'detected' NOT NULL,
	`resolved_at` text,
	`created_at` text DEFAULT (CURRENT_TIMESTAMP),
	`updated_at` text DEFAULT (CURRENT_TIMESTAMP),
	CONSTRAINT `fk_tedi_optimization_signals_tedi_id_tedis_id_fk` FOREIGN KEY (`tedi_id`) REFERENCES `tedis`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_tedi_optimization_signals_organization_id_organizations_id_fk` FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `tedi_rationale_records` (
	`id` text PRIMARY KEY,
	`tedi_id` text NOT NULL,
	`org_id` text NOT NULL,
	`action` text NOT NULL,
	`rationale` text NOT NULL,
	`category` text DEFAULT 'custom' NOT NULL,
	`confidence` real DEFAULT 0.5 NOT NULL,
	`evidence` text DEFAULT '{}' NOT NULL,
	`outcome` text,
	`outcome_status` text DEFAULT 'pending' NOT NULL,
	`approval_request_id` text,
	`objective_id` text,
	`run_id` text,
	`work_item_id` text,
	`tool_call_refs` text,
	`proof_ref` text,
	`created_at` text NOT NULL,
	`completed_at` text,
	`blame_chain` text,
	CONSTRAINT `fk_tedi_rationale_records_tedi_id_tedis_id_fk` FOREIGN KEY (`tedi_id`) REFERENCES `tedis`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_tedi_rationale_records_org_id_organizations_id_fk` FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `runtime_submission_attempts` (
	`id` text PRIMARY KEY,
	`submission_id` text NOT NULL,
	`organization_id` text NOT NULL,
	`attempt_no` integer NOT NULL,
	`status` text DEFAULT 'started' NOT NULL,
	`runtime_backend` text,
	`runtime_external_id` text,
	`error` text,
	`metadata` text,
	`started_at` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL,
	`heartbeat_at` text,
	`completed_at` text,
	CONSTRAINT `fk_runtime_submission_attempts_submission_id_runtime_submissions_id_fk` FOREIGN KEY (`submission_id`) REFERENCES `runtime_submissions`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_runtime_submission_attempts_organization_id_organizations_id_fk` FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `runtime_submissions` (
	`id` text PRIMARY KEY,
	`organization_id` text NOT NULL,
	`subject_kind` text NOT NULL,
	`subject_id` text NOT NULL,
	`tedi_id` text,
	`conversation_id` text,
	`run_id` text,
	`idempotency_key` text,
	`source_kind` text NOT NULL,
	`source_provider` text,
	`source_delivery_id` text,
	`status` text DEFAULT 'admitted' NOT NULL,
	`current_attempt_id` text,
	`attempt_count` integer DEFAULT 0 NOT NULL,
	`runtime_backend` text,
	`metadata` text,
	`created_at` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL,
	`updated_at` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL,
	`settled_at` text,
	`timeout_at` text,
	`phase` text,
	`input_applied_at` text,
	`abort_requested_at` text,
	`max_retry` integer DEFAULT 10 NOT NULL,
	CONSTRAINT `fk_runtime_submissions_organization_id_organizations_id_fk` FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_runtime_submissions_tedi_id_tedis_id_fk` FOREIGN KEY (`tedi_id`) REFERENCES `tedis`(`id`) ON DELETE SET NULL
);
--> statement-breakpoint
CREATE TABLE `tedi_growth_snapshots` (
	`id` text PRIMARY KEY,
	`tedi_id` text NOT NULL,
	`org_id` text NOT NULL,
	`snapshot_date` text NOT NULL,
	`metrics` text NOT NULL,
	`created_at` text DEFAULT (CURRENT_TIMESTAMP),
	CONSTRAINT `fk_tedi_growth_snapshots_tedi_id_tedis_id_fk` FOREIGN KEY (`tedi_id`) REFERENCES `tedis`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_tedi_growth_snapshots_org_id_organizations_id_fk` FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `tedi_objectives` (
	`id` text PRIMARY KEY,
	`tedi_id` text NOT NULL,
	`org_id` text NOT NULL,
	`purpose_charter_id` text,
	`title` text NOT NULL,
	`description` text,
	`approach` text,
	`success_criteria` text,
	`constraints` text,
	`type` text DEFAULT 'standing' NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`risk_level` text DEFAULT 'medium' NOT NULL,
	`priority` integer DEFAULT 0 NOT NULL,
	`linked_domains` text DEFAULT '[]',
	`gate_config` text DEFAULT '{}',
	`budget_config` text DEFAULT '{}',
	`progress` text DEFAULT '{}',
	`created_at` text NOT NULL,
	`updated_at` text,
	`completed_at` text,
	CONSTRAINT `fk_tedi_objectives_tedi_id_tedis_id_fk` FOREIGN KEY (`tedi_id`) REFERENCES `tedis`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_tedi_objectives_org_id_organizations_id_fk` FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `tedi_tasks` (
	`id` text PRIMARY KEY,
	`objective_id` text,
	`tedi_id` text NOT NULL,
	`org_id` text NOT NULL,
	`title` text NOT NULL,
	`kind` text DEFAULT 'general' NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`blocker` text,
	`evidence` text DEFAULT '[]',
	`tooling_used` text DEFAULT '[]',
	`estimated_cost` text DEFAULT '{}',
	`result` text,
	`actual_cost` text DEFAULT '{}',
	`budget_used` text DEFAULT '{}',
	`fail_count` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text,
	`completed_at` text,
	CONSTRAINT `fk_tedi_tasks_objective_id_tedi_objectives_id_fk` FOREIGN KEY (`objective_id`) REFERENCES `tedi_objectives`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_tedi_tasks_tedi_id_tedis_id_fk` FOREIGN KEY (`tedi_id`) REFERENCES `tedis`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_tedi_tasks_org_id_organizations_id_fk` FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `tenant_bundles` (
	`id` text PRIMARY KEY,
	`slug` text NOT NULL,
	`version` integer NOT NULL,
	`r2_prefix` text NOT NULL,
	`main_module` text NOT NULL,
	`etag` text NOT NULL,
	`modules_json` text NOT NULL,
	`is_active` integer DEFAULT false NOT NULL,
	`created_at` text DEFAULT (current_timestamp) NOT NULL,
	`deployed_at` text,
	`deployed_by` text,
	`summary` text,
	CONSTRAINT `tenant_bundles_slug_version_unique` UNIQUE(`slug`,`version`)
);
--> statement-breakpoint
CREATE TABLE `widget_test_runs` (
	`id` text PRIMARY KEY,
	`app_id` text,
	`app_slug` text NOT NULL,
	`organization_id` text,
	`tool_name` text NOT NULL,
	`tool_args` text,
	`mode` text NOT NULL,
	`passed` integer NOT NULL,
	`step_count` integer,
	`steps_passed_count` integer,
	`step_results` text,
	`screenshots` text,
	`tool_result` text,
	`dom_summary` text,
	`widget_analysis` text,
	`visual_diff` text,
	`preview_url` text,
	`duration_ms` real,
	`error` text,
	`created_at` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL,
	CONSTRAINT `fk_widget_test_runs_app_id_apps_id_fk` FOREIGN KEY (`app_id`) REFERENCES `apps`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_widget_test_runs_organization_id_organizations_id_fk` FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `workflow_run_ledger` (
	`id` text PRIMARY KEY,
	`workflow_type` text NOT NULL,
	`workflow_id` text NOT NULL,
	`trigger` text NOT NULL,
	`target` text,
	`status` text NOT NULL,
	`started_at` text NOT NULL,
	`completed_at` text,
	`total_count` integer DEFAULT 0,
	`success_count` integer DEFAULT 0,
	`error_count` integer DEFAULT 0,
	`output` text,
	`error` text
);
--> statement-breakpoint
CREATE INDEX `idx_app_adapters_app` ON `app_adapters` (`app_id`);--> statement-breakpoint
CREATE INDEX `idx_app_adapters_type` ON `app_adapters` (`adapter_type`);--> statement-breakpoint
CREATE INDEX `idx_app_adapters_enabled` ON `app_adapters` (`app_id`,`enabled`);--> statement-breakpoint
CREATE INDEX `idx_mcp_tool_calls_org` ON `mcp_tool_calls` (`organization_id`);--> statement-breakpoint
CREATE INDEX `idx_mcp_tool_calls_app` ON `mcp_tool_calls` (`app_id`);--> statement-breakpoint
CREATE INDEX `idx_mcp_tool_calls_session` ON `mcp_tool_calls` (`session_id`);--> statement-breakpoint
CREATE INDEX `idx_mcp_tool_calls_tool` ON `mcp_tool_calls` (`tool_name`);--> statement-breakpoint
CREATE INDEX `idx_mcp_tool_calls_created` ON `mcp_tool_calls` (`created_at`);--> statement-breakpoint
CREATE INDEX `idx_mcp_tool_calls_success` ON `mcp_tool_calls` (`success`);--> statement-breakpoint
CREATE INDEX `idx_session_metrics_org` ON `session_metrics` (`organization_id`);--> statement-breakpoint
CREATE INDEX `idx_session_metrics_app` ON `session_metrics` (`app_id`);--> statement-breakpoint
CREATE INDEX `idx_session_metrics_session` ON `session_metrics` (`session_id`);--> statement-breakpoint
CREATE INDEX `idx_session_metrics_started` ON `session_metrics` (`session_started_at`);--> statement-breakpoint
CREATE INDEX `idx_session_metrics_created` ON `session_metrics` (`created_at`);--> statement-breakpoint
CREATE INDEX `idx_widget_events_org` ON `widget_events` (`organization_id`);--> statement-breakpoint
CREATE INDEX `idx_widget_events_app` ON `widget_events` (`app_id`);--> statement-breakpoint
CREATE INDEX `idx_widget_events_session` ON `widget_events` (`session_id`);--> statement-breakpoint
CREATE INDEX `idx_widget_events_type` ON `widget_events` (`event_type`);--> statement-breakpoint
CREATE INDEX `idx_widget_events_widget` ON `widget_events` (`widget_key`);--> statement-breakpoint
CREATE INDEX `idx_widget_events_created` ON `widget_events` (`created_at`);--> statement-breakpoint
CREATE INDEX `idx_widget_events_item` ON `widget_events` (`item_id`);--> statement-breakpoint
CREATE INDEX `idx_api_key_org` ON `api_keys` (`organization_id`);--> statement-breakpoint
CREATE INDEX `idx_api_key_status` ON `api_keys` (`status`);--> statement-breakpoint
CREATE INDEX `idx_api_key_env` ON `api_keys` (`environment`);--> statement-breakpoint
CREATE INDEX `idx_api_key_hash` ON `api_keys` (`key_hash`);--> statement-breakpoint
CREATE INDEX `idx_adapter_bindings_adapter` ON `app_adapter_secret_bindings` (`adapter_id`);--> statement-breakpoint
CREATE INDEX `idx_adapter_bindings_app` ON `app_adapter_secret_bindings` (`app_id`);--> statement-breakpoint
CREATE INDEX `idx_adapter_bindings_secret` ON `app_adapter_secret_bindings` (`secret_id`,`secret_scope`);--> statement-breakpoint
CREATE INDEX `idx_app_config_versions_app` ON `app_config_versions` (`app_id`);--> statement-breakpoint
CREATE INDEX `idx_app_config_versions_status` ON `app_config_versions` (`status`);--> statement-breakpoint
CREATE INDEX `app_secrets_app_idx` ON `app_secrets` (`app_id`);--> statement-breakpoint
CREATE INDEX `idx_app_snapshots_app` ON `app_snapshots` (`app_id`);--> statement-breakpoint
CREATE INDEX `idx_app_org` ON `apps` (`organization_id`);--> statement-breakpoint
CREATE INDEX `idx_app_slug` ON `apps` (`slug`);--> statement-breakpoint
CREATE INDEX `idx_app_domain` ON `apps` (`custom_mcp_domain`);--> statement-breakpoint
CREATE INDEX `idx_app_primary_domain` ON `apps` (`primary_domain`);--> statement-breakpoint
CREATE INDEX `idx_app_discovery` ON `apps` (`discovery_status`);--> statement-breakpoint
CREATE INDEX `idx_app_visibility` ON `apps` (`visibility`);--> statement-breakpoint
CREATE INDEX `idx_app_active_config_version` ON `apps` (`active_config_version_id`);--> statement-breakpoint
CREATE INDEX `idx_app_source` ON `apps` (`source_app_id`);--> statement-breakpoint
CREATE INDEX `idx_app_catalog` ON `apps` (`catalog_app_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_capability_links_target` ON `capability_links` (`capability_id`,`entity_kind`,`entity_id`);--> statement-breakpoint
CREATE INDEX `idx_capability_links_capability` ON `capability_links` (`capability_id`);--> statement-breakpoint
CREATE INDEX `idx_capability_links_org_entity` ON `capability_links` (`organization_id`,`entity_kind`,`entity_id`);--> statement-breakpoint
CREATE INDEX `idx_org_capabilities_org` ON `org_capabilities` (`organization_id`);--> statement-breakpoint
CREATE INDEX `idx_org_capabilities_parent` ON `org_capabilities` (`parent_id`);--> statement-breakpoint
CREATE INDEX `idx_org_capabilities_org_status` ON `org_capabilities` (`organization_id`,`status`);--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_org_capabilities_org_slug` ON `org_capabilities` (`organization_id`,`slug`);--> statement-breakpoint
CREATE INDEX `app_catalog_name_idx` ON `app_catalog` (`name`);--> statement-breakpoint
CREATE INDEX `app_catalog_slug_idx` ON `app_catalog` (`slug`);--> statement-breakpoint
CREATE INDEX `app_catalog_connector_type_idx` ON `app_catalog` (`connector_type`);--> statement-breakpoint
CREATE INDEX `app_catalog_category_idx` ON `app_catalog` (`category`);--> statement-breakpoint
CREATE INDEX `app_catalog_distribution_channel_idx` ON `app_catalog` (`distribution_channel`);--> statement-breakpoint
CREATE INDEX `app_catalog_status_idx` ON `app_catalog` (`status`);--> statement-breakpoint
CREATE INDEX `app_catalog_is_discoverable_idx` ON `app_catalog` (`is_discoverable`);--> statement-breakpoint
CREATE INDEX `app_catalog_developer_type_idx` ON `app_catalog` (`developer_type`);--> statement-breakpoint
CREATE INDEX `app_catalog_health_status_idx` ON `app_catalog` (`health_status`);--> statement-breakpoint
CREATE INDEX `app_catalog_tool_source_idx` ON `app_catalog` (`tool_source`);--> statement-breakpoint
CREATE UNIQUE INDEX `app_catalog_mcp_endpoint_hash_unique` ON `app_catalog` (`mcp_endpoint_hash`);--> statement-breakpoint
CREATE INDEX `idx_catalog_changes_app` ON `app_catalog_changes` (`catalog_app_id`,`detected_at`);--> statement-breakpoint
CREATE INDEX `idx_catalog_changes_type` ON `app_catalog_changes` (`change_type`,`detected_at`);--> statement-breakpoint
CREATE INDEX `health_history_app_idx` ON `app_catalog_health_history` (`catalog_app_id`);--> statement-breakpoint
CREATE INDEX `health_history_checked_idx` ON `app_catalog_health_history` (`checked_at`);--> statement-breakpoint
CREATE INDEX `health_history_app_checked_idx` ON `app_catalog_health_history` (`catalog_app_id`,`checked_at`);--> statement-breakpoint
CREATE INDEX `mcp_prompts_app_idx` ON `app_catalog_mcp_prompts` (`catalog_app_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `mcp_prompts_app_name_unique` ON `app_catalog_mcp_prompts` (`catalog_app_id`,`prompt_name`);--> statement-breakpoint
CREATE INDEX `mcp_resource_tpl_app_idx` ON `app_catalog_mcp_resource_templates` (`catalog_app_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `mcp_resource_tpl_app_name_unique` ON `app_catalog_mcp_resource_templates` (`catalog_app_id`,`name`);--> statement-breakpoint
CREATE INDEX `mcp_resources_app_idx` ON `app_catalog_mcp_resources` (`catalog_app_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `mcp_resources_app_uri_unique` ON `app_catalog_mcp_resources` (`catalog_app_id`,`uri`);--> statement-breakpoint
CREATE INDEX `mcp_tools_app_idx` ON `app_catalog_mcp_tools` (`catalog_app_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `mcp_tools_app_name_unique` ON `app_catalog_mcp_tools` (`catalog_app_id`,`tool_name`);--> statement-breakpoint
CREATE INDEX `mcp_tools_last_tested_idx` ON `app_catalog_mcp_tools` (`last_tested_at`);--> statement-breakpoint
CREATE INDEX `mcp_tools_test_count_idx` ON `app_catalog_mcp_tools` (`test_count`);--> statement-breakpoint
CREATE INDEX `mcp_tools_schema_source_idx` ON `app_catalog_mcp_tools` (`schema_source`);--> statement-breakpoint
CREATE UNIQUE INDEX `store_listings_app_source_unique` ON `app_catalog_store_listings` (`catalog_app_id`,`source`);--> statement-breakpoint
CREATE UNIQUE INDEX `store_listings_source_id_unique` ON `app_catalog_store_listings` (`source`,`source_app_id`);--> statement-breakpoint
CREATE INDEX `store_listings_app_idx` ON `app_catalog_store_listings` (`catalog_app_id`);--> statement-breakpoint
CREATE INDEX `store_listings_source_idx` ON `app_catalog_store_listings` (`source`);--> statement-breakpoint
CREATE INDEX `tool_tests_app_idx` ON `app_catalog_tool_tests` (`catalog_app_id`);--> statement-breakpoint
CREATE INDEX `tool_tests_tool_idx` ON `app_catalog_tool_tests` (`catalog_app_id`,`tool_name`);--> statement-breakpoint
CREATE INDEX `tool_tests_tested_at_idx` ON `app_catalog_tool_tests` (`tested_at`);--> statement-breakpoint
CREATE INDEX `tool_tests_success_idx` ON `app_catalog_tool_tests` (`success`);--> statement-breakpoint
CREATE INDEX `tool_tests_app_tool_tested_idx` ON `app_catalog_tool_tests` (`catalog_app_id`,`tool_name`,`tested_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `drift_reports_catalog_app_unique` ON `upstream_drift_reports` (`catalog_app_id`);--> statement-breakpoint
CREATE INDEX `drift_reports_checked_idx` ON `upstream_drift_reports` (`checked_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `connection_providers_descope_app_id_unique` ON `connection_providers` (`descope_app_id`);--> statement-breakpoint
CREATE INDEX `connection_providers_category_idx` ON `connection_providers` (`category`);--> statement-breakpoint
CREATE INDEX `connection_providers_type_idx` ON `connection_providers` (`type`);--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_external_agent_attribution` ON `external_agent_attributions` (`organization_id`,`target_type`,`target_id`,`role`,`principal_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_external_agent_attribution_org_id` ON `external_agent_attributions` (`organization_id`,`id`);--> statement-breakpoint
CREATE INDEX `idx_external_agent_attribution_session` ON `external_agent_attributions` (`organization_id`,`session_id`,`occurred_at`);--> statement-breakpoint
CREATE INDEX `idx_external_agent_attribution_work_item` ON `external_agent_attributions` (`organization_id`,`work_item_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_external_agent_mcp_client_record` ON `external_agent_mcp_credentials` (`client_record_id`);--> statement-breakpoint
CREATE INDEX `idx_external_agent_mcp_credential_session` ON `external_agent_mcp_credentials` (`organization_id`,`principal_id`,`session_id`,`status`);--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_external_agent_principal_org_id` ON `external_agent_principals` (`organization_id`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_external_agent_principal_key` ON `external_agent_principals` (`organization_id`,`key`);--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_external_agent_credential_binding` ON `external_agent_principals` (`organization_id`,`credential_binding_type`,`credential_binding_id`);--> statement-breakpoint
CREATE INDEX `idx_external_agent_principal_status` ON `external_agent_principals` (`organization_id`,`status`);--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_external_agent_review_principal_execution` ON `external_agent_review_evidence` (`organization_id`,`execution_attribution_id`,`reviewer_principal_type`,`reviewer_principal_id`);--> statement-breakpoint
CREATE INDEX `idx_external_agent_review_subject_context` ON `external_agent_review_evidence` (`organization_id`,`subject_principal_id`,`task_family`,`repository_key`,`risk_level`);--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_external_agent_session_org_principal_id` ON `external_agent_sessions` (`organization_id`,`principal_id`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_external_agent_session_key` ON `external_agent_sessions` (`organization_id`,`harness`,`external_session_key`);--> statement-breakpoint
CREATE INDEX `idx_external_agent_session_principal` ON `external_agent_sessions` (`organization_id`,`principal_id`,`status`);--> statement-breakpoint
CREATE INDEX `idx_generated_widget_artifacts_org` ON `generated_widget_artifacts` (`organization_id`);--> statement-breakpoint
CREATE INDEX `idx_generated_widget_artifacts_app` ON `generated_widget_artifacts` (`app_id`);--> statement-breakpoint
CREATE INDEX `idx_generated_widget_artifacts_app_slug` ON `generated_widget_artifacts` (`app_slug`);--> statement-breakpoint
CREATE INDEX `idx_generated_widget_artifacts_tool` ON `generated_widget_artifacts` (`app_tool_id`);--> statement-breakpoint
CREATE INDEX `idx_generated_widget_artifacts_status` ON `generated_widget_artifacts` (`status`);--> statement-breakpoint
CREATE INDEX `idx_generated_widget_artifacts_workflow` ON `generated_widget_artifacts` (`workflow_id`);--> statement-breakpoint
CREATE INDEX `idx_generated_widget_artifacts_created` ON `generated_widget_artifacts` (`created_at`);--> statement-breakpoint
CREATE INDEX `idx_items_app` ON `items` (`app_id`);--> statement-breakpoint
CREATE INDEX `idx_items_vertical` ON `items` (`vertical`);--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_learning_attr_org_client_event` ON `learning_feedback_attributions` (`organization_id`,`client_attribution_id`,`feedback_event_id`);--> statement-breakpoint
CREATE INDEX `idx_learning_attr_subject` ON `learning_feedback_attributions` (`organization_id`,`subject_kind`,`subject_id`);--> statement-breakpoint
CREATE INDEX `idx_learning_attr_event` ON `learning_feedback_attributions` (`feedback_event_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_learning_measure_org_client` ON `learning_feedback_measurements` (`organization_id`,`client_measurement_id`);--> statement-breakpoint
CREATE INDEX `idx_learning_measure_attr_window` ON `learning_feedback_measurements` (`attribution_id`,`window_kind`,`window_end`);--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_learning_proposal_org_client` ON `learning_improvement_proposals` (`organization_id`,`client_proposal_id`);--> statement-breakpoint
CREATE INDEX `idx_learning_proposal_org_status_updated` ON `learning_improvement_proposals` (`organization_id`,`status`,`updated_at`);--> statement-breakpoint
CREATE INDEX `idx_learning_proposal_tedi_issue` ON `learning_improvement_proposals` (`tedi_id`,`issue_key`);--> statement-breakpoint
CREATE INDEX `idx_learning_proposal_subject` ON `learning_improvement_proposals` (`organization_id`,`subject_kind`,`subject_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_learning_event_org_client` ON `learning_interaction_events` (`organization_id`,`client_event_id`);--> statement-breakpoint
CREATE INDEX `idx_learning_event_org_occurred` ON `learning_interaction_events` (`organization_id`,`occurred_at`);--> statement-breakpoint
CREATE INDEX `idx_learning_event_tedi_occurred` ON `learning_interaction_events` (`tedi_id`,`occurred_at`);--> statement-breakpoint
CREATE INDEX `idx_learning_event_scope` ON `learning_interaction_events` (`organization_id`,`scope_kind`,`scope_id`);--> statement-breakpoint
CREATE INDEX `idx_learning_event_issue` ON `learning_interaction_events` (`organization_id`,`issue_key`);--> statement-breakpoint
CREATE INDEX `idx_org_members_org` ON `organization_members` (`organization_id`);--> statement-breakpoint
CREATE INDEX `idx_org_members_user` ON `organization_members` (`descope_user_id`);--> statement-breakpoint
CREATE INDEX `idx_org_members_email` ON `organization_members` (`email`);--> statement-breakpoint
CREATE INDEX `idx_org_members_status` ON `organization_members` (`status`);--> statement-breakpoint
CREATE INDEX `idx_org_members_role` ON `organization_members` (`role`);--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_org_purpose_version` ON `organization_purpose_charters` (`org_id`,`version`);--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_org_purpose_active` ON `organization_purpose_charters` (`org_id`) WHERE "organization_purpose_charters"."status" = 'active';--> statement-breakpoint
CREATE INDEX `idx_org_purpose_history` ON `organization_purpose_charters` (`org_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `org_secrets_org_idx` ON `organization_secrets` (`organization_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `organizations_slug_unique` ON `organizations` (`slug`);--> statement-breakpoint
CREATE UNIQUE INDEX `organizations_descope_tenant_id_unique` ON `organizations` (`descope_tenant_id`) WHERE "organizations"."descope_tenant_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX `idx_org_slug` ON `organizations` (`slug`);--> statement-breakpoint
CREATE INDEX `idx_org_descope` ON `organizations` (`descope_tenant_id`);--> statement-breakpoint
CREATE INDEX `idx_org_status` ON `organizations` (`subscription_status`);--> statement-breakpoint
CREATE INDEX `idx_org_stripe_customer` ON `organizations` (`stripe_customer_id`);--> statement-breakpoint
CREATE INDEX `organizations_type_idx` ON `organizations` (`type`);--> statement-breakpoint
CREATE INDEX `idx_plugin_events_org` ON `tedi_plugin_events` (`org_id`);--> statement-breakpoint
CREATE INDEX `idx_plugin_events_plugin` ON `tedi_plugin_events` (`plugin_id`);--> statement-breakpoint
CREATE INDEX `idx_plugin_events_tedi` ON `tedi_plugin_events` (`tedi_id`);--> statement-breakpoint
CREATE INDEX `idx_plugin_events_status` ON `tedi_plugin_events` (`status`);--> statement-breakpoint
CREATE INDEX `idx_plugin_events_type` ON `tedi_plugin_events` (`event_type`);--> statement-breakpoint
CREATE INDEX `idx_plugin_installs_org` ON `tedi_plugin_installs` (`org_id`);--> statement-breakpoint
CREATE INDEX `idx_plugin_installs_plugin` ON `tedi_plugin_installs` (`plugin_id`);--> statement-breakpoint
CREATE INDEX `idx_plugin_installs_tedi` ON `tedi_plugin_installs` (`tedi_id`);--> statement-breakpoint
CREATE INDEX `idx_plugin_installs_status` ON `tedi_plugin_installs` (`status`);--> statement-breakpoint
CREATE INDEX `idx_plugins_type` ON `tedi_plugins` (`type`);--> statement-breakpoint
CREATE INDEX `idx_plugins_status` ON `tedi_plugins` (`status`);--> statement-breakpoint
CREATE INDEX `idx_plugins_author` ON `tedi_plugins` (`author_org_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_projects_org_key` ON `projects` (`org_id`,`key`);--> statement-breakpoint
CREATE INDEX `idx_projects_org_status` ON `projects` (`org_id`,`status`);--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_role_templates_org_key` ON `role_templates` (`org_id`,`key`);--> statement-breakpoint
CREATE INDEX `idx_role_templates_org` ON `role_templates` (`org_id`);--> statement-breakpoint
CREATE INDEX `idx_tedi_email_addresses_tedi` ON `tedi_email_addresses` (`tedi_id`,`status`);--> statement-breakpoint
CREATE INDEX `idx_tedi_email_addresses_org` ON `tedi_email_addresses` (`organization_id`,`status`);--> statement-breakpoint
CREATE INDEX `idx_tedi_email_attachments_message` ON `tedi_email_attachments` (`message_id`);--> statement-breakpoint
CREATE INDEX `idx_tedi_email_events_message` ON `tedi_email_events` (`message_id`);--> statement-breakpoint
CREATE INDEX `idx_tedi_email_events_thread` ON `tedi_email_events` (`thread_id`);--> statement-breakpoint
CREATE INDEX `idx_tedi_email_events_tedi_created` ON `tedi_email_events` (`tedi_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_tedi_email_messages_thread` ON `tedi_email_messages` (`thread_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_tedi_email_messages_tedi_created` ON `tedi_email_messages` (`tedi_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_tedi_email_messages_message_id` ON `tedi_email_messages` (`tedi_id`,`message_id_header`);--> statement-breakpoint
CREATE INDEX `idx_tedi_email_messages_unread` ON `tedi_email_messages` (`tedi_id`,`read_at`,`direction`);--> statement-breakpoint
CREATE INDEX `idx_tedi_email_threads_tedi_last` ON `tedi_email_threads` (`tedi_id`,`last_message_at`);--> statement-breakpoint
CREATE INDEX `idx_tedi_email_threads_org` ON `tedi_email_threads` (`organization_id`);--> statement-breakpoint
CREATE INDEX `idx_tedi_email_threads_status` ON `tedi_email_threads` (`tedi_id`,`status`);--> statement-breakpoint
CREATE INDEX `idx_tedi_email_threads_subject` ON `tedi_email_threads` (`tedi_id`,`subject_norm`);--> statement-breakpoint
CREATE INDEX `tedi_secrets_tedi_idx` ON `tedi_secrets` (`tedi_id`);--> statement-breakpoint
CREATE INDEX `idx_tedi_session_states_tedi_user` ON `tedi_session_states` (`tedi_id`,`user_id`);--> statement-breakpoint
CREATE INDEX `idx_tedi_session_states_pinned` ON `tedi_session_states` (`tedi_id`,`user_id`,`pinned_at`);--> statement-breakpoint
CREATE INDEX `idx_tedi_session_states_deleted` ON `tedi_session_states` (`tedi_id`,`user_id`,`deleted_at`);--> statement-breakpoint
CREATE INDEX `idx_call_costs_tedi` ON `tedi_call_costs` (`tedi_id`);--> statement-breakpoint
CREATE INDEX `idx_call_costs_org` ON `tedi_call_costs` (`org_id`,`snapshot_at`);--> statement-breakpoint
CREATE INDEX `idx_call_costs_window` ON `tedi_call_costs` (`tedi_id`,`snapshot_at`);--> statement-breakpoint
CREATE INDEX `idx_call_costs_model` ON `tedi_call_costs` (`tedi_id`,`model`,`snapshot_at`);--> statement-breakpoint
CREATE INDEX `idx_call_costs_source` ON `tedi_call_costs` (`tedi_id`,`source`,`snapshot_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_call_costs_gateway_log_id` ON `tedi_call_costs` (`gateway_log_id`);--> statement-breakpoint
CREATE INDEX `idx_custom_domains_tedi` ON `tedi_custom_domains` (`tedi_id`);--> statement-breakpoint
CREATE INDEX `idx_tedi_devices_tedi` ON `tedi_devices` (`tedi_id`);--> statement-breakpoint
CREATE INDEX `idx_tedi_devices_status` ON `tedi_devices` (`tedi_id`,`status`);--> statement-breakpoint
CREATE INDEX `idx_tedi_runtime_leases_tedi` ON `tedi_runtime_leases` (`tedi_id`);--> statement-breakpoint
CREATE INDEX `idx_tedi_runtime_leases_expires` ON `tedi_runtime_leases` (`expires_at`);--> statement-breakpoint
CREATE INDEX `idx_tedi_runtime_snapshots_tedi` ON `tedi_runtime_snapshots` (`tedi_id`);--> statement-breakpoint
CREATE INDEX `idx_tedi_runtime_snapshots_observed` ON `tedi_runtime_snapshots` (`tedi_id`,`observed_at`);--> statement-breakpoint
CREATE INDEX `idx_tedi_usage_events_tedi` ON `tedi_usage_events` (`tedi_id`);--> statement-breakpoint
CREATE INDEX `idx_tedi_usage_events_window` ON `tedi_usage_events` (`tedi_id`,`started_at`);--> statement-breakpoint
CREATE INDEX `idx_tedis_org` ON `tedis` (`organization_id`);--> statement-breakpoint
CREATE INDEX `idx_tedis_slug` ON `tedis` (`slug`);--> statement-breakpoint
CREATE INDEX `tedis_descope_user_id_idx` ON `tedis` (`descope_user_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `tedis_body_generation_token_hash_idx` ON `tedis` (`body_generation_token_hash`);--> statement-breakpoint
CREATE INDEX `idx_app_tools_app` ON `app_tools` (`app_id`);--> statement-breakpoint
CREATE INDEX `idx_app_tools_app_enabled` ON `app_tools` (`app_id`,`enabled`);--> statement-breakpoint
CREATE INDEX `idx_app_tools_app_sort` ON `app_tools` (`app_id`,`sort_order`);--> statement-breakpoint
CREATE INDEX `idx_user_configs_user` ON `user_configs` (`user_id`);--> statement-breakpoint
CREATE INDEX `idx_user_configs_namespace` ON `user_configs` (`namespace`);--> statement-breakpoint
CREATE INDEX `idx_users_email` ON `users` (`email`);--> statement-breakpoint
CREATE INDEX `idx_users_last_login` ON `users` (`last_login_at`);--> statement-breakpoint
CREATE INDEX `idx_work_item_checkouts_work_item` ON `work_item_checkouts` (`work_item_id`);--> statement-breakpoint
CREATE INDEX `idx_work_item_checkouts_tedi_status` ON `work_item_checkouts` (`tedi_id`,`status`);--> statement-breakpoint
CREATE INDEX `idx_work_item_checkouts_org` ON `work_item_checkouts` (`org_id`);--> statement-breakpoint
CREATE INDEX `idx_work_item_comments_work_item` ON `work_item_comments` (`work_item_id`);--> statement-breakpoint
CREATE INDEX `idx_work_item_comments_org` ON `work_item_comments` (`org_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_work_item_corroboration_principal` ON `work_item_corroborations` (`org_id`,`work_item_id`,`principal_type`,`principal_id`);--> statement-breakpoint
CREATE INDEX `idx_work_item_corroboration_item` ON `work_item_corroborations` (`org_id`,`work_item_id`);--> statement-breakpoint
CREATE INDEX `idx_work_item_executor_checkouts_work_item` ON `work_item_executor_checkouts` (`work_item_id`);--> statement-breakpoint
CREATE INDEX `idx_work_item_executor_checkouts_executor_status` ON `work_item_executor_checkouts` (`org_id`,`executor_type`,`executor_id`,`status`);--> statement-breakpoint
CREATE INDEX `idx_work_item_executor_checkouts_org` ON `work_item_executor_checkouts` (`org_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_work_item_executor_checkout_active` ON `work_item_executor_checkouts` (`org_id`,`work_item_id`) WHERE "work_item_executor_checkouts"."status" = 'active';--> statement-breakpoint
CREATE INDEX `idx_work_item_projections_work_item` ON `work_item_projections` (`work_item_id`);--> statement-breakpoint
CREATE INDEX `idx_work_item_projections_org_provider` ON `work_item_projections` (`org_id`,`provider`);--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_work_item_projection_provider` ON `work_item_projections` (`work_item_id`,`provider`);--> statement-breakpoint
CREATE INDEX `idx_work_item_relations_org` ON `work_item_relations` (`org_id`);--> statement-breakpoint
CREATE INDEX `idx_work_item_relations_from` ON `work_item_relations` (`from_work_item_id`);--> statement-breakpoint
CREATE INDEX `idx_work_item_relations_to` ON `work_item_relations` (`to_work_item_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_work_item_relation` ON `work_item_relations` (`from_work_item_id`,`to_work_item_id`,`relation_type`);--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_work_items_org_id` ON `work_items` (`org_id`,`id`);--> statement-breakpoint
CREATE INDEX `idx_work_items_org` ON `work_items` (`org_id`);--> statement-breakpoint
CREATE INDEX `idx_work_items_org_status` ON `work_items` (`org_id`,`status`);--> statement-breakpoint
CREATE INDEX `idx_work_items_project` ON `work_items` (`project_id`);--> statement-breakpoint
CREATE INDEX `idx_work_items_parent` ON `work_items` (`parent_work_item_id`);--> statement-breakpoint
CREATE INDEX `idx_work_items_assignee_tedi` ON `work_items` (`assignee_tedi_id`);--> statement-breakpoint
CREATE INDEX `idx_work_items_claimed_by_tedi` ON `work_items` (`claimed_by_tedi_id`);--> statement-breakpoint
CREATE INDEX `idx_work_items_claimed_by_executor` ON `work_items` (`org_id`,`claimed_by_executor_type`,`claimed_by_executor_id`);--> statement-breakpoint
CREATE INDEX `idx_work_items_objective` ON `work_items` (`objective_id`);--> statement-breakpoint
CREATE INDEX `idx_work_items_org_class` ON `work_items` (`org_id`,`work_class`);--> statement-breakpoint
CREATE INDEX `idx_work_items_internal_task` ON `work_items` (`internal_task_id`);--> statement-breakpoint
CREATE INDEX `idx_work_items_source_intent` ON `work_items` (`source_intent_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_work_items_org_source_intent` ON `work_items` (`org_id`,`source_intent_id`);--> statement-breakpoint
CREATE INDEX `idx_workstation_leases_workstation` ON `workstation_leases` (`workstation_id`);--> statement-breakpoint
CREATE INDEX `idx_workstation_leases_org` ON `workstation_leases` (`org_id`);--> statement-breakpoint
CREATE INDEX `idx_workstation_leases_kernel_run` ON `workstation_leases` (`kernel_run_id`);--> statement-breakpoint
CREATE INDEX `idx_workstation_leases_work_item` ON `workstation_leases` (`work_item_id`);--> statement-breakpoint
CREATE INDEX `idx_workstation_leases_trace_bundle` ON `workstation_leases` (`trace_bundle_id`);--> statement-breakpoint
CREATE INDEX `idx_workstation_leases_status` ON `workstation_leases` (`status`);--> statement-breakpoint
CREATE INDEX `idx_workstation_leases_body_generation` ON `workstation_leases` (`body_generation_id`);--> statement-breakpoint
CREATE INDEX `idx_workstation_participants_lease` ON `workstation_participants` (`lease_id`);--> statement-breakpoint
CREATE INDEX `idx_workstation_participants_tedi` ON `workstation_participants` (`tedi_id`);--> statement-breakpoint
CREATE INDEX `idx_workstation_participants_org` ON `workstation_participants` (`org_id`);--> statement-breakpoint
CREATE INDEX `idx_workstation_sessions_lease` ON `workstation_sessions` (`lease_id`);--> statement-breakpoint
CREATE INDEX `idx_workstation_sessions_participant` ON `workstation_sessions` (`participant_id`);--> statement-breakpoint
CREATE INDEX `idx_workstation_sessions_org` ON `workstation_sessions` (`org_id`);--> statement-breakpoint
CREATE INDEX `idx_workstation_sessions_kind` ON `workstation_sessions` (`kind`);--> statement-breakpoint
CREATE INDEX `idx_workstations_org` ON `workstations` (`org_id`);--> statement-breakpoint
CREATE INDEX `idx_workstations_org_profile` ON `workstations` (`org_id`,`profile_id`);--> statement-breakpoint
CREATE INDEX `idx_workstations_status` ON `workstations` (`status`);--> statement-breakpoint
CREATE INDEX `idx_approval_requests_org` ON `tedi_approval_requests` (`org_id`);--> statement-breakpoint
CREATE INDEX `idx_approval_requests_tedi` ON `tedi_approval_requests` (`tedi_id`);--> statement-breakpoint
CREATE INDEX `idx_approval_requests_status` ON `tedi_approval_requests` (`org_id`,`status`);--> statement-breakpoint
CREATE INDEX `idx_approval_requests_tedi_status` ON `tedi_approval_requests` (`tedi_id`,`status`);--> statement-breakpoint
CREATE INDEX `idx_knowledge_entries_org` ON `knowledge_entries` (`organization_id`);--> statement-breakpoint
CREATE INDEX `idx_knowledge_entries_tedi` ON `knowledge_entries` (`tedi_id`);--> statement-breakpoint
CREATE INDEX `idx_knowledge_entries_domain` ON `knowledge_entries` (`domain_id`);--> statement-breakpoint
CREATE INDEX `idx_knowledge_entries_type` ON `knowledge_entries` (`entry_type`);--> statement-breakpoint
CREATE INDEX `idx_knowledge_entries_visibility` ON `knowledge_entries` (`visibility`);--> statement-breakpoint
CREATE INDEX `idx_knowledge_entries_org_domain` ON `knowledge_entries` (`organization_id`,`domain_id`);--> statement-breakpoint
CREATE INDEX `idx_knowledge_entries_supersedes` ON `knowledge_entries` (`supersedes_id`);--> statement-breakpoint
CREATE INDEX `idx_skill_entries_org` ON `skill_entries` (`organization_id`);--> statement-breakpoint
CREATE INDEX `idx_skill_entries_tedi` ON `skill_entries` (`tedi_id`);--> statement-breakpoint
CREATE INDEX `idx_skill_entries_domain` ON `skill_entries` (`domain_id`);--> statement-breakpoint
CREATE INDEX `idx_skill_entries_visibility` ON `skill_entries` (`visibility`);--> statement-breakpoint
CREATE INDEX `idx_skill_entries_org_domain` ON `skill_entries` (`organization_id`,`domain_id`);--> statement-breakpoint
CREATE INDEX `idx_skill_entries_supersedes` ON `skill_entries` (`supersedes_id`);--> statement-breakpoint
CREATE INDEX `idx_skill_entries_source_skill` ON `skill_entries` (`source_skill_id`);--> statement-breakpoint
CREATE INDEX `idx_skill_entries_app` ON `skill_entries` (`app_id`);--> statement-breakpoint
CREATE INDEX `idx_skill_entries_org_app` ON `skill_entries` (`organization_id`,`app_id`);--> statement-breakpoint
CREATE INDEX `idx_skill_entries_org_visibility` ON `skill_entries` (`organization_id`,`visibility`);--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_skill_entries_org_slug` ON `skill_entries` (`organization_id`,`slug`);--> statement-breakpoint
CREATE INDEX `idx_skill_entries_lifecycle` ON `skill_entries` (`lifecycle_state`);--> statement-breakpoint
CREATE INDEX `idx_skill_entries_pace_layer` ON `skill_entries` (`pace_layer`);--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_skill_run_artifacts_path` ON `skill_run_artifacts` (`run_id`,`path`);--> statement-breakpoint
CREATE INDEX `idx_skill_run_artifacts_run` ON `skill_run_artifacts` (`run_id`);--> statement-breakpoint
CREATE INDEX `idx_skill_runs_org_status` ON `skill_runs` (`organization_id`,`status`);--> statement-breakpoint
CREATE INDEX `idx_skill_runs_skill` ON `skill_runs` (`skill_id`);--> statement-breakpoint
CREATE INDEX `idx_skill_runs_tedi_started` ON `skill_runs` (`tedi_id`,`started_at`);--> statement-breakpoint
CREATE INDEX `idx_skill_runs_reconcile` ON `skill_runs` (`runtime_environment`,`last_reconciled_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_skill_runs_workflow_instance` ON `skill_runs` (`workflow_instance_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_skill_schedules_skill` ON `skill_schedules` (`skill_id`);--> statement-breakpoint
CREATE INDEX `idx_skill_schedules_due` ON `skill_schedules` (`enabled`,`next_fire_at`);--> statement-breakpoint
CREATE INDEX `idx_skill_schedules_org` ON `skill_schedules` (`organization_id`);--> statement-breakpoint
CREATE INDEX `idx_skill_schedules_tedi` ON `skill_schedules` (`tedi_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_skill_usage_events_run` ON `skill_usage_events` (`run_id`,`execution_epoch`);--> statement-breakpoint
CREATE INDEX `idx_skill_usage_events_skill_outcome` ON `skill_usage_events` (`skill_id`,`outcome`);--> statement-breakpoint
CREATE INDEX `idx_skill_usage_events_tedi_created` ON `skill_usage_events` (`tedi_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_skill_usage_events_org_created` ON `skill_usage_events` (`organization_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_muscle_memory_tedi` ON `tedi_muscle_memory` (`tedi_id`);--> statement-breakpoint
CREATE INDEX `idx_muscle_memory_org` ON `tedi_muscle_memory` (`organization_id`);--> statement-breakpoint
CREATE INDEX `idx_muscle_memory_kind` ON `tedi_muscle_memory` (`kind`);--> statement-breakpoint
CREATE INDEX `idx_muscle_memory_origin` ON `tedi_muscle_memory` (`origin`);--> statement-breakpoint
CREATE INDEX `idx_muscle_memory_source_skill` ON `tedi_muscle_memory` (`source_skill_id`);--> statement-breakpoint
CREATE INDEX `idx_muscle_memory_tedi_name` ON `tedi_muscle_memory` (`tedi_id`,`name`);--> statement-breakpoint
CREATE INDEX `idx_workspace_edits_tedi` ON `tedi_workspace_edits` (`tedi_id`);--> statement-breakpoint
CREATE INDEX `idx_workspace_edits_org` ON `tedi_workspace_edits` (`organization_id`);--> statement-breakpoint
CREATE INDEX `idx_workspace_edits_filename` ON `tedi_workspace_edits` (`filename`);--> statement-breakpoint
CREATE INDEX `idx_workspace_edits_tedi_filename` ON `tedi_workspace_edits` (`tedi_id`,`filename`);--> statement-breakpoint
CREATE INDEX `idx_workspace_edits_category` ON `tedi_workspace_edits` (`category`);--> statement-breakpoint
CREATE INDEX `idx_chat_dispatch_idem_tedi_convo` ON `chat_dispatch_idempotency` (`tedi_id`,`conversation_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_chat_dispatch_idem_run` ON `chat_dispatch_idempotency` (`tedi_id`,`run_id`);--> statement-breakpoint
CREATE INDEX `idx_chat_dispatch_idem_created` ON `chat_dispatch_idempotency` (`created_at`);--> statement-breakpoint
CREATE INDEX `idx_kernel_conversation_grants_conversation` ON `kernel_conversation_grants` (`organization_id`,`conversation_id`);--> statement-breakpoint
CREATE INDEX `idx_kernel_conversation_grants_user` ON `kernel_conversation_grants` (`organization_id`,`grantee_descope_user_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_kernel_conversation_grants_unique_user` ON `kernel_conversation_grants` (`organization_id`,`conversation_id`,`grantee_descope_user_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_kernel_conversations_org_conversation` ON `kernel_conversations` (`organization_id`,`conversation_id`);--> statement-breakpoint
CREATE INDEX `idx_kernel_conversations_org_last_message` ON `kernel_conversations` (`organization_id`,`last_message_at`,`conversation_id`);--> statement-breakpoint
CREATE INDEX `idx_kernel_home_approval_mirrors_active` ON `kernel_home_approval_mirrors` (`organization_id`,`parent_conversation_id`,`status`,`updated_at`) WHERE cleared_at is null;--> statement-breakpoint
CREATE INDEX `idx_kernel_home_approval_mirrors_child` ON `kernel_home_approval_mirrors` (`organization_id`,`parent_conversation_id`,`child_run_id`);--> statement-breakpoint
CREATE INDEX `idx_kernel_runtime_events_org_created` ON `kernel_runtime_events` (`organization_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_kernel_runtime_events_conversation_created` ON `kernel_runtime_events` (`organization_id`,`conversation_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_kernel_runtime_events_run` ON `kernel_runtime_events` (`organization_id`,`run_id`);--> statement-breakpoint
CREATE INDEX `idx_kernel_runtime_events_run_created` ON `kernel_runtime_events` (`organization_id`,`run_id`,`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `idx_kernel_runtime_events_child_created` ON `kernel_runtime_events` (`organization_id`,`child_run_id`,`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `idx_kernel_runtime_events_delegated_tedi` ON `kernel_runtime_events` (`delegated_tedi_id`);--> statement-breakpoint
CREATE INDEX `idx_kernel_runtime_events_trace` ON `kernel_runtime_events` (`organization_id`,`trace_id`,`created_at`) WHERE trace_id is not null;--> statement-breakpoint
CREATE INDEX `idx_kernel_runtime_runs_conversation_updated` ON `kernel_runtime_runs` (`organization_id`,`conversation_id`,`updated_at`);--> statement-breakpoint
CREATE INDEX `idx_kernel_runtime_runs_status_updated` ON `kernel_runtime_runs` (`organization_id`,`status`,`updated_at`);--> statement-breakpoint
CREATE INDEX `idx_kernel_runtime_runs_child` ON `kernel_runtime_runs` (`delegated_tedi_id`,`child_run_id`);--> statement-breakpoint
CREATE INDEX `idx_kernel_wake_queue_org_acked` ON `kernel_wake_queue` (`organization_id`,`acked_at`,`queued_at`);--> statement-breakpoint
CREATE INDEX `idx_kernel_wake_queue_conversation` ON `kernel_wake_queue` (`organization_id`,`parent_conversation_id`,`acked_at`);--> statement-breakpoint
CREATE INDEX `idx_tedi_artifacts_org` ON `tedi_artifacts` (`organization_id`);--> statement-breakpoint
CREATE INDEX `idx_tedi_artifacts_tedi_created` ON `tedi_artifacts` (`tedi_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_tedi_artifacts_conversation` ON `tedi_artifacts` (`tedi_id`,`conversation_id`);--> statement-breakpoint
CREATE INDEX `idx_tedi_artifacts_run` ON `tedi_artifacts` (`tedi_id`,`run_id`);--> statement-breakpoint
CREATE INDEX `idx_tedi_artifacts_kind` ON `tedi_artifacts` (`tedi_id`,`kind`);--> statement-breakpoint
CREATE INDEX `idx_tedi_runtime_events_org` ON `tedi_runtime_events` (`organization_id`);--> statement-breakpoint
CREATE INDEX `idx_tedi_runtime_events_tedi_created` ON `tedi_runtime_events` (`tedi_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_tedi_runtime_events_conversation_created` ON `tedi_runtime_events` (`tedi_id`,`conversation_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_tedi_runtime_events_run` ON `tedi_runtime_events` (`tedi_id`,`run_id`);--> statement-breakpoint
CREATE INDEX `idx_tedi_runtime_events_run_created` ON `tedi_runtime_events` (`tedi_id`,`run_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_tedi_runtime_events_kind_created` ON `tedi_runtime_events` (`tedi_id`,`kind`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_tedi_runtime_events_artifact` ON `tedi_runtime_events` (`artifact_id`);--> statement-breakpoint
CREATE INDEX `idx_tedi_runtime_events_trace` ON `tedi_runtime_events` (`trace_id`,`created_at`) WHERE trace_id is not null;--> statement-breakpoint
CREATE INDEX `idx_content_sources_app_id` ON `content_sources` (`app_id`);--> statement-breakpoint
CREATE INDEX `idx_content_sources_status` ON `content_sources` (`last_ingest_status`);--> statement-breakpoint
CREATE INDEX `idx_policy_packs_org` ON `policy_packs` (`organization_id`);--> statement-breakpoint
CREATE INDEX `idx_policy_packs_status` ON `policy_packs` (`status`);--> statement-breakpoint
CREATE INDEX `idx_policy_packs_target` ON `policy_packs` (`target`);--> statement-breakpoint
CREATE INDEX `idx_runtime_profiles_org` ON `runtime_profiles` (`organization_id`);--> statement-breakpoint
CREATE INDEX `idx_runtime_profiles_status` ON `runtime_profiles` (`status`);--> statement-breakpoint
CREATE INDEX `idx_workspace_template_sets_org` ON `workspace_template_sets` (`organization_id`);--> statement-breakpoint
CREATE INDEX `idx_workspace_template_sets_status` ON `workspace_template_sets` (`status`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_tedi_cron_executions_fire` ON `tedi_cron_executions` (`tedi_id`,`fire_key`);--> statement-breakpoint
CREATE INDEX `idx_tedi_cron_executions_name_started` ON `tedi_cron_executions` (`tedi_id`,`cron_name`,`started_at`);--> statement-breakpoint
CREATE INDEX `idx_tedi_cron_executions_org` ON `tedi_cron_executions` (`org_id`);--> statement-breakpoint
CREATE INDEX `idx_tedi_cron_executions_org_started` ON `tedi_cron_executions` (`org_id`,`started_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_competency_attestation_principal` ON `competency_observation_attestations` (`observation_id`,`principal_type`,`principal_id`);--> statement-breakpoint
CREATE INDEX `idx_competency_attestation_org_principal` ON `competency_observation_attestations` (`organization_id`,`principal_type`,`principal_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_competency_observation_org_client` ON `competency_observations` (`organization_id`,`client_observation_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_competency_observation_episode_activity` ON `competency_observations` (`organization_id`,`tedi_id`,`execution_opportunity_id`,`activity_id`,`rubric_version`,`harness_version`);--> statement-breakpoint
CREATE INDEX `idx_competency_observation_subject` ON `competency_observations` (`tedi_id`,`activity_id`,`occurred_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_delegation_value_claim_observation` ON `delegation_value_claims` (`organization_id`,`observation_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_delegation_value_claim_event` ON `delegation_value_claims` (`organization_id`,`value_event_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_delegation_value_claim_evidence` ON `delegation_value_claims` (`organization_id`,`value_evidence_ref`);--> statement-breakpoint
CREATE INDEX `idx_delegation_value_claim_tedi` ON `delegation_value_claims` (`organization_id`,`tedi_id`,`created_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_entrustable_activity_platform_version` ON `entrustable_activities` (`key`,`version`) WHERE "entrustable_activities"."organization_id" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_entrustable_activity_org_version` ON `entrustable_activities` (`organization_id`,`key`,`version`) WHERE "entrustable_activities"."organization_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_entrustable_activity_platform_head` ON `entrustable_activities` (`key`) WHERE "entrustable_activities"."organization_id" IS NULL AND "entrustable_activities"."status" = 'active';--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_entrustable_activity_org_head` ON `entrustable_activities` (`organization_id`,`key`) WHERE "entrustable_activities"."organization_id" IS NOT NULL AND "entrustable_activities"."status" = 'active';--> statement-breakpoint
CREATE INDEX `idx_entrustable_activity_risk` ON `entrustable_activities` (`risk_level`);--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_promotion_decision_observation` ON `promotion_decision_observations` (`decision_id`,`observation_id`);--> statement-breakpoint
CREATE INDEX `idx_promotion_decision_observation_org` ON `promotion_decision_observations` (`organization_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_promotion_decision_org_client` ON `promotion_decisions` (`organization_id`,`client_proposal_id`);--> statement-breakpoint
CREATE INDEX `idx_promotion_decision_subject_status` ON `promotion_decisions` (`tedi_id`,`status`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_promotion_decision_org_kind` ON `promotion_decisions` (`organization_id`,`kind`,`created_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_tedi_entrustment_grant_activity` ON `tedi_entrustment_grants` (`tedi_id`,`activity_id`);--> statement-breakpoint
CREATE INDEX `idx_tedi_entrustment_grant_org_status` ON `tedi_entrustment_grants` (`organization_id`,`status`);--> statement-breakpoint
CREATE INDEX `idx_tedi_entrustment_grant_expiry` ON `tedi_entrustment_grants` (`status`,`expires_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_tedi_role_assignment_instance` ON `tedi_role_assignments` (`tedi_id`,`role_key`,`assigned_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_tedi_role_assignment_active` ON `tedi_role_assignments` (`tedi_id`) WHERE "tedi_role_assignments"."status" = 'active';--> statement-breakpoint
CREATE INDEX `idx_tedi_role_assignment_org_stage` ON `tedi_role_assignments` (`organization_id`,`career_stage`);--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_xai_flywheel_snapshot_bucket` ON `xai_flywheel_snapshots` (`tedi_id`,`bucket_start`,`bucket_end`);--> statement-breakpoint
CREATE INDEX `idx_xai_flywheel_snapshot_org` ON `xai_flywheel_snapshots` (`org_id`);--> statement-breakpoint
CREATE INDEX `idx_xai_flywheel_snapshot_tedi_end` ON `xai_flywheel_snapshots` (`tedi_id`,`bucket_end`);--> statement-breakpoint
CREATE INDEX `idx_harness_eval_results_version` ON `harness_eval_results` (`harness_version_id`);--> statement-breakpoint
CREATE INDEX `idx_harness_eval_results_tedi_created` ON `harness_eval_results` (`tedi_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_harness_eval_results_org` ON `harness_eval_results` (`org_id`);--> statement-breakpoint
CREATE INDEX `idx_harness_eval_runs_version` ON `harness_eval_runs` (`harness_version_id`);--> statement-breakpoint
CREATE INDEX `idx_harness_eval_runs_tedi_created` ON `harness_eval_runs` (`tedi_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_harness_eval_runs_org` ON `harness_eval_runs` (`org_id`);--> statement-breakpoint
CREATE INDEX `idx_harness_subject_eval_results_subject` ON `harness_subject_eval_results` (`subject_kind`,`subject_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_harness_subject_eval_results_org` ON `harness_subject_eval_results` (`org_id`);--> statement-breakpoint
CREATE INDEX `idx_harness_subject_eval_results_version` ON `harness_subject_eval_results` (`harness_version_id`);--> statement-breakpoint
CREATE INDEX `idx_harness_subject_eval_results_created` ON `harness_subject_eval_results` (`created_at`);--> statement-breakpoint
CREATE INDEX `idx_harness_subject_eval_runs_subject` ON `harness_subject_eval_runs` (`subject_kind`,`subject_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_harness_subject_eval_runs_org` ON `harness_subject_eval_runs` (`org_id`);--> statement-breakpoint
CREATE INDEX `idx_harness_subject_eval_runs_version` ON `harness_subject_eval_runs` (`harness_version_id`);--> statement-breakpoint
CREATE INDEX `idx_harness_subject_eval_runs_created` ON `harness_subject_eval_runs` (`created_at`);--> statement-breakpoint
CREATE INDEX `idx_harness_subject_trace_bundles_subject_run` ON `harness_subject_trace_bundles` (`subject_kind`,`subject_id`,`run_id`);--> statement-breakpoint
CREATE INDEX `idx_harness_subject_trace_bundles_subject_created` ON `harness_subject_trace_bundles` (`subject_kind`,`subject_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_harness_subject_trace_bundles_version` ON `harness_subject_trace_bundles` (`harness_version_id`);--> statement-breakpoint
CREATE INDEX `idx_harness_subject_trace_bundles_org` ON `harness_subject_trace_bundles` (`org_id`);--> statement-breakpoint
CREATE INDEX `idx_harness_subject_trace_bundles_tedi` ON `harness_subject_trace_bundles` (`tedi_id`);--> statement-breakpoint
CREATE INDEX `idx_harness_subject_versions_subject_created` ON `harness_subject_versions` (`subject_kind`,`subject_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_harness_subject_versions_subject_status` ON `harness_subject_versions` (`subject_kind`,`subject_id`,`promotion_status`);--> statement-breakpoint
CREATE INDEX `idx_harness_subject_versions_org` ON `harness_subject_versions` (`org_id`);--> statement-breakpoint
CREATE INDEX `idx_harness_subject_versions_tedi` ON `harness_subject_versions` (`tedi_id`);--> statement-breakpoint
CREATE INDEX `idx_harness_versions_tedi_created` ON `harness_versions` (`tedi_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_harness_versions_tedi_status` ON `harness_versions` (`tedi_id`,`promotion_status`);--> statement-breakpoint
CREATE INDEX `idx_harness_versions_org` ON `harness_versions` (`org_id`);--> statement-breakpoint
CREATE INDEX `idx_trace_bundles_tedi_run` ON `trace_bundles` (`tedi_id`,`run_id`);--> statement-breakpoint
CREATE INDEX `idx_trace_bundles_tedi_created` ON `trace_bundles` (`tedi_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_trace_bundles_version` ON `trace_bundles` (`harness_version_id`);--> statement-breakpoint
CREATE INDEX `idx_trace_bundles_org` ON `trace_bundles` (`org_id`);--> statement-breakpoint
CREATE INDEX `idx_mcp_tool_approval_grants_lookup` ON `mcp_tool_approval_grants` (`organization_id`,`subject_id`,`tool_id`);--> statement-breakpoint
CREATE INDEX `idx_mcp_tool_approval_grants_expiry` ON `mcp_tool_approval_grants` (`expires_at`);--> statement-breakpoint
CREATE INDEX `idx_mcp_payment_account_org` ON `mcp_payment_accounts` (`organization_id`);--> statement-breakpoint
CREATE INDEX `idx_mcp_payment_account_tedi` ON `mcp_payment_accounts` (`tedi_id`);--> statement-breakpoint
CREATE INDEX `idx_mcp_payment_account_app` ON `mcp_payment_accounts` (`app_slug`);--> statement-breakpoint
CREATE INDEX `idx_mcp_payment_account_status` ON `mcp_payment_accounts` (`status`);--> statement-breakpoint
CREATE INDEX `idx_mcp_payment_requirement` ON `mcp_payment_events` (`requirement_id`);--> statement-breakpoint
CREATE INDEX `idx_mcp_payment_app` ON `mcp_payment_events` (`app_id`);--> statement-breakpoint
CREATE INDEX `idx_mcp_payment_org` ON `mcp_payment_events` (`organization_id`);--> statement-breakpoint
CREATE INDEX `idx_mcp_payment_tedi` ON `mcp_payment_events` (`tedi_id`);--> statement-breakpoint
CREATE INDEX `idx_mcp_payment_tool` ON `mcp_payment_events` (`app_slug`,`tool_id`);--> statement-breakpoint
CREATE INDEX `idx_mcp_payment_status` ON `mcp_payment_events` (`status`);--> statement-breakpoint
CREATE INDEX `idx_mcp_payment_created` ON `mcp_payment_events` (`created_at`);--> statement-breakpoint
CREATE INDEX `idx_mcp_payment_rationale` ON `mcp_payment_events` (`rationale_record_id`);--> statement-breakpoint
CREATE INDEX `idx_mcp_payment_policy_org` ON `mcp_payment_policies` (`organization_id`);--> statement-breakpoint
CREATE INDEX `idx_mcp_payment_policy_tedi` ON `mcp_payment_policies` (`tedi_id`);--> statement-breakpoint
CREATE INDEX `idx_mcp_payment_policy_tool` ON `mcp_payment_policies` (`app_slug`,`tool_id`);--> statement-breakpoint
CREATE INDEX `idx_mcp_payment_policy_enabled` ON `mcp_payment_policies` (`enabled`);--> statement-breakpoint
CREATE INDEX `idx_mcp_payment_reservation_org` ON `mcp_payment_reservations` (`organization_id`);--> statement-breakpoint
CREATE INDEX `idx_mcp_payment_reservation_tedi` ON `mcp_payment_reservations` (`tedi_id`);--> statement-breakpoint
CREATE INDEX `idx_mcp_payment_reservation_tool` ON `mcp_payment_reservations` (`app_slug`,`tool_id`);--> statement-breakpoint
CREATE INDEX `idx_mcp_payment_reservation_status` ON `mcp_payment_reservations` (`status`);--> statement-breakpoint
CREATE INDEX `idx_mcp_payment_reservation_expires` ON `mcp_payment_reservations` (`expires_at`);--> statement-breakpoint
CREATE INDEX `idx_mcp_tasks_task_id` ON `mcp_tasks` (`task_id`);--> statement-breakpoint
CREATE INDEX `idx_mcp_tasks_org_app_status` ON `mcp_tasks` (`org_id`,`app_id`,`status`);--> statement-breakpoint
CREATE INDEX `idx_mcp_tasks_expires_at` ON `mcp_tasks` (`expires_at`);--> statement-breakpoint
CREATE INDEX `idx_mcp_tasks_workflow_id` ON `mcp_tasks` (`workflow_id`);--> statement-breakpoint
CREATE INDEX `idx_mcp_telemetry_tedi` ON `mcp_telemetry_events` (`tedi_id`);--> statement-breakpoint
CREATE INDEX `idx_mcp_telemetry_org` ON `mcp_telemetry_events` (`organization_id`);--> statement-breakpoint
CREATE INDEX `idx_mcp_telemetry_type` ON `mcp_telemetry_events` (`event_type`);--> statement-breakpoint
CREATE INDEX `idx_mcp_telemetry_created` ON `mcp_telemetry_events` (`created_at`);--> statement-breakpoint
CREATE INDEX `idx_mcp_telemetry_flywheel` ON `mcp_telemetry_events` (`tedi_id`,`event_type`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_mcp_telemetry_server` ON `mcp_telemetry_events` (`server_id`);--> statement-breakpoint
CREATE INDEX `idx_memory_domains_org` ON `memory_domains` (`organization_id`);--> statement-breakpoint
CREATE INDEX `idx_memory_domains_parent` ON `memory_domains` (`parent_id`);--> statement-breakpoint
CREATE INDEX `idx_memory_edges_source` ON `memory_edges` (`source_fact_id`);--> statement-breakpoint
CREATE INDEX `idx_memory_edges_target` ON `memory_edges` (`target_fact_id`);--> statement-breakpoint
CREATE INDEX `idx_memory_edges_type` ON `memory_edges` (`relation_type`);--> statement-breakpoint
CREATE INDEX `idx_memory_facts_org` ON `memory_facts` (`organization_id`);--> statement-breakpoint
CREATE INDEX `idx_memory_facts_tedi` ON `memory_facts` (`tedi_id`);--> statement-breakpoint
CREATE INDEX `idx_memory_facts_domain` ON `memory_facts` (`domain_id`);--> statement-breakpoint
CREATE INDEX `idx_memory_facts_type` ON `memory_facts` (`fact_type`);--> statement-breakpoint
CREATE INDEX `idx_memory_facts_confidence` ON `memory_facts` (`confidence`);--> statement-breakpoint
CREATE INDEX `idx_memory_facts_source` ON `memory_facts` (`source`);--> statement-breakpoint
CREATE INDEX `idx_memory_facts_archived` ON `memory_facts` (`archived_at`);--> statement-breakpoint
CREATE INDEX `idx_memory_facts_valid_to` ON `memory_facts` (`valid_to`);--> statement-breakpoint
CREATE INDEX `idx_memory_facts_status` ON `memory_facts` (`status`);--> statement-breakpoint
CREATE INDEX `idx_memory_facts_org_type` ON `memory_facts` (`organization_id`,`fact_type`);--> statement-breakpoint
CREATE INDEX `idx_memory_facts_org_domain` ON `memory_facts` (`organization_id`,`domain_id`);--> statement-breakpoint
CREATE INDEX `idx_memory_facts_visibility` ON `memory_facts` (`visibility`);--> statement-breakpoint
CREATE INDEX `idx_memory_facts_priority` ON `memory_facts` (`priority`);--> statement-breakpoint
CREATE INDEX `idx_memory_facts_topic_key` ON `memory_facts` (`organization_id`,`topic_key`);--> statement-breakpoint
CREATE INDEX `idx_memory_facts_scope` ON `memory_facts` (`organization_id`,`memory_scope`);--> statement-breakpoint
CREATE INDEX `idx_memory_facts_flywheel_created` ON `memory_facts` (`organization_id`,`tedi_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_memory_facts_flywheel_accessed` ON `memory_facts` (`organization_id`,`last_accessed_at`);--> statement-breakpoint
CREATE INDEX `idx_memory_facts_flywheel_updated` ON `memory_facts` (`organization_id`,`updated_at`);--> statement-breakpoint
CREATE INDEX `idx_memory_facts_use_policy` ON `memory_facts` (`use_policy`);--> statement-breakpoint
CREATE INDEX `idx_memory_facts_review_status` ON `memory_facts` (`review_status`);--> statement-breakpoint
CREATE INDEX `memory_facts_tedi_domain_idx` ON `memory_facts` (`tedi_id`,`domain_id`);--> statement-breakpoint
CREATE INDEX `idx_curiosity_queue_tedi` ON `tedi_curiosity_queue` (`tedi_id`);--> statement-breakpoint
CREATE INDEX `idx_curiosity_queue_org` ON `tedi_curiosity_queue` (`organization_id`);--> statement-breakpoint
CREATE INDEX `idx_curiosity_queue_status` ON `tedi_curiosity_queue` (`status`);--> statement-breakpoint
CREATE INDEX `idx_curiosity_queue_priority` ON `tedi_curiosity_queue` (`priority`);--> statement-breakpoint
CREATE INDEX `idx_tedi_expertise_tedi` ON `tedi_expertise` (`tedi_id`);--> statement-breakpoint
CREATE INDEX `idx_tedi_expertise_domain` ON `tedi_expertise` (`domain_id`);--> statement-breakpoint
CREATE INDEX `idx_optimization_signals_tedi` ON `tedi_optimization_signals` (`tedi_id`);--> statement-breakpoint
CREATE INDEX `idx_optimization_signals_org` ON `tedi_optimization_signals` (`organization_id`);--> statement-breakpoint
CREATE INDEX `idx_optimization_signals_status` ON `tedi_optimization_signals` (`status`);--> statement-breakpoint
CREATE INDEX `idx_optimization_signals_roi` ON `tedi_optimization_signals` (`roi`);--> statement-breakpoint
CREATE INDEX `idx_rationale_org` ON `tedi_rationale_records` (`org_id`);--> statement-breakpoint
CREATE INDEX `idx_rationale_tedi` ON `tedi_rationale_records` (`tedi_id`);--> statement-breakpoint
CREATE INDEX `idx_rationale_tedi_created` ON `tedi_rationale_records` (`tedi_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_rationale_flywheel_window` ON `tedi_rationale_records` (`tedi_id`,`org_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_rationale_replay` ON `tedi_rationale_records` (`tedi_id`,`org_id`,`category`,`outcome_status`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_rationale_category` ON `tedi_rationale_records` (`tedi_id`,`category`);--> statement-breakpoint
CREATE INDEX `idx_rationale_outcome` ON `tedi_rationale_records` (`tedi_id`,`outcome_status`);--> statement-breakpoint
CREATE INDEX `idx_rationale_run` ON `tedi_rationale_records` (`run_id`);--> statement-breakpoint
CREATE INDEX `idx_rationale_work_item` ON `tedi_rationale_records` (`work_item_id`);--> statement-breakpoint
CREATE INDEX `idx_runtime_submission_attempts_submission` ON `runtime_submission_attempts` (`submission_id`,`attempt_no`);--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_runtime_submission_attempts_no` ON `runtime_submission_attempts` (`submission_id`,`attempt_no`);--> statement-breakpoint
CREATE INDEX `idx_runtime_submissions_org_created` ON `runtime_submissions` (`organization_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_runtime_submissions_subject` ON `runtime_submissions` (`organization_id`,`subject_kind`,`subject_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_runtime_submissions_run` ON `runtime_submissions` (`organization_id`,`run_id`);--> statement-breakpoint
CREATE INDEX `idx_runtime_submissions_status_updated` ON `runtime_submissions` (`organization_id`,`status`,`updated_at`);--> statement-breakpoint
CREATE INDEX `idx_runtime_submissions_idempotency` ON `runtime_submissions` (`organization_id`,`idempotency_key`);--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_runtime_submissions_delivery` ON `runtime_submissions` (`organization_id`,`source_provider`,`source_delivery_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_growth_snapshot_tedi_date` ON `tedi_growth_snapshots` (`tedi_id`,`snapshot_date`);--> statement-breakpoint
CREATE INDEX `idx_growth_snapshot_org` ON `tedi_growth_snapshots` (`org_id`);--> statement-breakpoint
CREATE INDEX `idx_objectives_org` ON `tedi_objectives` (`org_id`);--> statement-breakpoint
CREATE INDEX `idx_objectives_purpose_charter` ON `tedi_objectives` (`purpose_charter_id`);--> statement-breakpoint
CREATE INDEX `idx_objectives_tedi` ON `tedi_objectives` (`tedi_id`);--> statement-breakpoint
CREATE INDEX `idx_objectives_tedi_status` ON `tedi_objectives` (`tedi_id`,`status`);--> statement-breakpoint
CREATE INDEX `idx_objectives_tedi_type` ON `tedi_objectives` (`tedi_id`,`type`);--> statement-breakpoint
CREATE INDEX `idx_tasks_tedi` ON `tedi_tasks` (`tedi_id`);--> statement-breakpoint
CREATE INDEX `idx_tasks_objective` ON `tedi_tasks` (`objective_id`);--> statement-breakpoint
CREATE INDEX `idx_tasks_tedi_status` ON `tedi_tasks` (`tedi_id`,`status`);--> statement-breakpoint
CREATE INDEX `tenant_bundles_slug_active_idx` ON `tenant_bundles` (`slug`,`is_active`);--> statement-breakpoint
CREATE INDEX `idx_widget_test_runs_app` ON `widget_test_runs` (`app_id`);--> statement-breakpoint
CREATE INDEX `idx_widget_test_runs_app_slug` ON `widget_test_runs` (`app_slug`);--> statement-breakpoint
CREATE INDEX `idx_widget_test_runs_org` ON `widget_test_runs` (`organization_id`);--> statement-breakpoint
CREATE INDEX `idx_widget_test_runs_created` ON `widget_test_runs` (`created_at`);--> statement-breakpoint
CREATE INDEX `idx_widget_test_runs_tool` ON `widget_test_runs` (`tool_name`);--> statement-breakpoint
CREATE INDEX `workflow_run_ledger_type_started_idx` ON `workflow_run_ledger` (`workflow_type`,`started_at`);--> statement-breakpoint
CREATE INDEX `workflow_run_ledger_status_started_idx` ON `workflow_run_ledger` (`status`,`started_at`);--> statement-breakpoint
CREATE INDEX `workflow_run_ledger_workflow_id_idx` ON `workflow_run_ledger` (`workflow_id`);