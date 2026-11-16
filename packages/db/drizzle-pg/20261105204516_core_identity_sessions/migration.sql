CREATE TABLE "users" (
	"id" text PRIMARY KEY,
	"email" text NOT NULL CONSTRAINT "uniq_users_email" UNIQUE,
	"name" text,
	"avatar_url" text,
	"profile_revision" integer DEFAULT 1 NOT NULL,
	"metadata" jsonb,
	"last_login_at" text,
	"created_at" text DEFAULT CURRENT_TIMESTAMP,
	"updated_at" text DEFAULT CURRENT_TIMESTAMP
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
	"expires_at" integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX "idx_users_email" ON "users" ("email");--> statement-breakpoint
CREATE INDEX "idx_users_last_login" ON "users" ("last_login_at");--> statement-breakpoint
CREATE INDEX "idx_oidc_sessions_expiry" ON "oidc_sessions" ("expires_at");--> statement-breakpoint
ALTER TABLE "oidc_sessions" ADD CONSTRAINT "oidc_sessions_organization_id_organizations_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE;