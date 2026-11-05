CREATE TABLE "work_admissions" (
	"id" text PRIMARY KEY,
	"org_id" text NOT NULL,
	"work_item_id" text NOT NULL,
	"work_item_version" integer NOT NULL,
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
	"created_at" text NOT NULL,
	CONSTRAINT "chk_work_admission_identity" CHECK (("executor_type" = 'tedi' AND "executor_session_id" IS NULL AND "external_session_key" IS NULL) OR ("executor_type" = 'external_agent' AND "executor_session_id" IS NOT NULL AND "external_session_key" IS NOT NULL)),
	CONSTRAINT "chk_work_admission_decision" CHECK (("decision" = 'admitted' AND "rejection_code" IS NULL AND "rejection_reason" IS NULL AND "rejection_key" IS NULL) OR ("decision" = 'rejected' AND "rejection_code" IS NOT NULL AND "rejection_reason" IS NOT NULL AND "rejection_key" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "work_attempts" ALTER COLUMN "admission_id" SET NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_billing_account_stripe_customer" ON "billing_accounts" ("stripe_environment","stripe_customer_id") WHERE "stripe_customer_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_billing_account_stripe_subscription" ON "billing_accounts" ("stripe_environment","stripe_subscription_id") WHERE "stripe_subscription_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_billing_credit_expiry" ON "billing_credit_entries" ("organization_id","expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_work_admission_org_item_id" ON "work_admissions" ("org_id","work_item_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_work_admission_rejection_key" ON "work_admissions" ("org_id","rejection_key");--> statement-breakpoint
CREATE INDEX "idx_work_admission_executor_time" ON "work_admissions" ("org_id","executor_type","executor_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_work_admission_item_time" ON "work_admissions" ("org_id","work_item_id","created_at");--> statement-breakpoint
ALTER TABLE "work_admissions" ADD CONSTRAINT "work_admissions_org_id_organizations_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "work_admissions" ADD CONSTRAINT "fk_work_admission_item" FOREIGN KEY ("org_id","work_item_id") REFERENCES "work_items"("org_id","id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "work_attempts" ADD CONSTRAINT "fk_work_attempt_admission" FOREIGN KEY ("org_id","work_item_id","admission_id") REFERENCES "work_admissions"("org_id","work_item_id","id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "billing_credit_entries" ADD CONSTRAINT "chk_billing_credit_nonzero" CHECK ("amount_micros" <> 0);--> statement-breakpoint
ALTER TABLE "billing_credit_entries" ADD CONSTRAINT "chk_billing_credit_direction" CHECK (("kind" IN ('grant', 'refund') AND "amount_micros" > 0) OR ("kind" = 'debit' AND "amount_micros" < 0) OR "kind" = 'adjustment');--> statement-breakpoint
ALTER TABLE "work_attempts" ADD CONSTRAINT "chk_work_attempt_identity" CHECK (("executor_type" = 'tedi' AND "executor_session_id" IS NULL AND "external_session_key" IS NULL) OR ("executor_type" = 'external_agent' AND "executor_session_id" IS NOT NULL AND "external_session_key" IS NOT NULL));