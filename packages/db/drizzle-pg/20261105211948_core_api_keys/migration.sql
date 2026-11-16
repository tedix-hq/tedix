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
	"requests_this_month" integer DEFAULT 0,
	"total_requests" integer DEFAULT 0,
	"ip_allowlist" jsonb,
	"expires_at" text,
	"rate_limit" integer,
	"status" text DEFAULT 'active',
	"rotated_at" text,
	"rotation_schedule_days" integer,
	"previous_key_hash" text,
	"previous_key_expires_at" text,
	"revoked_at" text,
	"revoked_by" text,
	"revoke_reason" text,
	"metadata" jsonb,
	"created_by" text,
	"created_at" text DEFAULT CURRENT_TIMESTAMP,
	"updated_at" text DEFAULT CURRENT_TIMESTAMP
);
--> statement-breakpoint
CREATE INDEX "idx_api_key_org" ON "api_keys" ("organization_id");--> statement-breakpoint
CREATE INDEX "idx_api_key_status" ON "api_keys" ("status");--> statement-breakpoint
CREATE INDEX "idx_api_key_env" ON "api_keys" ("environment");--> statement-breakpoint
CREATE INDEX "idx_api_key_hash" ON "api_keys" ("key_hash");--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_organization_id_organizations_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE;