ALTER TABLE "mcp_consent_grants" ADD COLUMN "client_name" text;--> statement-breakpoint
ALTER TABLE "mcp_consent_grants" ADD COLUMN "device" text;--> statement-breakpoint
ALTER TABLE "mcp_consent_grants" ADD COLUMN "last_used_at" text;--> statement-breakpoint
ALTER TABLE "mcp_consent_pending" ADD COLUMN "client_name" text;--> statement-breakpoint
ALTER TABLE "mcp_consent_pending" ADD COLUMN "device" text;--> statement-breakpoint
ALTER TABLE "mcp_consent_selections" ADD COLUMN "client_name" text;--> statement-breakpoint
ALTER TABLE "mcp_consent_selections" ADD COLUMN "device" text;--> statement-breakpoint
CREATE INDEX "idx_app_mcp_audience" ON "apps" (COALESCE(NULLIF("metadata" #>> '{mcpConfig,expectedAudience}', ''), 'https://' || COALESCE("custom_mcp_domain", "slug" || '.mcp.tedix.dev') || '/mcp'));--> statement-breakpoint
CREATE INDEX "idx_app_mcp_descope_resource" ON "apps" (("metadata" #>> '{mcpConfig,descopeResourceId}'));