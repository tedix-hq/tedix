-- Logs database schema, rendered by scripts/logs-db-schema.ts.
-- Log tables without foreign keys, plus logs-local metadata.
CREATE TABLE "external_agent_attributions" (
	"id" text PRIMARY KEY,
	"organization_id" text NOT NULL,
	"principal_id" text NOT NULL,
	"session_id" text NOT NULL,
	"target_type" text NOT NULL,
	"target_id" text NOT NULL,
	"role" text NOT NULL,
	"work_item_id" text,
	"metadata" text NOT NULL DEFAULT '{}',
	"occurred_at" text NOT NULL
);
CREATE UNIQUE INDEX "uniq_external_agent_attribution" ON "external_agent_attributions" ("organization_id", "target_type", "target_id", "role", "principal_id");
CREATE UNIQUE INDEX "uniq_external_agent_attribution_org_id" ON "external_agent_attributions" ("organization_id", "id");
CREATE INDEX "idx_external_agent_attribution_session" ON "external_agent_attributions" ("organization_id", "session_id", "occurred_at");
CREATE INDEX "idx_external_agent_attribution_work_item" ON "external_agent_attributions" ("organization_id", "work_item_id");
