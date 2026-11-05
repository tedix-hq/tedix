CREATE TABLE "billing_accounts" (
	"organization_id" text PRIMARY KEY,
	"plan_version_id" text NOT NULL,
	"status" text DEFAULT 'trial' NOT NULL,
	"billing_mode" text DEFAULT 'trial' NOT NULL,
	"stripe_environment" text,
	"stripe_customer_id" text,
	"stripe_subscription_id" text,
	"stripe_cancel_at_period_end" boolean,
	"period_start" text NOT NULL,
	"period_end" text NOT NULL,
	"overage_enabled" boolean DEFAULT false NOT NULL,
	"hard_spend_limit_micros" bigint,
	"credit_balance_micros" bigint DEFAULT 0 NOT NULL,
	"grace_ends_at" text,
	"entitlement_version" integer DEFAULT 1 NOT NULL,
	"metadata" jsonb DEFAULT '{}' NOT NULL,
	"created_at" text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"updated_at" text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE "billing_credit_entries" (
	"id" text PRIMARY KEY,
	"organization_id" text NOT NULL,
	"kind" text NOT NULL,
	"amount_micros" bigint NOT NULL,
	"source_type" text NOT NULL,
	"source_ref" text,
	"usage_charge_id" text,
	"idempotency_key" text NOT NULL,
	"expires_at" text,
	"description" text,
	"metadata" jsonb DEFAULT '{}' NOT NULL,
	"created_at" text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE "billing_plan_versions" (
	"id" text PRIMARY KEY,
	"plan_key" text NOT NULL,
	"version" integer NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"name" text NOT NULL,
	"currency" text DEFAULT 'usd' NOT NULL,
	"monthly_price_micros" bigint DEFAULT 0 NOT NULL,
	"annual_price_micros" bigint DEFAULT 0 NOT NULL,
	"included_monthly_tokens" bigint NOT NULL,
	"included_monthly_credit_micros" bigint DEFAULT 0 NOT NULL,
	"overage_unit_tokens" integer DEFAULT 1000 NOT NULL,
	"overage_unit_price_micros" bigint DEFAULT 0 NOT NULL,
	"max_tedis" integer NOT NULL,
	"max_cron_jobs_per_tedi" integer NOT NULL,
	"max_iterations_per_task" integer NOT NULL,
	"default_daily_token_limit" integer NOT NULL,
	"default_daily_message_limit" integer NOT NULL,
	"allow_overage" boolean DEFAULT false NOT NULL,
	"metadata" jsonb DEFAULT '{}' NOT NULL,
	"effective_at" text NOT NULL,
	"created_at" text DEFAULT CURRENT_TIMESTAMP NOT NULL
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
	"estimated_input_tokens" integer DEFAULT 0 NOT NULL,
	"estimated_output_tokens" integer DEFAULT 0 NOT NULL,
	"estimated_charge_micros" bigint DEFAULT 0 NOT NULL,
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
	"created_at" text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"updated_at" text DEFAULT CURRENT_TIMESTAMP NOT NULL
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
	"created_at" text DEFAULT CURRENT_TIMESTAMP,
	"updated_at" text DEFAULT CURRENT_TIMESTAMP
);
--> statement-breakpoint
CREATE TABLE "organizations" (
	"id" text PRIMARY KEY,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"type" text DEFAULT 'organization' NOT NULL,
	"descope_tenant_id" text,
	"logo_url" text,
	"description" text,
	"apps_count" integer DEFAULT 0,
	"features" jsonb,
	"metadata" jsonb,
	"created_at" text DEFAULT CURRENT_TIMESTAMP,
	"updated_at" text DEFAULT CURRENT_TIMESTAMP
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
	"created_at" text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"updated_at" text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	CONSTRAINT "chk_principal_identity_provider" CHECK (length("provider") > 0),
	CONSTRAINT "chk_principal_identity_issuer" CHECK (length("issuer") > 0),
	CONSTRAINT "chk_principal_identity_subject" CHECK (length("subject") > 0),
	CONSTRAINT "chk_principal_identity_org_principal" CHECK ("principal_type" <> 'organization' OR "organization_id" = "principal_id")
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
	"attempt_number" integer NOT NULL,
	"started_at" text NOT NULL,
	"heartbeat_at" text NOT NULL,
	"expires_at" text,
	"finished_at" text,
	"summary" text,
	"version" integer DEFAULT 1 NOT NULL,
	"metadata" jsonb DEFAULT '{}' NOT NULL,
	CONSTRAINT "chk_work_attempt_terminal_state" CHECK (("runtime_state" IN ('failed', 'expired', 'finished', 'cancelled') AND "finished_at" IS NOT NULL AND "outcome" IS NOT NULL) OR ("runtime_state" IN ('queued', 'running', 'waiting', 'retrying') AND "finished_at" IS NULL AND "outcome" IS NULL))
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
	"source_session_key" text,
	"source_intent_id" text,
	"due_date" text,
	"deadline" text,
	"start_at" text,
	"duration_days" integer,
	"provenance" jsonb DEFAULT '{}',
	"metadata" jsonb DEFAULT '{}',
	"created_at" text NOT NULL,
	"updated_at" text,
	"accepted_at" text,
	"completed_at" text,
	"cancelled_at" text,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE INDEX "idx_billing_account_status" ON "billing_accounts" ("status","period_end");--> statement-breakpoint
CREATE INDEX "idx_billing_account_plan" ON "billing_accounts" ("plan_version_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_billing_credit_idempotency" ON "billing_credit_entries" ("idempotency_key");--> statement-breakpoint
CREATE INDEX "idx_billing_credit_org_created" ON "billing_credit_entries" ("organization_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_billing_plan_key_version" ON "billing_plan_versions" ("plan_key","version");--> statement-breakpoint
CREATE INDEX "idx_billing_plan_active" ON "billing_plan_versions" ("plan_key","status","effective_at");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_billing_reservation_idempotency" ON "billing_usage_reservations" ("idempotency_key");--> statement-breakpoint
CREATE INDEX "idx_billing_reservation_org_status" ON "billing_usage_reservations" ("organization_id","status","expires_at");--> statement-breakpoint
CREATE INDEX "idx_billing_reservation_status_expiry" ON "billing_usage_reservations" ("status","expires_at");--> statement-breakpoint
CREATE INDEX "idx_billing_reservation_org_created" ON "billing_usage_reservations" ("organization_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_org_member" ON "organization_members" ("organization_id","descope_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_org_member_user" ON "organization_members" ("organization_id","user_id") WHERE "user_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_org_members_org" ON "organization_members" ("organization_id");--> statement-breakpoint
CREATE INDEX "idx_org_members_canonical_user" ON "organization_members" ("user_id");--> statement-breakpoint
CREATE INDEX "idx_org_members_user" ON "organization_members" ("descope_user_id");--> statement-breakpoint
CREATE INDEX "idx_org_members_email" ON "organization_members" ("email");--> statement-breakpoint
CREATE INDEX "idx_org_members_status" ON "organization_members" ("status");--> statement-breakpoint
CREATE INDEX "idx_org_members_role" ON "organization_members" ("role");--> statement-breakpoint
CREATE UNIQUE INDEX "organizations_slug_unique" ON "organizations" ("slug");--> statement-breakpoint
CREATE UNIQUE INDEX "organizations_descope_tenant_id_unique" ON "organizations" ("descope_tenant_id") WHERE "descope_tenant_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_org_slug" ON "organizations" ("slug");--> statement-breakpoint
CREATE INDEX "idx_org_descope" ON "organizations" ("descope_tenant_id");--> statement-breakpoint
CREATE INDEX "organizations_type_idx" ON "organizations" ("type");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_principal_identity_external" ON "principal_identities" ("provider","issuer","subject");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_principal_identity_canonical" ON "principal_identities" ("principal_type","principal_id","provider","issuer","subject");--> statement-breakpoint
CREATE INDEX "idx_principal_identity_principal" ON "principal_identities" ("principal_type","principal_id","status");--> statement-breakpoint
CREATE INDEX "idx_principal_identity_org" ON "principal_identities" ("organization_id","principal_type","status");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_work_attempt_number" ON "work_attempts" ("org_id","work_item_id","attempt_number");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_work_attempt_admission" ON "work_attempts" ("admission_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_work_attempt_active" ON "work_attempts" ("org_id","work_item_id") WHERE "runtime_state" IN ('queued', 'running', 'waiting', 'retrying');--> statement-breakpoint
CREATE INDEX "idx_work_attempt_executor_state" ON "work_attempts" ("org_id","executor_type","executor_id","runtime_state");--> statement-breakpoint
CREATE INDEX "idx_work_attempt_expiry" ON "work_attempts" ("runtime_state","expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_work_items_org_id" ON "work_items" ("org_id","id");--> statement-breakpoint
CREATE INDEX "idx_work_items_org_created" ON "work_items" ("org_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_work_items_org_disposition" ON "work_items" ("org_id","disposition");--> statement-breakpoint
CREATE INDEX "idx_work_items_lane_executor" ON "work_items" ("org_id","disposition",("metadata" ->> 'executor'),"created_at","id");--> statement-breakpoint
CREATE INDEX "idx_work_items_project" ON "work_items" ("project_id");--> statement-breakpoint
CREATE INDEX "idx_work_items_parent" ON "work_items" ("parent_work_item_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_work_items_org_source_intent" ON "work_items" ("org_id","source_intent_id");--> statement-breakpoint
ALTER TABLE "billing_accounts" ADD CONSTRAINT "billing_accounts_organization_id_organizations_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "billing_accounts" ADD CONSTRAINT "billing_accounts_plan_version_id_billing_plan_versions_id_fkey" FOREIGN KEY ("plan_version_id") REFERENCES "billing_plan_versions"("id");--> statement-breakpoint
ALTER TABLE "billing_credit_entries" ADD CONSTRAINT "billing_credit_entries_organization_id_organizations_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "billing_usage_reservations" ADD CONSTRAINT "billing_usage_reservations_BQnlBiOpQATc_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "billing_usage_reservations" ADD CONSTRAINT "billing_usage_reservations_yTsh5NGei6yU_fkey" FOREIGN KEY ("plan_version_id") REFERENCES "billing_plan_versions"("id");--> statement-breakpoint
ALTER TABLE "organization_members" ADD CONSTRAINT "organization_members_organization_id_organizations_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "principal_identities" ADD CONSTRAINT "principal_identities_organization_id_organizations_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "work_attempts" ADD CONSTRAINT "work_attempts_org_id_organizations_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "work_attempts" ADD CONSTRAINT "fk_work_attempt_item_org" FOREIGN KEY ("org_id","work_item_id") REFERENCES "work_items"("org_id","id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "work_items" ADD CONSTRAINT "work_items_org_id_organizations_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE;