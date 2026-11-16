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
	"mcp_tool_count" integer DEFAULT 0,
	"mcp_resource_count" integer DEFAULT 0,
	"mcp_prompt_count" integer DEFAULT 0,
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
	"created_at" text DEFAULT (CURRENT_TIMESTAMP),
	"updated_at" text DEFAULT (CURRENT_TIMESTAMP),
	"vendor_key" text
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
	"latest_config_version" integer DEFAULT 0 NOT NULL,
	"extracted_at" text,
	"ai_search_synced_at" text,
	"created_at" text DEFAULT (CURRENT_TIMESTAMP),
	"updated_at" text DEFAULT (CURRENT_TIMESTAMP),
	CONSTRAINT "uniq_app_org_slug" UNIQUE("organization_id","slug")
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
	"version" integer DEFAULT 1 NOT NULL,
	"supersedes_revision_id" text,
	"rollback_of_revision_id" text,
	"change_summary" text,
	"published_at" text,
	"published_by" text,
	"definition" jsonb NOT NULL,
	"created_at" text DEFAULT (CURRENT_TIMESTAMP),
	"updated_at" text DEFAULT (CURRENT_TIMESTAMP),
	CONSTRAINT "uniq_policy_packs_scope_slug_version" UNIQUE("scope","slug","version")
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
	"version" integer DEFAULT 1 NOT NULL,
	"supersedes_revision_id" text,
	"rollback_of_revision_id" text,
	"change_summary" text,
	"published_at" text,
	"published_by" text,
	"config" jsonb NOT NULL,
	"created_at" text DEFAULT (CURRENT_TIMESTAMP),
	"updated_at" text DEFAULT (CURRENT_TIMESTAMP),
	CONSTRAINT "uniq_runtime_profiles_scope_slug_version" UNIQUE("scope","slug","version")
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
	"priority" integer DEFAULT 0 NOT NULL,
	"linked_domains" jsonb DEFAULT '[]',
	"gate_config" jsonb DEFAULT '{}',
	"budget_config" jsonb DEFAULT '{}',
	"progress" jsonb DEFAULT '{}',
	"created_at" text NOT NULL,
	"updated_at" text,
	"completed_at" text
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
	"slug" text NOT NULL CONSTRAINT "uniq_tedi_slug" UNIQUE,
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
	"created_at" text DEFAULT (CURRENT_TIMESTAMP),
	"updated_at" text DEFAULT (CURRENT_TIMESTAMP),
	CONSTRAINT "uniq_tedi_org_slug" UNIQUE("organization_id","slug")
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
	"version" integer DEFAULT 1 NOT NULL,
	"supersedes_revision_id" text,
	"rollback_of_revision_id" text,
	"change_summary" text,
	"published_at" text,
	"published_by" text,
	"templates" jsonb NOT NULL,
	"created_at" text DEFAULT (CURRENT_TIMESTAMP),
	"updated_at" text DEFAULT (CURRENT_TIMESTAMP),
	CONSTRAINT "uniq_workspace_template_sets_scope_slug_version" UNIQUE("scope","slug","version")
);
--> statement-breakpoint
ALTER TABLE "organizations" ADD CONSTRAINT "organizations_slug_key" UNIQUE("slug");--> statement-breakpoint
ALTER TABLE "organizations" ADD CONSTRAINT "organizations_descope_tenant_id_key" UNIQUE("descope_tenant_id");--> statement-breakpoint
CREATE INDEX "app_catalog_name_idx" ON "app_catalog" ("name");--> statement-breakpoint
CREATE INDEX "app_catalog_public_browse_name_idx" ON "app_catalog" ("name") WHERE "is_discoverable" IS TRUE AND "status" = 'ENABLED' AND "review_status" = 'RELEASED' AND "developer_type" IN ('TRUSTED_PARTNER', 'OAI', 'THIRD_PARTY');--> statement-breakpoint
CREATE INDEX "app_catalog_explore_name_idx" ON "app_catalog" ("name") WHERE "is_discoverable" IS TRUE AND "status" = 'ENABLED' AND "review_status" = 'RELEASED' AND "developer_type" IN ('TRUSTED_PARTNER', 'OAI', 'THIRD_PARTY') AND "explore_shadowed" IS FALSE;--> statement-breakpoint
CREATE INDEX "app_catalog_vendor_key_idx" ON "app_catalog" ("vendor_key");--> statement-breakpoint
CREATE INDEX "app_catalog_slug_idx" ON "app_catalog" ("slug");--> statement-breakpoint
CREATE INDEX "app_catalog_connector_type_idx" ON "app_catalog" ("connector_type");--> statement-breakpoint
CREATE INDEX "app_catalog_category_idx" ON "app_catalog" ("category");--> statement-breakpoint
CREATE INDEX "app_catalog_distribution_channel_idx" ON "app_catalog" ("distribution_channel");--> statement-breakpoint
CREATE INDEX "app_catalog_status_idx" ON "app_catalog" ("status");--> statement-breakpoint
CREATE INDEX "app_catalog_is_discoverable_idx" ON "app_catalog" ("is_discoverable");--> statement-breakpoint
CREATE INDEX "app_catalog_developer_type_idx" ON "app_catalog" ("developer_type");--> statement-breakpoint
CREATE INDEX "app_catalog_health_status_idx" ON "app_catalog" ("health_status");--> statement-breakpoint
CREATE INDEX "app_catalog_tool_source_idx" ON "app_catalog" ("tool_source");--> statement-breakpoint
CREATE UNIQUE INDEX "app_catalog_mcp_endpoint_hash_unique" ON "app_catalog" ("mcp_endpoint_hash");--> statement-breakpoint
CREATE INDEX "idx_app_org" ON "apps" ("organization_id");--> statement-breakpoint
CREATE INDEX "idx_app_slug" ON "apps" ("slug");--> statement-breakpoint
CREATE INDEX "idx_app_domain" ON "apps" ("custom_mcp_domain");--> statement-breakpoint
CREATE INDEX "idx_app_primary_domain" ON "apps" ("primary_domain");--> statement-breakpoint
CREATE INDEX "idx_app_discovery" ON "apps" ("discovery_status");--> statement-breakpoint
CREATE INDEX "idx_app_visibility" ON "apps" ("visibility");--> statement-breakpoint
CREATE INDEX "idx_app_active_config_version" ON "apps" ("active_config_version_id");--> statement-breakpoint
CREATE INDEX "idx_app_source" ON "apps" ("source_app_id");--> statement-breakpoint
CREATE INDEX "idx_app_catalog" ON "apps" ("catalog_app_id");--> statement-breakpoint
CREATE INDEX "idx_policy_packs_org" ON "policy_packs" ("organization_id");--> statement-breakpoint
CREATE INDEX "idx_policy_packs_status" ON "policy_packs" ("status");--> statement-breakpoint
CREATE INDEX "idx_policy_packs_target" ON "policy_packs" ("target");--> statement-breakpoint
CREATE INDEX "idx_policy_packs_family" ON "policy_packs" ("scope","slug","version");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_projects_org_id" ON "projects" ("org_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_projects_org_key" ON "projects" ("org_id","key");--> statement-breakpoint
CREATE INDEX "idx_projects_org_status" ON "projects" ("org_id","status");--> statement-breakpoint
CREATE INDEX "idx_projects_status_id" ON "projects" ("status","id");--> statement-breakpoint
CREATE INDEX "idx_projects_org_status_id" ON "projects" ("org_id","status","id");--> statement-breakpoint
CREATE INDEX "idx_projects_org_objective_status" ON "projects" ("org_id","objective_id","status");--> statement-breakpoint
CREATE INDEX "idx_runtime_profiles_org" ON "runtime_profiles" ("organization_id");--> statement-breakpoint
CREATE INDEX "idx_runtime_profiles_status" ON "runtime_profiles" ("status");--> statement-breakpoint
CREATE INDEX "idx_runtime_profiles_family" ON "runtime_profiles" ("scope","slug","version");--> statement-breakpoint
CREATE INDEX "idx_objectives_org" ON "tedi_objectives" ("org_id");--> statement-breakpoint
CREATE INDEX "idx_objectives_status_id" ON "tedi_objectives" ("status","id");--> statement-breakpoint
CREATE INDEX "idx_objectives_org_status_id" ON "tedi_objectives" ("org_id","status","id");--> statement-breakpoint
CREATE INDEX "idx_objectives_purpose_charter" ON "tedi_objectives" ("purpose_charter_id");--> statement-breakpoint
CREATE INDEX "idx_objectives_tedi_status" ON "tedi_objectives" ("tedi_id","status");--> statement-breakpoint
CREATE INDEX "idx_objectives_tedi_type" ON "tedi_objectives" ("tedi_id","type");--> statement-breakpoint
CREATE INDEX "idx_tedis_org" ON "tedis" ("organization_id");--> statement-breakpoint
CREATE INDEX "idx_tedis_slug" ON "tedis" ("slug");--> statement-breakpoint
CREATE INDEX "tedis_descope_user_id_idx" ON "tedis" ("descope_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "tedis_body_generation_token_hash_idx" ON "tedis" ("body_generation_token_hash");--> statement-breakpoint
CREATE INDEX "idx_workspace_template_sets_org" ON "workspace_template_sets" ("organization_id");--> statement-breakpoint
CREATE INDEX "idx_workspace_template_sets_status" ON "workspace_template_sets" ("status");--> statement-breakpoint
CREATE INDEX "idx_workspace_template_sets_family" ON "workspace_template_sets" ("scope","slug","version");--> statement-breakpoint
ALTER TABLE "apps" ADD CONSTRAINT "apps_organization_id_organizations_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "apps" ADD CONSTRAINT "apps_source_app_id_apps_id_fkey" FOREIGN KEY ("source_app_id") REFERENCES "apps"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "apps" ADD CONSTRAINT "apps_catalog_app_id_app_catalog_id_fkey" FOREIGN KEY ("catalog_app_id") REFERENCES "app_catalog"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "policy_packs" ADD CONSTRAINT "policy_packs_organization_id_organizations_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "policy_packs" ADD CONSTRAINT "policy_packs_supersedes_revision_id_policy_packs_id_fkey" FOREIGN KEY ("supersedes_revision_id") REFERENCES "policy_packs"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "policy_packs" ADD CONSTRAINT "policy_packs_rollback_of_revision_id_policy_packs_id_fkey" FOREIGN KEY ("rollback_of_revision_id") REFERENCES "policy_packs"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_org_id_organizations_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_lead_tedi_id_tedis_id_fkey" FOREIGN KEY ("lead_tedi_id") REFERENCES "tedis"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_objective_id_tedi_objectives_id_fkey" FOREIGN KEY ("objective_id") REFERENCES "tedi_objectives"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "runtime_profiles" ADD CONSTRAINT "runtime_profiles_organization_id_organizations_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "runtime_profiles" ADD CONSTRAINT "runtime_profiles_Yqyh5LQg0OeH_fkey" FOREIGN KEY ("supersedes_revision_id") REFERENCES "runtime_profiles"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "runtime_profiles" ADD CONSTRAINT "runtime_profiles_I7Nqetf8US2a_fkey" FOREIGN KEY ("rollback_of_revision_id") REFERENCES "runtime_profiles"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "tedi_objectives" ADD CONSTRAINT "tedi_objectives_tedi_id_tedis_id_fkey" FOREIGN KEY ("tedi_id") REFERENCES "tedis"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "tedi_objectives" ADD CONSTRAINT "tedi_objectives_org_id_organizations_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "tedis" ADD CONSTRAINT "tedis_organization_id_organizations_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "tedis" ADD CONSTRAINT "tedis_runtime_profile_id_runtime_profiles_id_fkey" FOREIGN KEY ("runtime_profile_id") REFERENCES "runtime_profiles"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "tedis" ADD CONSTRAINT "tedis_policy_pack_id_policy_packs_id_fkey" FOREIGN KEY ("policy_pack_id") REFERENCES "policy_packs"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "tedis" ADD CONSTRAINT "tedis_workspace_template_set_id_workspace_template_sets_id_fkey" FOREIGN KEY ("workspace_template_set_id") REFERENCES "workspace_template_sets"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "workspace_template_sets" ADD CONSTRAINT "workspace_template_sets_organization_id_organizations_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "workspace_template_sets" ADD CONSTRAINT "workspace_template_sets_LSgkGMprCATH_fkey" FOREIGN KEY ("supersedes_revision_id") REFERENCES "workspace_template_sets"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "workspace_template_sets" ADD CONSTRAINT "workspace_template_sets_outPKPpWzx7u_fkey" FOREIGN KEY ("rollback_of_revision_id") REFERENCES "workspace_template_sets"("id") ON DELETE RESTRICT;