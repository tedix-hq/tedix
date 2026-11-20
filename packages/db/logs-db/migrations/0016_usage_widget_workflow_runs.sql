-- Usage events, widget events and workflow runs, moved by d1-retention.
CREATE TABLE "tedi_usage_events" (
	"id" text PRIMARY KEY,
	"tedi_id" text NOT NULL,
	"event_type" text NOT NULL,
	"started_at" text NOT NULL,
	"ended_at" text,
	"duration_ms" integer,
	"units" real,
	"metadata" text,
	"created_at" text
);
CREATE INDEX "idx_tedi_usage_events_window" ON "tedi_usage_events" ("tedi_id", "started_at");
CREATE INDEX "idx_tedi_usage_events_created" ON "tedi_usage_events" ("created_at");
CREATE TABLE "widget_events" (
	"id" text PRIMARY KEY,
	"organization_id" text NOT NULL,
	"app_id" text NOT NULL,
	"session_id" text NOT NULL,
	"event_type" text NOT NULL,
	"item_id" text,
	"item_position" integer,
	"widget_key" text,
	"display_mode" text,
	"metadata" text,
	"created_at" text
);
CREATE INDEX "idx_widget_events_org" ON "widget_events" ("organization_id");
CREATE INDEX "idx_widget_events_app" ON "widget_events" ("app_id");
CREATE INDEX "idx_widget_events_session" ON "widget_events" ("session_id");
CREATE INDEX "idx_widget_events_type" ON "widget_events" ("event_type");
CREATE INDEX "idx_widget_events_widget" ON "widget_events" ("widget_key");
CREATE INDEX "idx_widget_events_created" ON "widget_events" ("created_at");
CREATE INDEX "idx_widget_events_item" ON "widget_events" ("item_id");
CREATE TABLE "workflow_run_ledger" (
	"id" text PRIMARY KEY,
	"workflow_type" text NOT NULL,
	"workflow_id" text NOT NULL,
	"trigger" text NOT NULL,
	"target" text,
	"status" text NOT NULL,
	"started_at" text NOT NULL,
	"completed_at" text,
	"total_count" integer DEFAULT 0,
	"success_count" integer DEFAULT 0,
	"error_count" integer DEFAULT 0,
	"output" text,
	"error" text
);
CREATE INDEX "workflow_run_ledger_type_started_idx" ON "workflow_run_ledger" ("workflow_type", "started_at");
CREATE INDEX "workflow_run_ledger_status_started_idx" ON "workflow_run_ledger" ("status", "started_at");
CREATE INDEX "workflow_run_ledger_workflow_id_idx" ON "workflow_run_ledger" ("workflow_id");
CREATE INDEX "workflow_run_ledger_started_idx" ON "workflow_run_ledger" ("started_at");
