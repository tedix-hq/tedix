CREATE SCHEMA "catalog";
--> statement-breakpoint
ALTER TABLE "app_catalog" SET SCHEMA "catalog";
--> statement-breakpoint
ALTER TABLE "app_catalog_browse_totals" SET SCHEMA "catalog";
--> statement-breakpoint
ALTER TABLE "app_catalog_category_totals" SET SCHEMA "catalog";
--> statement-breakpoint
ALTER TABLE "app_catalog_changes" SET SCHEMA "catalog";
--> statement-breakpoint
ALTER TABLE "app_catalog_health_history" SET SCHEMA "catalog";
--> statement-breakpoint
ALTER TABLE "app_catalog_mcp_prompts" SET SCHEMA "catalog";
--> statement-breakpoint
ALTER TABLE "app_catalog_mcp_resource_templates" SET SCHEMA "catalog";
--> statement-breakpoint
ALTER TABLE "app_catalog_mcp_resources" SET SCHEMA "catalog";
--> statement-breakpoint
ALTER TABLE "app_catalog_mcp_skills" SET SCHEMA "catalog";
--> statement-breakpoint
ALTER TABLE "app_catalog_mcp_tools" SET SCHEMA "catalog";
--> statement-breakpoint
ALTER TABLE "app_catalog_store_listings" SET SCHEMA "catalog";
--> statement-breakpoint
ALTER TABLE "app_catalog_sync_logs" SET SCHEMA "catalog";
--> statement-breakpoint
ALTER TABLE "app_catalog_tool_tests" SET SCHEMA "catalog";
--> statement-breakpoint
ALTER TABLE "upstream_drift_reports" SET SCHEMA "catalog";
--> statement-breakpoint
CREATE INDEX "kernel_requests_global_due_idx" ON "kernel_requests" ("next_due_at","organization_id");