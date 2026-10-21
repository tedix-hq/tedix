-- Logs database schema, rendered by scripts/logs-db-schema.ts.
-- Same tables as the main database, without foreign keys.
CREATE TABLE "audit_events" (
	"id" text PRIMARY KEY,
	"organization_id" text NOT NULL,
	"actor_id" text NOT NULL,
	"actor_type" text NOT NULL,
	"action" text NOT NULL,
	"resource_type" text NOT NULL,
	"resource_id" text,
	"metadata" text,
	"ip_address" text,
	"user_agent" text,
	"timestamp" integer NOT NULL
);
CREATE INDEX "idx_audit_events_org_timestamp" ON "audit_events" ("organization_id", "timestamp");
CREATE INDEX "idx_audit_events_timestamp" ON "audit_events" ("timestamp");
CREATE INDEX "idx_audit_events_resource" ON "audit_events" ("organization_id", "resource_type", "resource_id", "timestamp");
CREATE TABLE "tedi_runtime_events" (
	"id" text PRIMARY KEY,
	"organization_id" text NOT NULL,
	"tedi_id" text NOT NULL,
	"kind" text NOT NULL,
	"conversation_id" text,
	"run_id" text,
	"message_id" text,
	"tool_call_id" text,
	"approval_request_id" text,
	"artifact_id" text,
	"sequence" integer,
	"delta" text,
	"payload" text,
	"runtime_backend" text NOT NULL,
	"runtime_external_id" text,
	"runtime_external_url" text,
	"runtime_metadata" text,
	"trace_id" text,
	"created_at" text NOT NULL
);
CREATE INDEX "idx_tedi_runtime_events_org" ON "tedi_runtime_events" ("organization_id");
CREATE INDEX "idx_tedi_runtime_events_created" ON "tedi_runtime_events" ("created_at");
CREATE INDEX "idx_tedi_runtime_events_tedi_created" ON "tedi_runtime_events" ("tedi_id", "created_at");
CREATE INDEX "idx_tedi_runtime_events_conversation_created" ON "tedi_runtime_events" ("tedi_id", "conversation_id", "created_at");
CREATE INDEX "idx_tedi_runtime_events_run_created" ON "tedi_runtime_events" ("tedi_id", "run_id", "created_at");
CREATE INDEX "idx_tedi_runtime_events_run_kind_created" ON "tedi_runtime_events" ("tedi_id", "run_id", "kind", "created_at");
CREATE INDEX "idx_tedi_runtime_events_kind_created" ON "tedi_runtime_events" ("tedi_id", "kind", "created_at");
CREATE INDEX "idx_tedi_runtime_events_artifact" ON "tedi_runtime_events" ("artifact_id");
CREATE INDEX "idx_tedi_runtime_events_trace" ON "tedi_runtime_events" ("trace_id", "created_at");
CREATE TABLE "kernel_runtime_events" (
	"id" text PRIMARY KEY,
	"organization_id" text NOT NULL,
	"kind" text NOT NULL,
	"conversation_id" text NOT NULL,
	"run_id" text,
	"message_id" text,
	"cause_event_id" text,
	"delegated_tedi_id" text,
	"child_run_id" text,
	"sequence" integer,
	"delta" text,
	"payload" text,
	"runtime_backend" text NOT NULL DEFAULT 'custom',
	"runtime_external_id" text,
	"runtime_external_url" text,
	"runtime_metadata" text,
	"trace_id" text,
	"created_at" text NOT NULL
);
CREATE INDEX "idx_kernel_runtime_events_created" ON "kernel_runtime_events" ("created_at");
CREATE INDEX "idx_kernel_runtime_events_org_created" ON "kernel_runtime_events" ("organization_id", "created_at");
CREATE INDEX "idx_kernel_runtime_events_conversation_created" ON "kernel_runtime_events" ("organization_id", "conversation_id", "created_at");
CREATE INDEX "idx_kernel_runtime_events_run_created" ON "kernel_runtime_events" ("organization_id", "run_id", "created_at", "id");
CREATE INDEX "idx_kernel_runtime_events_child_created" ON "kernel_runtime_events" ("organization_id", "child_run_id", "created_at", "id");
CREATE INDEX "idx_kernel_runtime_events_delegated_tedi" ON "kernel_runtime_events" ("delegated_tedi_id");
CREATE INDEX "idx_kernel_runtime_events_trace" ON "kernel_runtime_events" ("organization_id", "trace_id", "created_at");
CREATE TABLE "skill_run_artifacts" (
	"id" text PRIMARY KEY,
	"run_id" text NOT NULL,
	"path" text NOT NULL,
	"mime_type" text NOT NULL DEFAULT 'application/json',
	"size_bytes" integer NOT NULL DEFAULT 0,
	"content_inline" text,
	"content_r2_key" text,
	"sha256" text,
	"attempt" integer NOT NULL DEFAULT 1,
	"outcome" text NOT NULL DEFAULT 'success',
	"created_at" text
);
CREATE UNIQUE INDEX "uniq_skill_run_artifacts_path" ON "skill_run_artifacts" ("run_id", "path");
